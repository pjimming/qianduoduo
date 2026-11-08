'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../lib/db');
const { createTransactionManager } = require('../lib/transaction');
const { openScreeningRepository } = require('../server/modules/r2-screening/repository');
const { createStrategyRepository, payload } = require('../server/modules/r2-strategy/repository');
const { CONTRACT_HASH } = require('../server/modules/r2-strategy/contract');

async function setup(t, mode = 'v9') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qdd-v9-repo-'));
  let db;
  t.after(() => { db?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const dbPath = path.join(dir, 'ledger.sqlite');
  const screeningPath = path.join(dir, 'public.sqlite');
  openDatabase({ dbPath, logger: { warn() {} } }).close();
  openScreeningRepository(screeningPath, { ledgerPath: dbPath, initialize: true }).close();
  const { applyMigration } = await import('../scripts/migrate-r2-strategy.mjs');
  applyMigration({ dbPath, screeningPath, backupDir: path.join(dir, 'backups') });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000');
  let time = Date.parse('2026-11-07T04:00:00Z');
  const transactionManager = createTransactionManager(db);
  const repository = createStrategyRepository(db, { transactionManager, clock: () => new Date(time) });
  if (mode !== 'legacy') repository.transition({ expectedSeq: 0, operationKey: 'test-activate', mode });
  return { db, dbPath, repository, transactionManager, advance: ms => { time += ms; } };
}
function owners(db) {
  const decisionId = Number(db.prepare("INSERT INTO decision_log(decision_date,product_name,action,created_at,updated_at) VALUES ('2026-11-07','fixture','买入','now','now')").run().lastInsertRowid);
  const proposalId = Number(db.prepare(`INSERT INTO decision_proposals(dedupe_key,group_key,proposal_type,title,summary,action,product_name,decision_id,created_at,updated_at)
    VALUES (?,?,'cash_allocation','test','test','买入','fixture',?,'now','now')`).run(`owner-${decisionId}`, `group-${decisionId}`, decisionId).lastInsertRowid);
  return { decisionId, proposalId, legKey: 'buy' };
}
const lease = row => ({ id: row.id, expectedSeq: row.activation_seq, inputHash: row.input_hash, token: row.lease_token });
const mapping = { product_code: 'OLD', source: 'cmb', channel: 'D07', sales_code: 'A', verified_by: 'test',
  verified_at: '2026-11-07T04:00:00Z', evidence_hash: 'a'.repeat(64), registration_code: 'Z1234567890', expected_seq: 1 };

test('constructor and pre-migration queries are read-only; writes fail closed', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const repo = createStrategyRepository(db);
    assert.equal(repo.state(), null);
    assert.deepEqual(repo.listMappings(), []);
    assert.deepEqual(repo.reservations(), []);
    assert.equal(repo.reservedCents(), 0);
    assert.throws(() => repo.transition({ expectedSeq: 0, operationKey: 'x', mode: 'shadow' }), error => error.code === 'strategy_unavailable');
    assert.equal(db.prepare('SELECT count(*) n FROM sqlite_schema').get().n, 0);
  } finally { db.close(); }
});
test('activation is atomic, monotonically sequenced, idempotent and rejects old writers', async t => {
  const { db, repository: r } = await setup(t, 'legacy');
  assert.throws(() => r.transition({ operationKey: 'fail', expectedSeq: 0, mode: 'shadow' }, () => { throw new Error('injected'); }), /injected/);
  assert.equal(r.state().activation_seq, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM r2_strategy_transitions').get().n, 0);
  r.transition({ operationKey: 'activate', expectedSeq: 0, mode: 'shadow', summary: { reason: 'test' } });
  assert.equal(r.state().activation_seq, 1);
  assert.equal(r.state().contract_hash, CONTRACT_HASH);
  assert.equal(r.transition({ operationKey: 'activate', expectedSeq: 0, mode: 'shadow', summary: { reason: 'test' } }).existing, true);
  assert.throws(() => r.transition({ operationKey: 'activate', expectedSeq: 0, mode: 'v9' }), error => error.code === 'operation_conflict');
  assert.throws(() => r.transition({ operationKey: 'stale', expectedSeq: 0, mode: 'v9' }), error => error.code === 'activation_changed');
});
test('same-share mapping versions and pretrade checks append without changing old evidence', async t => {
  const { repository: r } = await setup(t);
  const first = r.appendMapping(mapping);
  assert.equal(r.appendMapping(mapping).id, first.id);
  assert.throws(() => r.appendMapping({ ...mapping, sales_code: 'B' }), error => error.code === 'mapping_changed');
  assert.throws(() => r.appendMapping({ ...mapping, product_code: 'OTHER' }), error => error.code === 'mapping_conflict');
  const check = { mappingId: first.id, expectedSeq: 1, facts: { status: 'pending', assets: { document_hash: 'b'.repeat(64) } }, verifiedBy: 'test', verifiedAt: mapping.verified_at };
  const a = r.appendCheck(check);
  assert.equal(r.appendCheck(check).id, a.id);
  assert.throws(() => r.appendCheck({ ...check, facts: { status: 'withdrawn' } }), error => error.code === 'check_changed');
  const b = r.appendCheck({ ...check, supersedesId: a.id, facts: { status: 'withdrawn' } });
  assert.equal(b.version, 2);
  assert.equal(a.facts.status, 'pending');
  const second = r.appendMapping({ ...mapping, sales_code: 'B', supersedes_id: first.id });
  assert.notEqual(second.id, first.id);
  assert.equal(r.listMappings().length, 1);
  assert.equal(r.listMappings({ activeOnly: false }).length, 2);
  assert.throws(() => r.appendCheck({ ...check, supersedesId: b.id, facts: { status: 'verified' } }), error => error.code === 'mapping_changed');
});
test('reservations share the business transaction, retries do not reserve twice, and cumulative execution conserves cents', async t => {
  const { db, repository: r, transactionManager } = await setup(t);
  const owner = owners(db);
  const input = { ...owner, amountCents: 10000, expectedSeq: 1, readAvailableCents: () => 10000 - r.reservedCents() };
  assert.throws(() => transactionManager.run(() => { r.reserve(input); throw new Error('after reserve'); }), /after reserve/);
  assert.equal(r.reservedCents(), 0);
  const a = r.reserve(input);
  assert.equal(r.reserve(input).id, a.id);
  assert.equal(r.reservedCents(), 10000);
  assert.throws(() => r.reserve({ ...input, amountCents: 9999 }), error => error.code === 'reservation_conflict');
  r.reconcileReservation({ id: a.id, executedCents: 4000 });
  assert.equal(r.reservedCents(), 6000);
  assert.equal(r.reconcileReservation({ id: a.id, executedCents: 4000 }).executed_cents, 4000);
  assert.throws(() => r.reconcileReservation({ id: a.id, executedCents: 3000 }), error => error.code === 'execution_regression');
  assert.throws(() => r.reconcileReservation({ id: a.id, executedCents: 10001 }), error => error.code === 'execution_exceeds_reservation');
  const closed = r.reconcileReservation({ id: a.id, executedCents: 4000, releaseRemaining: true });
  assert.equal(closed.released_cents, 6000);
  assert.equal(r.reservedCents(), 0);
  assert.equal(r.reconcileReservation({ id: a.id, executedCents: 4000, releaseRemaining: true }).released_cents, 6000);
  assert.throws(() => r.reconcileReservation({ id: a.id, executedCents: 5000 }), error => error.code === 'execution_exceeds_reservation');
});
test('shadow mode cannot create a formal reservation', async t => {
  const { db, repository: r } = await setup(t, 'shadow');
  assert.throws(() => r.reserve({ ...owners(db), amountCents: 100, expectedSeq: 1, readAvailableCents: () => 100 }), error => error.code === 'recommendation_disabled');
  assert.equal(r.reservedCents(), 0);
});
test('two independent workers compete for the same cash and only one can reserve it', async t => {
  const { db, dbPath, repository: r } = await setup(t);
  const input = [owners(db), owners(db)];
  const source = `const {parentPort,workerData:d}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite'); const {createStrategyRepository}=require(d.module);
    const db=new DatabaseSync(d.dbPath); db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=3000'); const r=createStrategyRepository(db);
    parentPort.on('message',()=>{try{r.reserve({...d.owner,expectedSeq:1,amountCents:6000,readAvailableCents:()=>10000-r.reservedCents()});parentPort.postMessage({ok:true});}
      catch(e){parentPort.postMessage({ok:false,code:e.code});}finally{db.close();parentPort.close();}});parentPort.postMessage({ready:true});`;
  const workers = input.map(owner => new Worker(source, { eval: true, workerData: { dbPath, owner, module: require.resolve('../server/modules/r2-strategy/repository') } }));
  const exits = workers.map(worker => new Promise(resolve => worker.once('exit', resolve)));
  const results = workers.map(worker => new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', message => { if (!message.ready) resolve(message); });
  }));
  await Promise.all(workers.map(worker => new Promise(resolve => worker.once('message', resolve))));
  workers.forEach(worker => worker.postMessage('go'));
  const outcomes = await Promise.all(results);
  await Promise.all(exits);
  assert.equal(outcomes.filter(row => row.ok).length, 1);
  assert.equal(outcomes.find(row => !row.ok).code, 'insufficient_funds');
  assert.equal(r.reservedCents(), 6000);
});
test('lost notifications are repaired by idempotent scanning and completed jobs return the committed result', async t => {
  const { db, repository: r } = await setup(t, 'shadow');
  db.exec('CREATE TABLE test_projection (value INTEGER NOT NULL)');
  const input = { eventType: 'screening', expectedSeq: 1, input: { source_hash: 'published', account_hash: 'current', business_date: '2026-11-07' } };
  const first = r.enqueue(input);
  assert.equal(r.enqueue(input).id, first.id);
  const job = r.claim({ expectedSeq: 1 });
  assert.throws(() => r.complete(lease(job), () => { db.exec('INSERT INTO test_projection VALUES (1)'); throw new Error('after projection'); }), /after projection/);
  assert.equal(db.prepare('SELECT count(*) n FROM test_projection').get().n, 0);
  assert.equal(r.watermark('screening'), null);
  assert.equal(r.getJob(job.id).status, 'running');
  const done = r.complete(lease(job), () => { db.exec('INSERT INTO test_projection VALUES (1)'); return { count: 1 }; });
  assert.equal(done.status, 'done');
  assert.equal(r.watermark('screening').job_id, first.id);
  assert.equal(r.complete(lease(job), () => { throw new Error('must never repeat'); }).id, done.id);
  assert.equal(r.enqueue(input).id, done.id);
});
test('new fingerprints and activation changes invalidate in-flight workers without advancing watermarks', async t => {
  const { repository: r } = await setup(t, 'shadow');
  const input = { eventType: 'account', expectedSeq: 1, input: { hash: 'first' } };
  r.enqueue(input);
  const first = r.claim({ expectedSeq: 1 });
  const next = r.enqueue({ ...input, input: { hash: 'second' } });
  assert.equal(r.getJob(first.id).status, 'superseded');
  assert.throws(() => r.complete(lease(first), () => ({})), error => error.code === 'job_stale');
  const second = r.claim({ expectedSeq: 1 });
  assert.equal(second.id, next.id);
  r.transition({ expectedSeq: 1, operationKey: 'stop', mode: 'suspended' });
  assert.throws(() => r.complete(lease(second), () => ({})), error => error.code === 'activation_changed');
  assert.equal(r.watermark('account'), null);
  assert.equal(r.claim({ expectedSeq: 2 }), null);
});
test('expired leases and source failures retry boundedly; stale tokens cannot release the replacement lease', async t => {
  const { repository: r, advance } = await setup(t, 'shadow');
  r.enqueue({ eventType: 'source', expectedSeq: 1, input: { hash: 'current' } });
  const first = r.claim({ leaseMs: 1000 });
  advance(1000);
  const second = r.claim({ leaseMs: 1000 });
  assert.equal(second.id, first.id);
  assert.notEqual(second.lease_token, first.lease_token);
  assert.throws(() => r.fail(lease(first), 'late'), error => error.code === 'job_stale');
  const failed = r.fail(lease(second), 'source_timeout');
  assert.equal(failed.attempts, 2);
  assert.equal(r.claim(), null);
  advance(60000);
  const third = r.claim();
  assert.equal(third.attempts, 3);
  assert.equal(r.fail(lease(third), 'source_timeout').status, 'failed');
  advance(600000);
  assert.equal(r.claim(), null);
  assert.equal(r.watermark('source'), null);
});
test('JSON payload rejects non-finite, undefined, cyclic and oversized input', () => {
  const cycle = {}; cycle.self = cycle;
  for (const input of [{ v: undefined }, { v: NaN }, { v: Infinity }, { v: new Date() }, cycle, { value: 'x'.repeat(65536) }]) {
    assert.throws(() => payload(input), error => error.code === 'invalid_input');
  }
  assert.equal(payload({ b: null, a: [1, false, 'text'] }), '{"a":[1,false,"text"],"b":null}');
});
