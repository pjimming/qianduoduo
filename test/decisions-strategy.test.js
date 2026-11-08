'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { openScreeningRepository } = require('../server/modules/r2-screening/repository');
const { createStrategyRepository } = require('../server/modules/r2-strategy/repository');
const { createDecisionsRepository } = require('../server/modules/decisions/repository');
const { createDecisionsService } = require('../server/modules/decisions/service');
const { CONTRACT } = require('../server/modules/r2-strategy/contract');

async function setup(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'qdd-manual-v9-'));
  const dbPath = path.join(folder, 'ledger.sqlite'), screeningPath = path.join(folder, 'screen.sqlite');
  const repository = openDatabase({ dbPath, logger: { warn() {} } });
  t.after(() => { repository.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  openScreeningRepository(screeningPath, { initialize: true, ledgerPath: dbPath }).close();
  const { applyMigration } = await import('../scripts/migrate-r2-strategy.mjs');
  applyMigration({ dbPath, screeningPath, backupDir: path.join(folder, 'backups') });
  const store = createStrategyRepository(repository.db, { transactionManager: repository.transactionManager });
  store.transition({ operationKey: 'v9', expectedSeq: 0, mode: 'v9' });
  const service = createDecisionsService({ decisionsRepository: createDecisionsRepository(repository),
    transactionManager: repository.transactionManager, dashboardQuery: { projectDashboard: () => ({}) },
    automationRunner: { run: async () => {} }, todayProvider: () => '2026-11-07' });
  return { repository, store, service };
}
const body = () => ({ date: '2026-11-07', product_name: '人工事实', action: '买入', reason: '人工决策原因',
  expectation: '待证据校验', invalidation_condition: '公开证据变化', evidence_date: '2026-11-07', verify_date: '2026-12-07',
  strategy_version: 'r2-3pct-v1', bucket_plan: { short: 30, medium: 35, long: 35 },
  review_meta: { execution_snapshot: { forged: true }, evaluation_settings: { status: 'frozen', settings: {} } } });

test('manual creation under v9 records current unverified strategy without accepting a client-authored execution pass', async t => {
  const { service } = await setup(t);
  const { decision } = await service.createDecision(body());
  assert.equal(decision.strategy_version, CONTRACT.execution_version);
  assert.equal(decision.review_meta.manual_strategy_context.status, 'unverified');
  assert.equal(decision.review_meta.manual_strategy_context.activation_seq, 1);
  assert.equal(decision.review_meta.execution_snapshot, undefined);
  assert.equal(decision.review_meta.strategy_mode, 'actual_fact');
  assert.equal(decision.review_meta.evaluation_settings.status, 'historical_unfrozen');
});

test('editing a historical manual decision preserves its strategy after activation', async t => {
  const { repository, service } = await setup(t);
  const legacy = repository.createDecision({ ...body(), review_meta: {} });
  const { decision } = await service.updateDecision(legacy.id, { ...legacy, reason: '补充原始理由' });
  assert.equal(decision.strategy_version, 'r2-3pct-v1');
});

test('new unverified v9 manual decisions cannot be edited into legacy evaluation', async t => {
  const { service } = await setup(t);
  const { decision } = await service.createDecision(body());
  await assert.rejects(() => service.updateDecision(decision.id, { ...decision, strategy_version: 'r2-3pct-v1' }),
    error => error.statusCode === 409);
});

test('editing notes preserves large server evidence and refuses client-authored metadata replacement', async t => {
  const { repository, service } = await setup(t);
  const legacy = repository.createDecision({ ...body(), review_meta: { original_proof: 'x'.repeat(12000) } });
  const { decision } = await service.updateDecision(legacy.id, { ...legacy, reason: '补充原始理由',
    review_meta: { ...legacy.review_meta, execution_snapshot: { forged: true }, expected_legs: [] } });
  assert.equal(decision.reason, '补充原始理由');
  assert.equal(decision.review_meta.original_proof.length, 12000);
  assert.equal(decision.review_meta.execution_snapshot, undefined);
  assert.equal(decision.review_meta.expected_legs, undefined);
  assert.deepEqual(decision.review_meta.evaluation_settings, legacy.review_meta.evaluation_settings);
});
