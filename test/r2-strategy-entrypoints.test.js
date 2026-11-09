'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { spawnSync } = require('node:child_process');
const { openDatabase } = require('../lib/db');
const { createServer } = require('../server');
const { startServer } = require('../server/lifecycle');
const { openScreeningRepository } = require('../server/modules/r2-screening/repository');
const { createStrategyRepository } = require('../server/modules/r2-strategy/repository');
const { openStrategyLedger } = require('../server/modules/r2-strategy/existing-ledger');
const { fingerprint } = require('../server/modules/r2-strategy/contract');
const { strategyFixture } = require('./fixtures/r2-strategy.cjs');

async function setup(t, mode = 'shadow') {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-07T04:00:00Z') });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'qdd-strategy-http-'));
  let repository, publicStore, server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    publicStore?.close(); repository?.close(); fs.rmSync(folder, { recursive: true, force: true });
  });
  const dbPath = path.join(folder, 'ledger.sqlite'), screeningPath = path.join(folder, 'screening.sqlite');
  const fixture = strategyFixture();
  repository = openDatabase({ dbPath, logger: { warn() {} } });
  repository.initializeCapital(100, fixture.date);
  publicStore = openScreeningRepository(screeningPath, { ledgerPath: dbPath, initialize: true });
  const versions = { rule: 'v9', refresh: 'synthetic-refresh', valuation: 'synthetic-valuation', collector: 'synthetic-collector' };
  const now = '2026-11-07T04:00:00.000Z';
  publicStore.enqueue({ trigger: 'manual', date: fixture.date, key: 'test', now, versions });
  const claim = publicStore.take(fixture.date, now, versions);
  assert.equal(publicStore.publish(claim.token, now, fixture.date, fixture.collected,
    { results: fixture.sourceSnapshot.rows.map(row => row.data), counts: fixture.sourceSnapshot.run.counts }, false), true);
  const { applyMigration } = await import('../scripts/migrate-r2-strategy.mjs');
  applyMigration({ dbPath, screeningPath, backupDir: path.join(folder, 'backups') });
  const store = createStrategyRepository(repository.db, { transactionManager: repository.transactionManager });
  store.transition({ expectedSeq: 0, operationKey: mode, mode });
  let offline = false;
  server = createServer({ repository, screening: { executionSnapshot() { if (offline) throw new Error('offline'); return publicStore.readExecutionSnapshot(); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { repository, store, fixture, dbPath, screeningPath, base: `http://127.0.0.1:${server.address().port}`, offline: () => { offline = true; } };
}
const post = (url, body = {}, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
function legacySignature(db) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'r2_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return fingerprint(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all().map(JSON.stringify).sort()]));
}
async function worker(data) {
  const handle = new Worker(require.resolve('../server/jobs/r2-strategy-worker'), { workerData: data });
  const exited = new Promise(resolve => handle.once('exit', resolve));
  const result = await new Promise((resolve, reject) => { handle.once('message', resolve); handle.once('error', reject); });
  await exited;
  return result;
}

test('HTTP, independent worker and CLI produce the same frozen input and policy result without initialization writes', async t => {
  const context = await setup(t);
  const signature = legacySignature(context.repository.db);
  const preview = await (await post(`${context.base}/api/r2-strategy/preview`)).json();
  assert.equal(preview.result.allocation.full_investment, true);
  const background = await worker({ action: 'preview', dbPath: context.dbPath, screeningPath: context.screeningPath, date: context.fixture.date, expectedSeq: 1 });
  assert.equal(background.ok, true);
  assert.equal(background.result.input_fingerprint, preview.input_fingerprint);
  assert.deepEqual(background.result.result, preview.result);
  const cli = spawnSync(process.execPath, [require.resolve('../scripts/r2-strategy.cjs'), 'preview', '--db', context.dbPath,
    '--screening-db', context.screeningPath, '--date', context.fixture.date], { windowsHide: true, encoding: 'utf8' });
  if (cli.error?.code === 'EPERM') {
    // The sandboxed runner cannot create the stdio pipes spawnSync needs; the
    // same CLI path is exercised by the integration runner outside the sandbox.
    t.diagnostic('spawnSync 被沙箱拒绝（EPERM），跳过 CLI 断言');
  } else {
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).input_fingerprint, preview.input_fingerprint);
  }
  assert.equal(legacySignature(context.repository.db), signature);
  const status = await (await fetch(`${context.base}/api/r2-strategy/status`)).json();
  assert.equal(status.mode, 'shadow');
  assert.equal(status.migrated, true);
});
test('recompute writes only the shadow projection; GET and duplicate requests have no extra business writes', async t => {
  const context = await setup(t);
  const signature = legacySignature(context.repository.db);
  const result = await (await post(`${context.base}/api/r2-strategy/recompute`)).json();
  assert.equal(result.persisted, true);
  assert.equal(result.result.may_generate_buy_proposals, false);
  const changes = context.repository.db.prepare('SELECT total_changes() n').get().n;
  const workspace = await (await fetch(`${context.base}/api/r2-strategy/workspace`)).json();
  assert.equal(workspace.stale, false);
  assert.equal(workspace.result.input_fingerprint, result.result.input_fingerprint);
  assert.equal((await (await post(`${context.base}/api/r2-strategy/recompute`)).json()).job_id, result.job_id);
  assert.equal(context.repository.db.prepare('SELECT total_changes() n').get().n, changes);
  assert.equal(legacySignature(context.repository.db), signature);
});
test('HTTP rejects injected context and invalid fingerprints; source failures preserve ledger and stored result', async t => {
  const context = await setup(t);
  assert.equal((await post(`${context.base}/api/r2-strategy/preview`, { principal: 999 })).status, 400);
  assert.equal((await post(`${context.base}/api/r2-strategy/recompute`, { expected_input_fingerprint: 'invalid' })).status, 400);
  assert.equal((await post(`${context.base}/api/r2-strategy/recompute`, { expected_input_fingerprint: 'a'.repeat(64) })).status, 409);
  assert.equal((await post(`${context.base}/api/r2-strategy/recompute`, {}, { origin: 'https://untrusted.invalid' })).status, 403);
  const stored = await (await post(`${context.base}/api/r2-strategy/recompute`)).json();
  context.offline();
  const current = await (await fetch(`${context.base}/api/r2-strategy/workspace`)).json();
  assert.equal(current.source_issue, 'screening_unavailable');
  assert.equal(current.result.input_fingerprint, stored.result.input_fingerprint);
  assert.equal((await fetch(`${context.base}/api/health`)).status, 200);
  assert.equal((await worker({ action: 'preview', dbPath: context.dbPath, screeningPath: context.screeningPath,
    date: context.fixture.date, expectedSeq: 0 })).ok, false);
});
test('existing-schema adapter refuses missing or incomplete databases rather than running migrations', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'qdd-strategy-existing-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const missing = path.join(folder, 'missing.sqlite');
  assert.throws(() => openStrategyLedger(missing), /禁止隐式初始化/);
  assert.equal(fs.existsSync(missing), false);
});

test('retired review, mapping and check entrypoints are no longer exposed', async t => {
  const context = await setup(t);
  assert.equal((await fetch(`${context.base}/api/r2-strategy/reviews/TEST/S1`)).status, 404);
  assert.equal((await fetch(`${context.base}/api/r2-strategy/share-match?source=cmb&channel=TEST&code=S1`)).status, 404);
  assert.equal((await post(`${context.base}/api/r2-strategy/mappings`, { source: 'cmb', channel: 'TEST', sales_code: 'S3', product_code: 'S3' })).status, 404);
  assert.equal((await post(`${context.base}/api/r2-strategy/checks`, { mapping_id: 1, facts: {} })).status, 404);
  const tables = context.repository.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('r2_share_mappings','r2_pretrade_checks')").all();
  assert.deepEqual(tables, []);
});
test('workspace exposes monitoring rows and selected reviews beside the existing result fields', async t => {
  const context = await setup(t);
  await post(`${context.base}/api/r2-strategy/recompute`);
  const workspace = await (await fetch(`${context.base}/api/r2-strategy/workspace`)).json();
  assert.equal(typeof workspace.result.monitoring.counts, 'object');
  assert.equal(Array.isArray(workspace.result.monitoring.rows), true);
  assert.equal(workspace.result.allocation.full_investment, true);
  assert.equal(workspace.mode, 'shadow');
  assert.equal(workspace.activation_seq, 1);
  assert.match(workspace.input_fingerprint, /^[a-f0-9]{64}$/);
});
test('worker refuses stale sequences or modes', async t => {
  const shadow = await setup(t);
  const mismatched = await worker({ action: 'preview', dbPath: shadow.dbPath, screeningPath: shadow.screeningPath,
    date: shadow.fixture.date, expectedSeq: 1, mode: 'v9' });
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.error, /模式已失效/);
  const stale = await worker({ action: 'preview', dbPath: shadow.dbPath, screeningPath: shadow.screeningPath,
    date: shadow.fixture.date, expectedSeq: 0, mode: 'shadow' });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /序号已失效/);
});
test('worker keeps legacy recompute as a non-writing preview', async t => {
  const legacy = await setup(t, 'legacy');
  const preview = await worker({ action: 'recompute', dbPath: legacy.dbPath, screeningPath: legacy.screeningPath,
    date: legacy.fixture.date, expectedSeq: 1, mode: 'legacy' });
  assert.equal(preview.ok, true);
  assert.equal(preview.action, 'preview');
  assert.equal(preview.result.persisted, false);
  assert.equal(legacy.repository.db.prepare('SELECT count(*) n FROM r2_derivation_jobs').get().n, 0);
  assert.equal(legacy.repository.db.prepare('SELECT count(*) n FROM decision_proposals').get().n, 0);
});

test('lifecycle strategy scheduling uses an independent worker while HTTP remains responsive and stops cleanly', async t => {
  const context = await setup(t);
  const runtime = startServer({ dbPath: context.dbPath, screeningDbPath: context.screeningPath,
    screeningEnabled: false, automation: false, strategyScheduler: false, maintenance: false,
    port: 0, installSignalHandlers: false, logger: { log() {}, warn() {}, error() {} } });
  try {
    await runtime.ready;
    const base = `http://127.0.0.1:${runtime.server.address().port}`;
    const pending = runtime.strategyScheduler.run('manual-test');
    assert.equal(typeof pending.then, 'function');
    assert.equal(runtime.strategyScheduler.getStatus().running, true);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.persisted, true);
    assert.equal(runtime.strategyScheduler.getStatus().running, false);
    assert.equal(context.repository.db.prepare("SELECT count(*) n FROM r2_derivation_jobs WHERE status='done'").get().n, 1);
  } finally { await runtime.stop(); }
  assert.equal(runtime.strategyScheduler.run().reason, 'stopped');
});

test('cancel-remaining API is wired, validates fields and refuses a decision without confirmed fills', async t => {
  const context = await setup(t);
  context.store.transition({ expectedSeq: 1, operationKey: 'v9-cancel-remaining', mode: 'v9' });
  const generated = await (await post(`${context.base}/api/r2-strategy/proposals`)).json();
  const id = generated.created[0].proposal.id;
  assert.equal((await post(`${context.base}/api/decision-proposals/${id}/adopt`)).status, 200);
  const reserved = context.store.reservedCents();
  assert.equal((await post(`${context.base}/api/r2-strategy/proposals/${id}/cancel-remaining`, { reason: 'x', extra: 1 })).status, 400);
  const refused = await post(`${context.base}/api/r2-strategy/proposals/${id}/cancel-remaining`, { reason: 'x' });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /没有已确认成交/);
  assert.equal(context.store.reservedCents(), reserved);
});
test('existing adoption/rejection API dispatches v9 proposals to the validated transaction and preserves cancellation semantics', async t => {
  const context = await setup(t);
  context.store.transition({ expectedSeq: 1, operationKey: 'v9-test', mode: 'v9' });
  assert.equal((await post(`${context.base}/api/r2-strategy/proposals`, { kind: 'invalid_kind' })).status, 400);
  assert.equal((await post(`${context.base}/api/r2-strategy/proposals`, { kind: 'holding_exit', lot_id: 'missing:S1' })).status, 404);
  const generatedResponse = await post(`${context.base}/api/r2-strategy/proposals`);
  assert.equal(generatedResponse.status, 200);
  const generated = await generatedResponse.json();
  const id = generated.created[0].proposal.id;
  const adopted = await post(`${context.base}/api/decision-proposals/${id}/adopt`);
  assert.equal(adopted.status, 200);
  const body = await adopted.json();
  assert.equal(body.result.decision.strategy_version, 'r2-screening-v9-execution-v1');
  assert.equal(context.store.reservations().length, 1);
  const repeated = await (await post(`${context.base}/api/decision-proposals/${id}/adopt`)).json();
  assert.equal(repeated.result.decision.id, body.result.decision.id);
  assert.equal(context.store.reservations().length, 1);
  const reserved = context.store.reservedCents();
  assert.equal((await post(`${context.base}/api/decision-proposals/${id}/reject`, { reason: null })).status, 400);
  assert.equal(context.store.reservedCents(), reserved);
  assert.equal((await post(`${context.base}/api/decision-proposals/${id}/reject`, { reason: 'fixture cancel' })).status, 200);
  assert.equal(context.store.reservedCents(), 0);
  assert.equal(context.repository.tradeStore.listTrades().length, 0);
});
