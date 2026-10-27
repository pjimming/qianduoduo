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

  assert.equal(repository.getRecord('2026-10-20').daily_pnl, 2.02);
  const waiting =
    repository.productValuationStore.getReconciliationForDate('2026-10-20', {
      today: '2026-10-20',
    });
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.difference, null);
  assert.equal(waiting.max_yield_lag_days, 1);
  assert.equal(waiting.final_disclosure_date, '2026-10-21');
  assert.deepEqual(waiting.waiting_product_codes, ['120026A', '120056A']);

  const reconciliation =
    repository.productValuationStore.getReconciliationForDate('2026-10-20', {
      today: '2026-10-22',
    });
  assert.equal(reconciliation.product_pnl, 2.02);
  assert.equal(reconciliation.account_pnl, 2.02);
  assert.equal(reconciliation.difference, 0);
  assert.equal(reconciliation.is_final, true);
  assert.equal(reconciliation.expected_product_count, 2);
  assert.deepEqual(reconciliation.missing_product_codes, []);
  assert.equal(reconciliation.status, 'matched');

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
  const matched =
    repository.productValuationStore.getReconciliationForDate('2026-10-20', {
      today: '2026-10-22',
    });
  assert.equal(matched.product_pnl, 2.31);
  assert.equal(matched.difference, 0);
  assert.equal(matched.status, 'matched');
  assert.equal(repository.getRecord('2026-10-20').daily_pnl, 2.31);
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

test('product yield lag controls the final disclosure date and reporting window', (t) => {
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
  assert.equal(updated.reporting_lag_days, 2);
  assert.equal(updated.max_yield_lag_days, 2);
  assert.equal(updated.reporting_date, '2026-10-20');
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

test('reconciliation waits for max T+N, flags final product gaps, then closes after late completion', (t) => {
  const { repository } = openTemp(t);
  repository.initializeCapital(30000, '2026-10-01');
  createBuy(repository);
  createBuy(repository, {
    product_code: '120026A',
    product_name: '招银理财14天',
    amount: 3000,
    term_days: 14,
  });
  repository.productValuationStore.saveYieldSetting('120056A', {
    yield_lag_days: 2,
    source: 'app-rule',
    notes: '测试产品 T+2',
    verified_at: '2026-10-20',
  });
  repository.productValuationStore.upsertValuation({
    valuation_date: '2026-10-20',
    yield_date: '2026-10-20',
    product_code: '120056A',
    product_name: '招银理财90天',
    holding_amount: 6000,
    daily_pnl: 1,
  });

  const waiting =
    repository.productValuationStore.getReconciliationForDate('2026-10-20', {
      today: '2026-10-21',
    });
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.final_disclosure_date, '2026-10-22');
  assert.equal(waiting.difference, null);
  assert.deepEqual(waiting.missing_product_codes, ['120026A']);

  const finalDisclosureDay =
    repository.productValuationStore.getReconciliationForDate('2026-10-20', {
      today: '2026-10-22',
    });
  assert.equal(finalDisclosureDay.status, 'waiting');
  assert.equal(finalDisclosureDay.is_final, false);
  assert.deepEqual(finalDisclosureDay.waiting_product_codes, ['120026A']);

  const finalWithGap =
    repository.productValuationStore.getReconciliationForDate('2026-10-20', {
      today: '2026-10-23',
    });
  assert.equal(finalWithGap.status, 'missing-product-details');
  assert.equal(finalWithGap.difference, null);
  assert.deepEqual(finalWithGap.missing_product_codes, ['120026A']);

  repository.productValuationStore.upsertValuation({
    valuation_date: '2026-10-20',
    yield_date: '2026-10-20',
    product_code: '120026A',
    product_name: '招银理财14天',
    holding_amount: 3000,
    daily_pnl: 0.5,
  });
  const completed =
    repository.productValuationStore.getReconciliationForDate('2026-10-20', {
      today: '2026-10-23',
    });
  assert.equal(completed.status, 'matched');
  assert.deepEqual(completed.missing_product_codes, []);
  assert.equal(completed.difference, 0);
  assert.equal(repository.getRecord('2026-10-20').daily_pnl, 1.5);
});

test('reconciliation groups by income attribution date instead of screenshot date', (t) => {
  const { repository } = openTemp(t);
  repository.initializeCapital(30000, '2026-10-01');
  createBuy(repository);
  repository.productValuationStore.upsertValuation({
    valuation_date: '2026-10-22',
    yield_date: '2026-10-19',
    product_code: '120056A',
    product_name: '招银理财90天',
    holding_amount: 6000,
    daily_pnl: 1,
  });
  repository.productValuationStore.upsertValuation({
    valuation_date: '2026-10-22',
    yield_date: '2026-10-20',
    product_code: '120056A',
    product_name: '招银理财90天',
    holding_amount: 6000,
    daily_pnl: 2,
  });

  const items = repository.productValuationStore.getReconciliation({
    today: '2026-10-21',
  }).items;
  assert.deepEqual(
    items.map((item) => item.account_date),
    ['2026-10-20', '2026-10-19'],
  );
  assert.deepEqual(
    items.map((item) => item.yield_dates),
    [['2026-10-20'], ['2026-10-19']],
  );
});

test('historical reconciliation keeps products that were held on the yield date after redemption', (t) => {
  const { repository } = openTemp(t);
  repository.initializeCapital(30000, '2026-10-01');
  createBuy(repository);
  createBuy(repository, {
    product_code: '120026A',
    product_name: '招银理财14天',
    amount: 3000,
    term_days: 14,
  });
  repository.productValuationStore.upsertValuation({
    valuation_date: '2026-10-20',
    yield_date: '2026-10-20',
    product_code: '120026A',
    product_name: '招银理财14天',
    holding_amount: 3000,
    daily_pnl: 0.5,
  });
  createRedeem(repository, 6000, {
    trade_date: '2026-10-22',
    confirm_date: '2026-10-22',
  });

  const reconciliation =
    repository.productValuationStore.getReconciliationForDate('2026-10-20', {
      today: '2026-10-22',
    });
  assert.deepEqual(reconciliation.missing_product_codes, ['120056A']);
  assert.equal(reconciliation.expected_product_count, 2);
});

test('a product remains part of the yield-date holding set on its redemption confirmation date', (t) => {
  const { repository } = openTemp(t);
  repository.initializeCapital(30000, '2026-10-01');
  createBuy(repository);
  createBuy(repository, {
    product_code: '120026A',
    product_name: '招银理财14天',
    amount: 3000,
    term_days: 14,
  });
  repository.productValuationStore.upsertValuation({
    valuation_date: '2026-10-20',
    yield_date: '2026-10-20',
    product_code: '120026A',
    product_name: '招银理财14天',
    holding_amount: 3000,
    daily_pnl: 0.5,
  });
  createRedeem(repository, 6000, {
    trade_date: '2026-10-20',
    confirm_date: '2026-10-20',
  });

  const reconciliation =
    repository.productValuationStore.getReconciliationForDate('2026-10-20', {
      today: '2026-10-22',
    });
  assert.deepEqual(reconciliation.missing_product_codes, ['120056A']);
  assert.deepEqual(reconciliation.same_day_redeemed_product_codes, ['120056A']);
  assert.equal(reconciliation.expected_product_count, 2);
  assert.match(reconciliation.message, /赎回确认日.*是否计息/);
});

test('same-day partial redemptions are summed before marking a full redemption boundary', (t) => {
  const { repository } = openTemp(t);
  repository.initializeCapital(30000, '2026-10-01');
  createBuy(repository);
  createBuy(repository, {
    product_code: '120026A',
    product_name: '招银理财14天',
    amount: 3000,
    term_days: 14,
  });
  repository.productValuationStore.upsertValuation({
    yield_date: '2026-10-20',
    product_code: '120026A',
    product_name: '招银理财14天',
    daily_pnl: 0.5,
  });
  createRedeem(repository, 1000, {
    trade_date: '2026-10-20',
    confirm_date: '2026-10-20',
  });
  createRedeem(repository, 5000, {
    trade_date: '2026-10-20',
    confirm_date: '2026-10-20',
  });

  const reconciliation =
    repository.productValuationStore.getReconciliationForDate('2026-10-20', {
      today: '2026-10-22',
    });
  assert.deepEqual(reconciliation.same_day_redeemed_product_codes, [
    '120056A',
  ]);
});

test('a later merged update covers prior dates without duplicating account income', (t) => {
  const { repository } = openTemp(t);
  repository.initializeCapital(30000, '2026-10-01');
  createBuy(repository);
  createBuy(repository, {
    product_code: '120026A',
    product_name: '招银理财14天',
    amount: 3000,
    term_days: 14,
  });
  for (const date of ['2026-10-23', '2026-10-24', '2026-10-25']) {
    repository.productValuationStore.upsertValuation({
      yield_date: date,
      credit_date: date,
      product_code: '120056A',
      product_name: '招银理财90天',
      holding_amount: 6000,
      daily_pnl: 0.12,
    });
  }
  const merged = repository.productValuationStore.upsertValuation({
    yield_date: '2026-10-26',
    credit_date: '2026-10-26',
    product_code: '120026A',
    product_name: '招银理财14天',
    holding_amount: 3000,
    daily_pnl: 0.58,
    notes: '收益明细说明该次更新覆盖10月24日至26日。',
  });
  assert.deepEqual(merged.valuation.covered_yield_dates, [
    '2026-10-24',
    '2026-10-25',
    '2026-10-26',
  ]);

  for (const date of ['2026-10-24', '2026-10-25']) {
    const reconciliation =
      repository.productValuationStore.getReconciliationForDate(date, {
        today: '2026-10-28',
      });
    assert.equal(reconciliation.status, 'matched');
    assert.equal(reconciliation.covered_product_count, 2);
    assert.deepEqual(reconciliation.covered_product_codes, [
      '120026A',
      '120056A',
    ]);
    assert.deepEqual(reconciliation.covered_only_product_codes, ['120026A']);
    assert.deepEqual(reconciliation.missing_product_codes, []);
    assert.equal(reconciliation.product_pnl, 0.12);
    assert.equal(repository.getRecord(date).daily_pnl, 0.12);
  }
  const beforeCoverage =
    repository.productValuationStore.getReconciliationForDate('2026-10-23', {
      today: '2026-10-28',
    });
  assert.deepEqual(beforeCoverage.missing_product_codes, ['120026A']);
  assert.deepEqual(beforeCoverage.covered_only_product_codes, []);

  assert.equal(repository.getRecord('2026-10-26').daily_pnl, 0.58);

  const cleared = repository.productValuationStore.updateValuationById(
    merged.valuation.id,
    {
      notes: '用户撤回合并覆盖说明',
      clear_coverage: true,
    },
    {
      source: 'manual-correction',
      auditNote: '撤回错误的合并覆盖区间',
    },
  );
  assert.deepEqual(cleared.valuation.covered_yield_dates, []);
  assert.match(cleared.valuation.notes, /覆盖收益日期：无/);
  const reopened =
    repository.productValuationStore.getReconciliationForDate('2026-10-24', {
      today: '2026-10-28',
    });
  assert.equal(reopened.status, 'missing-product-details');
  assert.deepEqual(reopened.missing_product_codes, ['120026A']);
});

test('retrying a covered product fact without repeating coverage metadata stays idempotent', (t) => {
  const { repository } = openTemp(t);
  createBuy(repository, {
    product_code: '120026A',
    product_name: '招银理财14天',
    amount: 3000,
    term_days: 14,
  });
  const first = repository.productValuationStore.upsertValuation(
    {
      yield_date: '2026-10-26',
      product_code: '120026A',
      product_name: '招银理财14天',
      daily_pnl: 0.58,
      covered_yield_dates: [
        '2026-10-24',
        '2026-10-25',
        '2026-10-26',
      ],
    },
    { source: 'income-screenshot', screenshotId: 12 },
  );
  const auditCount = repository.productValuationStore.getProductAudit(
    '120026A',
  ).length;

  const retried = repository.productValuationStore.upsertValuation(
    {
      yield_date: '2026-10-26',
      product_code: '120026A',
      product_name: '招银理财14天',
      daily_pnl: 0.58,
    },
    { source: 'income-screenshot', screenshotId: 12 },
  );

  assert.equal(retried.unchanged, true);
  assert.equal(retried.valuation.id, first.valuation.id);
  assert.deepEqual(retried.valuation.covered_yield_dates, [
    '2026-10-24',
    '2026-10-25',
    '2026-10-26',
  ]);
  assert.equal(
    repository.productValuationStore.getProductAudit('120026A').length,
    auditCount,
  );
});

test('product income is stored and aggregated to cents without four-decimal precision', (t) => {
  const { repository } = openTemp(t);
  createBuy(repository);
  const saved = repository.productValuationStore.upsertValuation({
    yield_date: '2026-10-21',
    product_code: '120056A',
    product_name: '招银理财90天',
    holding_amount: 6000,
    daily_pnl: 1.2345,
  });

  assert.equal(saved.valuation.daily_pnl, 1.23);
  const summary = repository.productValuationStore
    .getSummaries('2026-10-22', repository.tradeStore.getPortfolio())
    .find((item) => item.product_code === '120056A');
  assert.equal(summary.cumulative_pnl, 1.23);
});
