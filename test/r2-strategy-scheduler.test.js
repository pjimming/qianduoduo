'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStrategyScheduler } = require('../server/jobs/r2-strategy-scheduler');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createStrategyRunner } = require('../server/jobs/r2-strategy-runner');
const { refreshHoldingMonitor } = require('../server/jobs/r2-holding-monitor');
const { artifactPath, readArtifact, readHoldingSupplements, writeArtifact } = require('../server/jobs/r2-holding-monitor-artifact');
const { fingerprint } = require('../server/modules/r2-strategy/contract');
const { monitorContent } = require('../server/modules/r2-strategy/holding-evidence');

function strategyWith(results, mode = 'v9') {
  let index = 0;
  return {
    status: () => ({ mode, activation_seq: 1 }),
    recompute: () => results[Math.min(index++, results.length - 1)],
  };
}

test('scheduler projects only a fresh derivation result, not an unchanged fingerprint', () => {
  const projected = [];
  const strategy = strategyWith([
    { persisted: true, job_id: 7, result: { input: { activation_seq: 1 } } },
    { persisted: true, existing: true, job_id: 7, result: { input: { activation_seq: 1 } } },
  ]);
  const scheduler = createStrategyScheduler({ strategy, onDerived: (event) => projected.push(event) });

  const first = scheduler.run('startup');
  assert.equal(first.ok, true);
  assert.equal(first.job_id, 7);
  assert.equal(projected.length, 1);

  const second = scheduler.run('periodic');
  assert.equal(second.ok, true);
  assert.equal(projected.length, 1);
});

test('scheduler does not project in legacy and keeps a projection failure out of the tick result', () => {
  let derived = 0;
  const legacy = createStrategyScheduler({
    strategy: strategyWith([{ persisted: false }], 'legacy'),
    onDerived: () => { derived += 1; },
  });
  assert.equal(legacy.run('periodic').reason, 'mode_not_active');
  assert.equal(derived, 0);

  const failing = createStrategyScheduler({
    strategy: strategyWith([{ persisted: true, result: { input: { activation_seq: 1 } } }]),
    onDerived: () => { throw new Error('projection unavailable'); },
    logger: { warn: () => {} },
  });
  const result = failing.run('startup');
  assert.equal(result.ok, true);
  assert.equal(result.persisted, true);
});

test('scheduler retries a failed projection even when the financial input has not changed', () => {
  let projections = 0;
  const scheduler = createStrategyScheduler({
    strategy: strategyWith([
      { persisted: true, job_id: 1, result: {} },
      { persisted: true, existing: true, job_id: 1, result: {} },
    ]), logger: { warn() {} },
    onDerived: () => { if (++projections === 1) throw new Error('write locked'); },
  });
  assert.equal(scheduler.run().projection_pending, true);
  assert.equal(scheduler.getStatus().projection_pending, true);
  assert.equal(scheduler.run().ok, true);
  assert.equal(projections, 2);
  assert.equal(scheduler.getStatus().projection_pending, false);
  scheduler.run();
  assert.equal(projections, 2);
});

test('async strategy work stays off the main thread contract and cannot project after stop', async () => {
  let resolve, stopped = 0, projected = 0, calls = 0;
  const scheduler = createStrategyScheduler({ strategy: strategyWith([]),
    runner: { run: () => { calls++; return new Promise(done => { resolve = done; }); }, stop: async () => { stopped++; } },
    onDerived: () => { projected++; },
  });
  const run = scheduler.run('startup');
  assert.equal(scheduler.getStatus().running, true);
  assert.equal(scheduler.run().reason, 'already_running');
  assert.equal(calls, 1);
  await scheduler.stop();
  resolve({ persisted: true, result: {} });
  assert.equal((await run).reason, 'stopped');
  assert.equal(projected, 0);
  assert.equal(stopped, 1);
  assert.equal(scheduler.run().reason, 'stopped');
});

test('strategy runner holds its worker until exit and reports a clean exit without a message', async () => {
  let handle, data;
  const runner = createStrategyRunner({ dbPath: 'test.sqlite', workerFactory: (_file, options) => {
    data = options.workerData; handle = new EventEmitter(); return handle;
  } });
  const pending = runner.run({ mode: 'v9', activation_seq: 8 });
  handle.emit('message', { ok: true, result: { job_id: 4 } });
  assert.equal(runner.isRunning(), true);
  assert.equal(data.expectedSeq, 8);
  assert.equal(data.refreshHoldings, true);
  handle.emit('exit', 0);
  assert.equal((await pending).job_id, 4);
  assert.equal(runner.isRunning(), false);
  const empty = runner.run({ mode: 'v9', activation_seq: 8 });
  handle.emit('exit', 0);
  await assert.rejects(empty, /未返回结果/);
});

test('strategy runner terminates timed-out workers and supports graceful collector cancellation', async () => {
  let handle, terminated = 0;
  const runner = createStrategyRunner({ dbPath: 'test.sqlite', timeoutMs: 5, workerFactory: () => {
    handle = new EventEmitter();
    handle.terminate = async () => { terminated++; handle.emit('exit', 1); };
    return handle;
  } });
  // Keep a ref while the production timeout intentionally uses unref.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(runner.run({ mode: 'v9', activation_seq: 1 }), { code: 'strategy_timeout' }); }
  finally { clearTimeout(keepAlive); }
  assert.equal(terminated, 1);
  assert.equal(runner.isRunning(), false);
  const graceful = createStrategyRunner({ dbPath: 'test.sqlite', workerFactory: () => {
    const worker = new EventEmitter();
    worker.postMessage = message => { assert.equal(message.action, 'stop'); queueMicrotask(() => worker.emit('exit', 0)); };
    worker.terminate = async () => { throw new Error('must not force a clean collector'); };
    return worker;
  } });
  const pending = graceful.run({ mode: 'v9', activation_seq: 1 });
  const rejected = assert.rejects(pending, /未返回结果/);
  await graceful.stop();
  await rejected;
  assert.equal(graceful.isRunning(), false);
  await assert.rejects(graceful.run(), { code: 'strategy_stopped' });
});

test('holding-monitor cache refreshes public identities only, with bounded retry and unchanged evidence on failure', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'qdd-monitor-job-'));
  const dbPath = path.join(folder, 'ledger.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE r2_strategy_state (singleton INTEGER, ledger_identity TEXT);
    INSERT INTO r2_strategy_state VALUES(1,'test-ledger-identity')`);
  t.after(() => { db.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  const ledger = { db, dbPath, tradeStore: { getPortfolio: () => [{ product_code: 'P', lot_id: 'private-lot', amount: 123456 }] } };
  let now = new Date('2026-11-09T04:00:00Z'), calls = 0;
  const args = { ledger, sourceSnapshot: { published: 1 }, date: '2026-11-09', clock: () => now,
    collector: async ({ identities }) => {
      calls++;
      assert.deepEqual(identities, [{ source: 'cmb', channel: 'cmb', code: 'P' }]);
      const batch = { scope: 'holding_monitor', business_date: '2026-11-09', collector_version: 'cmb-public-v1',
        captured_at: now.toISOString(), items: [{ identity: identities[0], data: {}, nav_hash: null, issues: [], evidence: [] }] };
      return { ...batch, content_hash: fingerprint(monitorContent(batch)) };
    } };
  assert.equal((await refreshHoldingMonitor(args)).refreshed, true);
  const first = readHoldingSupplements(dbPath, args.date)[0];
  assert.equal((await refreshHoldingMonitor(args)).reason, 'monitor_current');
  assert.equal(calls, 1);
  assert.deepEqual(readHoldingSupplements(dbPath, '2026-11-10'), []);
  const failed = { ...args, sourceSnapshot: { published: 2 }, collector: async () => { throw new Error('offline'); } };
  assert.equal((await refreshHoldingMonitor(failed)).refreshed, false);
  assert.equal((await refreshHoldingMonitor(failed)).reason, 'monitor_backoff');
  for (let i = 0; i < 2; i++) { now = new Date(now.getTime() + 3600000); await refreshHoldingMonitor(failed); }
  assert.equal((await refreshHoldingMonitor(failed)).reason, 'monitor_attempts_exhausted');
  assert.deepEqual(readHoldingSupplements(dbPath, args.date), [first]);
  assert.equal(fs.existsSync(`${artifactPath(dbPath)}.lock`), false);
  const degradedBatch = { ...first, captured_at: now.toISOString(), items: first.items.map(row => ({ ...row,
    issues: ['nav_unavailable'] })) };
  degradedBatch.content_hash = fingerprint(monitorContent(degradedBatch));
  assert.equal((await refreshHoldingMonitor({ ...args, sourceSnapshot: { published: 3 },
    collector: async () => degradedBatch })).refreshed, true);
  assert.deepEqual(readHoldingSupplements(dbPath, args.date), [first, degradedBatch]);
  const stored = readArtifact(dbPath);
  writeArtifact(dbPath, { ...stored, baseline: null, batch: { ...first, content_hash: 'bad' } });
  assert.deepEqual(readHoldingSupplements(dbPath, args.date), []);
  assert.equal((await refreshHoldingMonitor({ ...args, date: '2026-11-08' })).reason, 'calendar_closed');
  writeArtifact(dbPath, { batch: first });
  db.exec("UPDATE r2_strategy_state SET ledger_identity='restored-different-ledger'");
  assert.equal(readArtifact(dbPath), null);
  assert.deepEqual(readHoldingSupplements(dbPath, args.date), []);
});
