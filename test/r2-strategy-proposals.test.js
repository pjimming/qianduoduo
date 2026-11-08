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
const { createStrategyProposalRepository } = require('../server/modules/r2-strategy/proposal-repository');
const { evaluateStrategy } = require('../server/modules/r2-strategy/engine');
const { verifyExecutionSnapshot } = require('../server/modules/r2-strategy/snapshot');
const { CONTRACT } = require('../server/modules/r2-strategy/contract');
const { strategyFixture } = require('./fixtures/r2-strategy.cjs');
const { createTradesRepository } = require('../server/modules/trades/repository');
const { createTradeExecutionReconciler } = require('../server/modules/r2-strategy/trade-execution');
const { evaluatePrediction } = require('../lib/decision-calibration');

async function setup(t, mode = 'v9') {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'qdd-v9-proposals-'));
  let repository;
  t.after(() => { repository?.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  const dbPath = path.join(folder, 'ledger.sqlite'), screeningPath = path.join(folder, 'public.sqlite');
  repository = openDatabase({ dbPath, logger: { warn() {} } }); repository.initializeCapital(100, '2026-11-07');
  openScreeningRepository(screeningPath, { ledgerPath: dbPath, initialize: true }).close();
  const { applyMigration } = await import('../scripts/migrate-r2-strategy.mjs');
  applyMigration({ dbPath, screeningPath, backupDir: path.join(folder, 'backups') });
  const store = createStrategyRepository(repository.db, { transactionManager: repository.transactionManager });
  store.transition({ operationKey: 'test', expectedSeq: 0, mode });
  const fixture = strategyFixture();
  for (const mapping of fixture.mappings) store.appendMapping({ ...mapping, expected_seq: 1 });
  for (const check of fixture.checks) store.appendCheck({ mappingId: check.mapping_id, facts: check.facts,
    verifiedBy: check.verified_by, verifiedAt: check.verified_at, expectedSeq: 1 });
  const strategy = createStrategyService({ repository, strategyRepository: store, todayProvider: () => fixture.date,
    screening: { executionSnapshot: () => fixture.sourceSnapshot } });
  const options = { repository, strategy, strategyRepository: store };
  return { repository, fixture, store, strategy, options, service: createStrategyProposalService(options) };
}

test('generation freezes one auditable proposal per selected share and never creates transactions or decisions', async t => {
  const { repository, service } = await setup(t);
  const result = service.generate();
  assert.equal(result.created.length, 5);
  const sum = result.created.reduce((total, row) => total + row.proposal.amount, 0);
  assert.equal(sum, 100);
  for (const row of result.created) {
    assert.equal(row.proposal.status, 'pending');
    assert.equal(row.proposal.yield_policy_version, CONTRACT.yield_policy_version);
    assert.equal(row.proposal.payload.execution_version, CONTRACT.execution_version);
    assert.equal(verifyExecutionSnapshot(row.proposal.payload.snapshot), true);
    assert.equal(row.proposal.payload.snapshot.portfolio.principal_cents, 10000);
    assert.ok(row.proposal.amount <= 30);
  }
  assert.equal(repository.listDecisions().length, 0);
  assert.equal(repository.tradeStore.listTrades().length, 0);
});
test('repeated generation returns the same committed objects rather than duplicate drafts', async t => {
  const { service } = await setup(t);
  const first = service.generate(), second = service.generate();
  assert.deepEqual(second.created.map(row => row.proposal.id), first.created.map(row => row.proposal.id));
  assert.ok(second.created.every(row => row.existing));
});
test('new published context supersedes pending drafts but preserves their original frozen evidence', async t => {
  const { service, fixture, repository } = await setup(t);
  const first = service.generate();
  const before = first.created[0].proposal.payload.snapshot;
  fixture.sourceSnapshot.run.id = 2;
  const second = service.generate();
  assert.notEqual(second.created[0].proposal.id, first.created[0].proposal.id);
  const previous = repository.decisionProposalStore.getProposal(first.created[0].proposal.id);
  assert.equal(previous.status, 'expired');
  assert.deepEqual(previous.payload.snapshot, before);
  assert.equal(verifyExecutionSnapshot(previous.payload.snapshot), true);
});
test('shadow and legacy modes cannot write formal proposals', async t => {
  for (const mode of ['shadow', 'legacy']) {
    const { service, repository } = await setup(t, mode);
    assert.throws(() => service.generate(), error => error.code === 'recommendation_disabled');
    assert.equal(repository.db.prepare('SELECT count(*) n FROM decision_proposals').get().n, 0);
  }
});
test('incomplete asset review can retain a simulation but creates no formal proposal', async t => {
  const { service, store, repository } = await setup(t);
  for (const check of store.currentChecks()) store.appendCheck({ mappingId: check.mapping_id, supersedesId: check.id,
    facts: { ...check.facts, status: 'pending' }, verifiedBy: 'fixture', verifiedAt: check.verified_at, expectedSeq: 1 });
  assert.deepEqual(service.generate().created, []);
  assert.equal(repository.db.prepare('SELECT count(*) n FROM decision_proposals').get().n, 0);
});
test('mid-batch write failure rolls back every proposal in the business transaction', async t => {
  const { repository, service } = await setup(t);
  const original = repository.db.prepare.bind(repository.db);
  let inserts = 0;
  t.mock.method(repository.db, 'prepare', sql => {
    if (sql.includes('INSERT INTO decision_proposals') && ++inserts === 2) throw new Error('injected proposal failure');
    return original(sql);
  });
  assert.throws(() => service.generate(), /injected proposal failure/);
  assert.equal(original('SELECT count(*) n FROM decision_proposals').get().n, 0);
});
test('source and account changes during preparation reject stale generated amounts', async t => {
  const { options, fixture, repository } = await setup(t);
  const changed = createStrategyProposalService({ ...options, evaluate: input => {
    const result = evaluateStrategy(input); fixture.sourceSnapshot.run.id++; return result;
  } });
  assert.throws(() => changed.generate(), error => error.code === 'input_changed');
  assert.equal(repository.db.prepare('SELECT count(*) n FROM decision_proposals').get().n, 0);
});
test('proposal adapter refuses writes outside the owning use-case transaction', async t => {
  const { repository } = await setup(t);
  const adapter = createStrategyProposalRepository(repository);
  assert.throws(() => adapter.create({}), /业务事务/);
  assert.throws(() => adapter.accept(1, 1), /业务事务/);
});

test('same portfolio plan can be adopted share by share, freezing the new whole-portfolio denominator and reserving once', async t => {
  const { repository, service, store } = await setup(t);
  const generated = service.generate();
  const accepted = generated.created.map(row => service.adopt(row.proposal.id));
  assert.equal(accepted.length, 5);
  assert.equal(store.reservedCents(), 10000);
  assert.equal(store.reservations().length, 5);
  assert.equal(repository.listDecisions().length, 5);
  for (const result of accepted) {
    assert.equal(result.decision.strategy_version, CONTRACT.execution_version);
    assert.equal(result.proposal.status, 'accepted');
    assert.equal(verifyExecutionSnapshot(result.decision.review_meta.execution_snapshot), true);
    assert.equal(result.decision.review_meta.execution_snapshot.portfolio.principal_cents, 10000);
    assert.equal(result.decision.review_meta.predictions[0].evaluation.method, 'v9_frozen_net_pnl');
  }
  const repeated = service.adopt(generated.created[0].proposal.id);
  assert.equal(repeated.decision.id, accepted[0].decision.id);
  assert.equal(repeated.existing, true);
  assert.equal(store.reservedCents(), 10000);
  assert.equal(repository.tradeStore.listTrades().length, 0);
});
test('a new batch, changed cash, or changed activation blocks adoption without creating a decision', async t => {
  const { repository, service, fixture, store } = await setup(t);
  const proposal = service.generate().created[0].proposal;
  fixture.sourceSnapshot.run.id = 2;
  assert.throws(() => service.adopt(proposal.id), error => error.code === 'proposal_revalidation_failed');
  fixture.sourceSnapshot.run.id = 1;
  repository.saveAllocationSettings({ principal_override: 200 });
  assert.throws(() => service.adopt(proposal.id), error => error.code === 'input_changed');
  store.transition({ expectedSeq: 1, operationKey: 'pause', mode: 'suspended' });
  assert.throws(() => service.adopt(proposal.id), error => error.code === 'activation_changed');
  assert.equal(repository.listDecisions().length, 0);
  assert.equal(store.reservedCents(), 0);
});
test('reservation failure rolls back accepted status, decision, forecast and its financial audit together', async t => {
  const { repository, service, store } = await setup(t);
  const proposal = service.generate().created[0].proposal;
  t.mock.method(store, 'reserve', () => { throw new Error('injected reservation failure'); });
  assert.throws(() => service.adopt(proposal.id), /injected reservation failure/);
  assert.equal(repository.decisionProposalStore.getProposal(proposal.id).status, 'pending');
  assert.equal(repository.listDecisions().length, 0);
  assert.equal(store.reservedCents(), 0);
});
test('legacy adoption method cannot bypass execution contract revalidation', async t => {
  const { repository, service, fixture } = await setup(t);
  const proposal = service.generate().created[0].proposal;
  assert.throws(() => repository.decisionProposalStore.adoptProposal(proposal.id, { today: fixture.date }), /统一策略复核/);
  assert.equal(repository.listDecisions().length, 0);
});

test('cancelling an accepted but unexecuted proposal releases its balance once and keeps the frozen decision evidence', async t => {
  const { repository, service, store } = await setup(t);
  const proposal = service.generate().created[0].proposal;
  const accepted = service.adopt(proposal.id);
  const before = accepted.decision.review_meta.execution_snapshot;
  assert.ok(store.reservedCents() > 0);
  assert.equal(service.reject(proposal.id, { reason: 'fixture cancel' }).proposal.status, 'rejected');
  assert.equal(store.reservedCents(), 0);
  assert.equal(service.reject(proposal.id, { reason: 'fixture cancel' }).existing, true);
  assert.deepEqual(repository.listDecisions()[0].review_meta.execution_snapshot, before);
  assert.throws(() => repository.decisionProposalStore.rejectProposal(proposal.id, {}), /统一策略服务/);
});
test('v9 and shadow projection cannot silently regenerate legacy-score proposals', async t => {
  const { repository } = await setup(t, 'shadow');
  repository.decisionProposalStore.sync({ meta: { today: '2026-11-07' }, workspace: {}, products: {
    allocation: { available_cash: 10000 }, watchlist: [{ selected: true, target_amount: 10000, code: 'OLD', name: 'legacy',
      allocation_bucket: 'short', term_days: 30, selection_score: 999, reference_yield_pct: 9, reference_yield_status: 'available' }] } });
  assert.equal(repository.db.prepare('SELECT count(*) n FROM decision_proposals').get().n, 0);
});

test('partial confirmed bank fills update reservation and proposal progress in the same factual transaction', async t => {
  const { repository, service, store, fixture } = await setup(t);
  repository.tradeStore.setExecutionReconciler(createTradeExecutionReconciler({ repository, strategyRepository: store }));
  const proposal = service.generate().created[0].proposal;
  const adopted = service.adopt(proposal.id);
  const trades = createTradesRepository(repository);
  const first = trades.createTrade({ trade_date: fixture.date, confirm_date: fixture.date, trade_type: 'buy', status: 'confirmed',
    product_code: proposal.product_code, product_name: proposal.product_name, amount: 5, term_days: 30,
    decision_id: adopted.decision.id, source: 'manual', dedupe_key: 'partial-one' }, 'fixture', fixture.date);
  assert.equal(first.amount, 5);
  assert.equal(store.reservedCents(), 2500);
  assert.equal(repository.listDecisions()[0].review_meta.execution_status, 'partial');
  assert.equal(repository.decisionProposalStore.getProposal(proposal.id).status, 'accepted');
  assert.equal(repository.listDecisions()[0].review_meta.execution_progress[0].confirmed_cents, 500);
  assert.throws(() => service.reject(proposal.id), error => error.code === 'execution_exists');
  assert.equal(store.reservedCents(), 2500);
  trades.createTrade({ trade_date: fixture.date, confirm_date: fixture.date, trade_type: 'buy', status: 'confirmed',
    product_code: proposal.product_code, product_name: proposal.product_name, amount: 25, term_days: 30,
    decision_id: adopted.decision.id, source: 'manual', dedupe_key: 'partial-two' }, 'fixture', fixture.date);
  assert.equal(store.reservedCents(), 0);
  assert.equal(repository.decisionProposalStore.getProposal(proposal.id).status, 'confirmed');
  assert.equal(repository.listDecisions()[0].review_meta.execution_status, 'confirmed');
  assert.equal(verifyExecutionSnapshot(repository.listDecisions()[0].review_meta.execution_snapshot), true);
});
test('partial confirmed fills can cancel only the unexecuted balance and keep the executed decision', async t => {
  const { repository, service, store, fixture } = await setup(t);
  repository.tradeStore.setExecutionReconciler(createTradeExecutionReconciler({ repository, strategyRepository: store }));
  const proposal = service.generate().created[0].proposal;
  const adopted = service.adopt(proposal.id);
  const trades = createTradesRepository(repository);
  trades.createTrade({ trade_date: fixture.date, confirm_date: fixture.date, trade_type: 'buy', status: 'confirmed',
    product_code: proposal.product_code, product_name: proposal.product_name, amount: 5, term_days: 30,
    decision_id: adopted.decision.id, source: 'manual', dedupe_key: 'cancel-remaining-one' }, 'fixture', fixture.date);
  assert.equal(store.reservedCents(), 2500);
  const cancelled = service.cancelRemaining(proposal.id, { reason: '用户取消剩余' });
  assert.equal(cancelled.released_cents, 2500);
  assert.equal(cancelled.remaining_cents, 2500);
  assert.equal(store.reservedCents(), 0);
  const decision = repository.listDecisions()[0];
  assert.equal(decision.review_meta.lifecycle_status, 'accepted');
  assert.equal(decision.review_meta.execution_status, 'partial_cancelled');
  assert.equal(decision.review_meta.remaining_cancelled_cents, 2500);
  assert.equal(decision.review_meta.remaining_cancelled_reason, '用户取消剩余');
  assert.equal(repository.tradeStore.listTrades().length, 1);
  assert.equal(repository.decisionProposalStore.getProposal(proposal.id).status, 'accepted');
  const again = service.cancelRemaining(proposal.id, {});
  assert.equal(again.existing, true);
  assert.equal(again.released_cents, 0);
  assert.equal(store.reservedCents(), 0);
});
test('over-execution is preserved as actual money and recorded as a deviation rather than discarded', async t => {
  const { repository, service, store, fixture } = await setup(t);
  repository.tradeStore.setExecutionReconciler(createTradeExecutionReconciler({ repository, strategyRepository: store }));
  const proposal = service.generate().created[0].proposal;
  const adopted = service.adopt(proposal.id), trades = createTradesRepository(repository);
  const actual = trades.createTrade({ trade_date: fixture.date, confirm_date: fixture.date, trade_type: 'buy', status: 'confirmed',
    product_code: proposal.product_code, product_name: proposal.product_name, amount: 40, term_days: 30,
    decision_id: adopted.decision.id, source: 'manual' }, 'fixture', fixture.date);
  assert.equal(actual.amount, 40);
  assert.equal(store.reservedCents(), 0);
  assert.equal(repository.listDecisions()[0].review_meta.execution_status, 'deviation');
  assert.equal(repository.listDecisions()[0].review_meta.execution_deviation.excess[0].excess_cents, 1000);
});

test('reconciling a later bank fact never reopens the balance cancelled after a partial fill', async t => {
  const { repository, service, store, fixture } = await setup(t);
  repository.tradeStore.setExecutionReconciler(createTradeExecutionReconciler({ repository, strategyRepository: store }));
  const proposal = service.generate().created[0].proposal;
  const adopted = service.adopt(proposal.id), trades = createTradesRepository(repository);
  const trade = trades.createTrade({ trade_date: fixture.date, confirm_date: fixture.date, trade_type: 'buy', status: 'confirmed',
    product_code: proposal.product_code, product_name: proposal.product_name, amount: 5, term_days: 30,
    decision_id: adopted.decision.id, source: 'manual', dedupe_key: 'cancel-reconcile-one' }, 'fixture', fixture.date);
  service.cancelRemaining(proposal.id);
  const reconcile = createTradeExecutionReconciler({ repository, strategyRepository: store });
  repository.transactionManager.run(() => reconcile({ trade, decision: repository.listDecisions()[0] }));
  assert.equal(store.reservedCents(), 0);
  assert.equal(repository.listDecisions()[0].review_meta.execution_status, 'partial_cancelled');
  // A late bank fact is still recorded, without reserving the cancelled rest.
  trades.createTrade({ trade_date: fixture.date, confirm_date: fixture.date, trade_type: 'buy', status: 'confirmed',
    product_code: proposal.product_code, product_name: proposal.product_name, amount: 2, term_days: 30,
    decision_id: adopted.decision.id, source: 'manual', dedupe_key: 'cancel-reconcile-two' }, 'fixture', fixture.date);
  assert.equal(store.reservedCents(), 0);
  assert.equal(store.reservations()[0].executed_cents, 700);
  assert.equal(store.reservations()[0].released_cents, 2300);
});
test('factual-write failure after reservation reconciliation rolls back the trade, lot and all projection changes', async t => {
  const { repository, service, store, fixture } = await setup(t);
  const proposal = service.generate().created[0].proposal;
  const adopted = service.adopt(proposal.id), trades = createTradesRepository(repository);
  const real = createTradeExecutionReconciler({ repository, strategyRepository: store });
  repository.tradeStore.setExecutionReconciler(input => { real(input); throw new Error('injected after fact reconciliation'); });
  assert.throws(() => trades.createTrade({ trade_date: fixture.date, confirm_date: fixture.date, trade_type: 'buy', status: 'confirmed',
    product_code: proposal.product_code, product_name: proposal.product_name, amount: 5, term_days: 30,
    decision_id: adopted.decision.id, source: 'manual' }, 'fixture', fixture.date), /injected after fact/);
  assert.equal(repository.tradeStore.listTrades().length, 0);
  assert.equal(repository.tradeStore.getPortfolio().length, 0);
  assert.equal(store.reservedCents(), 3000);
  assert.equal(repository.decisionProposalStore.getProposal(proposal.id).status, 'accepted');
});

test('new execution records never fall through to legacy global hurdles or the legacy annualized prediction formula', async t => {
  const { repository, service, store, fixture } = await setup(t);
  repository.tradeStore.setExecutionReconciler(createTradeExecutionReconciler({ repository, strategyRepository: store }));
  const proposal = service.generate().created[0].proposal, adopted = service.adopt(proposal.id);
  const trades = createTradesRepository(repository);
  trades.createTrade({ trade_date: fixture.date, confirm_date: fixture.date, trade_type: 'buy', status: 'confirmed',
    product_code: proposal.product_code, product_name: proposal.product_name, amount: proposal.amount, term_days: 30,
    decision_id: adopted.decision.id, source: 'manual' }, 'fixture', fixture.date);
  repository.automationStore.updateSettings({ hurdle_short: 99, hurdle_medium: 99, hurdle_long: 99 });
  repository.automationStore.runCycle({ today: '2027-06-01', trigger: 'fixture' });
  const runs = repository.automationStore.listRuns(100).filter(row => row.decision_id === adopted.decision.id);
  assert.equal(runs.some(row => row.rule_version === 'r2-eval-v2'), false);
  const decision = repository.listDecisions().find(row => row.id === adopted.decision.id);
  const result = evaluatePrediction({ prediction: decision.review_meta.predictions[0], decision,
    trades: repository.tradeStore.listTrades(), valuations: [], today: '2027-06-01' });
  // 冻结契约下成交确认日（2026-11-07）与冻结预测的确认日（2026-11-09）不一致，
  // 比较期已经改变，只能终止评价；不得改用实际区间或旧年化公式补算。
  assert.equal(result.status, 'invalidated');
  assert.equal(result.reason_code, 'comparison_period_changed');
});

test('holding switch binding validates both legs and supports partial fills from earlier persisted plan snapshots', () => {
  const { assertTradeStrategyBinding } = require('../lib/trade-strategy-binding');
  const decision = { id: 7, action: '切换', strategy_version: CONTRACT.execution_version,
    review_meta: { execution_snapshot: { kind: 'holding_switch', plan: { execution_version: CONTRACT.execution_version } },
      expected_legs: [{ side: 'redeem', product_code: 'A', amount: 100 }, { side: 'buy', product_code: 'B', amount: 100 }] } };
  const trade = { id: 9, decision_id: 7, trade_type: 'switch', product_code: 'A', target_product_code: 'B', amount: 5 };
  const check = patch => assertTradeStrategyBinding({ trade: { ...trade, ...patch }, decisions: [decision], decisionProposalStore: {} });
  assert.equal(check({}).id, 7);
  assert.equal(check({ trade_type: 'redeem' }).id, 7);
  assert.throws(() => check({ target_product_code: 'WRONG' }), error => error.code === 'STRATEGY_BINDING_INVALID');
  assert.throws(() => check({ product_code: 'WRONG' }), error => error.code === 'STRATEGY_BINDING_INVALID');
});
