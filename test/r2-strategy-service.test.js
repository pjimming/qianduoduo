'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openDatabase } = require('../lib/db');
const { openScreeningRepository } = require('../server/modules/r2-screening/repository');
const { createStrategyRepository } = require('../server/modules/r2-strategy/repository');
const { createStrategyService } = require('../server/modules/r2-strategy/service');
const { createStrategyProposalService } = require('../server/modules/r2-strategy/proposals');
const { fingerprint } = require('../server/modules/r2-strategy/contract');
const { createStrategyScheduler } = require('../server/jobs/r2-strategy-scheduler');
const { evaluateStrategy } = require('../server/modules/r2-strategy/engine');
const { strategyFixture } = require('./fixtures/r2-strategy.cjs');

async function setup(t, mode = 'shadow') {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'qdd-strategy-service-'));
  let repository;
  t.after(() => { repository?.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  const dbPath = path.join(folder, 'ledger.sqlite'), screeningPath = path.join(folder, 'screen.sqlite');
  repository = openDatabase({ dbPath, logger: { warn() {} } });
  repository.initializeCapital(100, '2026-11-07');
  openScreeningRepository(screeningPath, { initialize: true, ledgerPath: dbPath }).close();
  const { applyMigration } = await import('../scripts/migrate-r2-strategy.mjs');
  applyMigration({ dbPath, screeningPath, backupDir: path.join(folder, 'backups') });
  const store = createStrategyRepository(repository.db, { transactionManager: repository.transactionManager });
  store.transition({ operationKey: 'test', expectedSeq: 0, mode });
  const fixture = strategyFixture();
  const options = { repository, strategyRepository: store, todayProvider: () => fixture.date,
    screening: { executionSnapshot: () => fixture.sourceSnapshot } };
  return { repository, fixture, store, options };
}

test('workspace and preview queries have no writes, and legacy recompute stays a non-persistent preview', async t => {
  const { repository, options, store } = await setup(t, 'legacy');
  const service = createStrategyService(options);
  const before = repository.db.prepare('SELECT total_changes() n').get().n;
  const workspace = service.workspace();
  assert.equal(workspace.result, null);
  assert.equal(service.preview().result.allocation.full_investment, true);
  assert.equal(service.recompute().persisted, false);
  assert.equal(repository.db.prepare('SELECT total_changes() n').get().n, before);
  assert.deepEqual(store.jobSummary().counts, {});
});
test('dated payment needs replace the estimated windows and accumulate by payment day', async t => {
  const { repository, options } = await setup(t, 'v9');
  const service = createStrategyService(options);
  repository.saveAllocationSettings({ cashflow_0_3: 30 });
  assert.equal(service.workspace().cash_needs[0].basis, 'legacy_window_end');
  repository.saveAllocationSettings({ cashflow_dates: [
    { by_date: '2026-12-09', amount_cents: 500 },
    { by_date: '2026-11-10', amount_cents: 1000 },
  ] });
  assert.deepEqual(service.workspace().cash_needs, [
    { by_date: '2026-11-10', required_cents: 1000, basis: 'payment_date' },
    { by_date: '2026-12-09', required_cents: 1500, basis: 'payment_date' },
  ]);
  repository.saveAllocationSettings({ cashflow_dates: [] });
  assert.deepEqual(service.workspace().cash_needs, []);
});
test('shadow recompute persists one resumable projection without creating proposals, decisions or messages', async t => {
  const { repository, options, store } = await setup(t);
  const service = createStrategyService(options);
  const count = table => repository.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  const before = ['decision_proposals', 'decision_log', 'inbox_items'].map(count);
  const result = service.recompute();
  assert.equal(result.result.allocation.full_investment, true);
  assert.equal(result.result.may_generate_buy_proposals, false);
  assert.equal(store.getJob(result.job_id).status, 'done');
  assert.equal(service.recompute().job_id, result.job_id);
  assert.equal(service.workspace().stale, false);
  assert.deepEqual(['decision_proposals', 'decision_log', 'inbox_items'].map(count), before);
  repository.saveAllocationSettings({ principal_override: 200 });
  assert.equal(service.workspace().stale, true);
});
test('a changed input blocks before enqueue and a lost source does not erase the previous persisted result', async t => {
  const { options, fixture, store } = await setup(t);
  const service = createStrategyService(options);
  const result = service.recompute();
  fixture.sourceSnapshot.run.id = 2;
  assert.throws(() => service.recompute({ expectedInputFingerprint: result.input_fingerprint }), error => error.code === 'input_changed');
  const broken = createStrategyService({ ...options, screening: { executionSnapshot() { throw new Error('offline'); } } });
  const workspace = broken.workspace();
  assert.equal(workspace.source_issue, 'screening_unavailable');
  assert.equal(workspace.stale, true);
  assert.equal(workspace.result.input_fingerprint, result.result.input_fingerprint);
  assert.equal(store.watermark('strategy').job_id, result.job_id);
});
test('outside-transaction computation cannot commit after a concurrent cash change', async t => {
  const { options, repository, store } = await setup(t);
  const service = createStrategyService({ ...options, evaluate: input => {
    const result = evaluateStrategy(input);
    repository.saveAllocationSettings({ principal_override: 200 });
    return result;
  } });
  assert.throws(() => service.recompute(), error => error.code === 'input_changed');
  assert.equal(store.watermark('strategy'), null);
  assert.equal(store.jobSummary().latest.error_code, 'input_changed');
});
test('holding exit proposals use an executable holding plan, dedupe and adopt without a cash reservation', async t => {
  const { repository, fixture, store, options } = await setup(t, 'v9');
  const holding = { id: 901, lot_id: '901:S1', product_code: 'S1', product_name: '合成产品S1',
    amount: 50, confirm_date: '2026-10-01' };
  fixture.sourceSnapshot.rows[0].data.performance['1m'] = '1.20';
  fixture.sourceSnapshot.evidence[0].summary.performance['1m'] = '1.20';
  const service = createStrategyService(options);
  const withHolding = source => { const next = JSON.parse(JSON.stringify(source)); next.portfolio.holdings = [holding]; return next; };
  const strategy = { status: () => service.status(),
    frozenInput: () => { const current = service.frozenInput(); const input = withHolding(current.input);
      return { ...current, input, fingerprint: fingerprint(input) }; },
    readLedgerInput: date => withHolding(service.readLedgerInput(date)) };
  const proposals = createStrategyProposalService({ ...options, strategy });
  const generated = proposals.generate({ kind: 'holding_exit', lotId: holding.lot_id, amountCents: 5000 });
  assert.equal(generated.created.length, 1);
  const created = generated.created[0];
  assert.equal(created.existing, false);
  assert.equal(created.proposal.proposal_type, 'holding_switch');
  assert.equal(created.proposal.action, '赎回');
  assert.equal(created.proposal.payload.kind, 'holding_exit');
  assert.equal(created.proposal.payload.plan.executable, true);
  assert.equal(created.proposal.payload.expected_legs.some(leg => leg.side === 'redeem'), true);
  assert.equal(created.proposal.payload.expected_legs.some(leg => leg.side === 'buy'), false);
  const repeat = proposals.generate({ kind: 'holding_exit', lotId: holding.lot_id, amountCents: 5000 });
  assert.equal(repeat.created[0].existing, true);
  assert.equal(repeat.created[0].proposal.id, created.proposal.id);
  assert.equal(repository.db.prepare('SELECT count(*) n FROM decision_proposals').get().n, 1);
  const adopted = proposals.adopt(created.proposal.id);
  assert.equal(adopted.existing, false);
  assert.equal(adopted.decision.action, '赎回');
  assert.equal(adopted.decision.review_meta.holding_kind, 'holding_exit');
  assert.equal(adopted.decision.review_meta.plan_hash, created.proposal.payload.plan_hash);
  assert.equal(repository.db.prepare('SELECT count(*) n FROM r2_fund_reservations').get().n, 0);
  assert.equal(proposals.adopt(created.proposal.id).existing, true);
  const { evaluateExecutionDecision } = require('../server/modules/r2-strategy/evaluation');
  const evaluation = evaluateExecutionDecision({ decision: adopted.decision, today: fixture.date,
    trades: [{ id: 900, decision_id: adopted.decision.id, trade_type: 'redeem', status: 'confirmed',
      product_code: 'S1', amount: 50, trade_date: fixture.date, screenshot_id: 1 }] });
  assert.equal(evaluation[0].evidence.historical_basis, 'frozen');
  assert.equal(evaluation[0].process_ok, true);
  assert.equal(evaluation[0].stage, 'holding');
  assert.equal(evaluation[0].outcome, 'unknown');
});

test('strategy scheduler stays preview-only in legacy, shares recompute and never advances through failures', async () => {
  let called = 0;
  const legacy = createStrategyScheduler({ strategy: { status: () => ({ mode: 'legacy', activation_seq: 0 }),
    recompute: () => { called += 1; } }, logger: { warn() {} }, intervalMs: 60000, startupDelayMs: 60000 });
  assert.deepEqual(legacy.run('startup'), { trigger: 'startup', at: legacy.run('startup').at, skipped: true,
    reason: 'mode_not_active', mode: 'legacy', activation_seq: 0 });
  legacy.start();
  legacy.stop();
  assert.equal(legacy.getStatus().running, false);
  assert.equal(called, 0);
  const shadow = createStrategyScheduler({ strategy: { status: () => ({ mode: 'shadow', activation_seq: 1 }),
    recompute: () => ({ persisted: true, job_id: 'job-1', input_fingerprint: 'f'.repeat(64) }) },
  logger: { warn() {} }, intervalMs: 60000, startupDelayMs: 60000 });
  const first = shadow.run('periodic');
  assert.equal(first.ok, true);
  assert.equal(first.activation_seq, 1);
  assert.equal(first.persisted, true);
  assert.equal(first.job_id, 'job-1');
  assert.equal(shadow.getStatus().running, false);
  const failing = createStrategyScheduler({ strategy: { status: () => ({ mode: 'v9', activation_seq: 2 }),
    recompute: () => { const error = new Error('stale'); error.code = 'input_changed'; throw error; } },
  logger: { warn() {} }, intervalMs: 60000, startupDelayMs: 60000 });
  const failed = failing.run();
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'input_changed');
  assert.equal(failing.getStatus().running, false);
  assert.equal(failing.getStatus().last.code, 'input_changed');
  assert.throws(() => createStrategyScheduler({ strategy: {} }), /策略调度器需要/);
});

test('cash change immediately before the completion write lock is rechecked inside the transaction', async t => {
  const { options, repository, store } = await setup(t);
  const wrapped = { ...store, complete: (lease, work) => {
    repository.saveAllocationSettings({ principal_override: 200 });
    return store.complete(lease, work);
  } };
  const service = createStrategyService({ ...options, strategyRepository: wrapped });
  assert.throws(() => service.recompute(), error => error.code === 'input_changed');
  assert.equal(store.watermark('strategy'), null);
});
