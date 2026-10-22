'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');

function openTemp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-product-valuations-'));
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: null,
    logger: { warn() {} },
  });
  t.after(() => {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { repository, directory };
}

function createBuy(repository, overrides = {}) {
  return repository.tradeStore.createTrade({
    trade_date: '2026-10-01',
    confirm_date: '2026-10-01',
    trade_type: 'buy',
    status: 'confirmed',
    product_code: '120056A',
    product_name: '招银理财90天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 6000,
    term_days: 90,
    source: 'manual',
    notes: '',
    ...overrides,
  });
}

function createRedeem(repository, amount, overrides = {}) {
  return repository.tradeStore.createTrade({
    trade_date: '2026-10-21',
    confirm_date: '2026-10-21',
    trade_type: 'redeem',
    status: 'confirmed',
    product_code: '120056A',
    product_name: '招银理财90天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount,
    settlement_amount: amount,
    source: 'manual',
    notes: '',
    ...overrides,
  });
}

test('product valuations dedupe, reconcile, preserve history and audit corrections', (t) => {
  const { repository } = openTemp(t);
  repository.initializeCapital(30000, '2026-10-01');
  createBuy(repository);
  createBuy(repository, {
    product_code: '120026A',
    product_name: '招银理财14天',
    amount: 3000,
    term_days: 14,
  });

  const inserted = repository.productValuationStore.upsertMany(
    [
      {
        valuation_date: '2026-10-20',
        yield_date: '2026-10-20',
        product_code: '120056A',
        product_name: '招银理财90天',
        holding_amount: 6000,
        daily_pnl: 1.44,
        confidence: 95,
      },
      {
        valuation_date: '2026-10-20',
        yield_date: '2026-10-20',
        product_code: '120026A',
        product_name: '招银理财14天',
        holding_amount: 3000,
        daily_pnl: 0.58,
        confidence: 95,
      },
    ],
    { source: 'income-screenshot', screenshotId: 7 },
  );
  assert.equal(inserted.saved.length, 2);
  assert.equal(repository.productValuationStore.listValuations().length, 2);

  const repeated = repository.productValuationStore.upsertValuation(
    {
      yield_date: '2026-10-20',
      product_code: '120056A',
      daily_pnl: 1.44,
      holding_amount: 6000,
    },
    { source: 'income-screenshot', screenshotId: 7 },
  );
  assert.equal(repeated.valuation.id, inserted.saved.find((item) => item.product_code === '120056A').id);
  assert.equal(repository.productValuationStore.listValuations().length, 2);

  const conflicting = repository.productValuationStore.upsertValuation(
    {
      yield_date: '2026-10-20',
      product_code: '120056A',
      daily_pnl: 1.99,
      holding_amount: 6000,
    },
    { source: 'income-screenshot', screenshotId: 8 },
  );
  assert.equal(conflicting.conflict, 'different-daily-pnl');
  assert.equal(conflicting.valuation.daily_pnl, 1.44);
  assert.equal(repository.productValuationStore.listValuations().length, 2);

  repository.createRecord({
    date: '2026-10-20',
    daily_pnl: 2.31,
    action: '无操作',
    notes: '账户总收益',
  });
  const reconciliation =
    repository.productValuationStore.getReconciliationForDate('2026-10-20');
  assert.equal(reconciliation.product_pnl, 2.02);
  assert.equal(reconciliation.account_pnl, 2.31);
  assert.equal(reconciliation.difference, 0.29);
  assert.equal(reconciliation.status, 'mismatch');

  const firstId = inserted.saved.find(
    (item) => item.product_code === '120056A',
  ).id;
  const corrected = repository.productValuationStore.updateValuationById(
    firstId,
    {
      yield_date: '2026-10-20',
      credit_date: '2026-10-20',
      product_code: '120056A',
      daily_pnl: 1.73,
      holding_amount: 6000,
      notes: '截图金额修正',
    },
    {
      source: 'manual-correction',
      auditNote: '修正 120056A 当日收益',
    },
  );
  assert.equal(corrected.valuation.source, 'manual-correction');
  const audit = repository.productValuationStore.getProductAudit('120056A');
  assert.ok(audit.some((item) => item.note === '修正 120056A 当日收益'));

  createRedeem(repository, 2000);
  let summaries = repository.productValuationStore.getSummaries(
    '2026-10-21',
    repository.tradeStore.getPortfolio(),
  );
  const partial = summaries.find((item) => item.product_code === '120056A');
  assert.equal(partial.status, 'active');
  assert.equal(partial.active_amount, 4000);

  createRedeem(repository, 4000, {
    trade_date: '2026-10-22',
    confirm_date: '2026-10-22',
  });
  summaries = repository.productValuationStore.getSummaries(
    '2026-10-22',
    repository.tradeStore.getPortfolio(),
  );
  const redeemed = summaries.find((item) => item.product_code === '120056A');
  assert.equal(redeemed.status, 'redeemed');
  assert.equal(redeemed.active_amount, 0);
  assert.equal(redeemed.last_yield_date, '2026-10-20');
  assert.equal(
    repository.productValuationStore.listValuations({
      productCode: '120056A',
    }).length,
    1,
  );
});

test('product holding days start on the trade confirmation date', (t) => {
  const { repository } = openTemp(t);
  createBuy(repository, {
    trade_date: '2026-10-19',
    confirm_date: '2026-10-20',
  });
  repository.productValuationStore.upsertValuation({
    yield_date: '2026-10-20',
    product_code: '120056A',
    product_name: '招银理财90天',
    holding_amount: 6000,
    daily_pnl: 1.44,
  });

  const summary = repository.productValuationStore
    .getSummaries('2026-10-22', repository.tradeStore.getPortfolio())
    .find((item) => item.product_code === '120056A');
  assert.equal(summary.holding_start, '2026-10-20');
  assert.equal(summary.holding_end, '2026-10-22');
  assert.equal(summary.holding_days, 3);
});

test('explicit zero product yield is stored as a valid observation', (t) => {
  const { repository } = openTemp(t);
  createBuy(repository);
  repository.productValuationStore.upsertValuation({
    yield_date: '2026-10-21',
    credit_date: '2026-10-22',
    valuation_date: '2026-10-21',
    product_code: '120056A',
    product_name: '招银理财90天',
    holding_amount: 7501.44,
    daily_pnl: 0,
    notes: '用户明确确认当日无收益',
  });

  const summary = repository.productValuationStore
    .getSummaries('2026-10-22', repository.tradeStore.getPortfolio())
    .find((item) => item.product_code === '120056A');
  assert.equal(summary.observed_days, 1);
  assert.equal(summary.cumulative_pnl, 0);
  assert.equal(summary.latest_daily_pnl, 0);
  assert.equal(summary.negative_days, 0);
});

test('product yield lag is stored as reference without changing the disclosure date', (t) => {
  const { repository } = openTemp(t);
  createBuy(repository, {
    product_code: '120026A',
    product_name: '招银理财14天',
    amount: 3000,
    term_days: 14,
  });

  const initial = repository.productValuationStore.getDisclosurePolicy(
    '2026-10-22',
    repository.tradeStore.getPortfolio(),
  );
  assert.equal(initial.reporting_lag_days, 1);
  assert.equal(initial.reporting_date, '2026-10-21');
  assert.deepEqual(initial.unverified_product_codes, ['120026A']);

  const setting = repository.productValuationStore.saveYieldSetting(
    '120026A',
    {
      yield_lag_days: 2,
      source: 'app-rule',
      notes: '招行 App：收益 T+2 到账',
      verified_at: '2026-10-22',
    },
  );
  assert.equal(setting.yield_lag_days, 2);
  assert.equal(setting.verified, true);

  const updated = repository.productValuationStore.getDisclosurePolicy(
    '2026-10-22',
    repository.tradeStore.getPortfolio(),
  );
  assert.equal(updated.reporting_lag_days, 1);
  assert.equal(updated.reporting_date, '2026-10-21');
  assert.deepEqual(updated.unverified_product_codes, []);

  repository.productValuationStore.upsertValuation({
    valuation_date: '2026-10-20',
    credit_date: '2026-10-20',
    yield_date: '2026-10-20',
    product_code: '120026A',
    product_name: '招银理财14天',
    holding_amount: 3000,
    daily_pnl: 0.6,
  });
  const detail = repository.productValuationStore.getProductDetail(
    '120026A',
    '2026-10-22',
  );
  assert.equal(detail.yield_setting.source, 'app-rule');
  assert.equal(detail.summary.yield_lag_days, 2);
  assert.equal(detail.summary.expected_latest_yield_date, '2026-10-20');
});
