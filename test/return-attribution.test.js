'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildHoldingAmountsByDate,
  buildWindows,
  enrichRecords,
} = require('../lib/metrics');
const {
  buildReturnAttribution,
} = require('../lib/return-attribution');

function isoDate(day) {
  return `2026-09-${String(day).padStart(2, '0')}`;
}

function buildRecords({
  days = 30,
  principal = 30000,
  dailyPnl = 2,
  trades = [],
} = {}) {
  const records = Array.from({ length: days }, (_, index) => ({
    date: isoDate(index + 1),
    principal,
    daily_pnl: dailyPnl,
    action: '无操作',
    notes: '',
  }));
  return enrichRecords(records, {
    holdingAmountsByDate: buildHoldingAmountsByDate(records, trades),
  });
}

function expectedBridgeEnd(attribution) {
  return attribution.components
    .filter((item) => item.included_in_bridge)
    .reduce(
      (sum, item) => sum + Number(item.amount || 0),
      Number(attribution.bridge.start_value || 0),
    );
}

test('return attribution ranks selection drag and closes the account bridge', () => {
  const trades = [
    {
      id: 1,
      trade_date: '2026-09-01',
      confirm_date: '2026-09-01',
      trade_type: 'buy',
      status: 'confirmed',
      product_code: 'P001',
      product_name: '测试产品',
      amount: 30000,
    },
  ];
  const records = buildRecords({ trades });
  const valuations = records.map((record) => ({
    yield_date: record.date,
    product_code: 'P001',
    product_name: '测试产品',
    daily_pnl: record.daily_pnl,
  }));
  const attribution = buildReturnAttribution({
    records,
    trades,
    products: [
      {
        code: 'P001',
        name: '测试产品',
        reference_yield_pct: 2,
        data_date: '2026-08-31',
      },
    ],
    valuations,
    windowSummary: buildWindows(records)[30],
    targetAnnualized: 3,
  });

  assert.equal(attribution.status, 'available');
  assert.equal(attribution.period.record_days, 30);
  assert.equal(attribution.period.missing_record_days, 0);
  assert.equal(attribution.product_evidence.reference_yield_complete, true);
  assert.equal(attribution.bridge.reconciled, true);
  assert.ok(Math.abs(attribution.actual.annualized_pct - 2.463099) < 0.00001);
  assert.ok(attribution.gap.annualized_pct < -0.53);
  const selection = attribution.components.find(
    (item) => item.key === 'product_selection',
  );
  assert.equal(selection.included_in_bridge, true);
  assert.ok(selection.amount < 0);
  assert.equal(attribution.main_drags[0].key, 'product_selection');
  assert.ok(
    Math.abs(expectedBridgeEnd(attribution) - attribution.actual.observed_period_pnl) <=
      0.01,
  );
  assert.equal(
    attribution.product_evidence.account_pnl,
    attribution.actual.observed_period_pnl,
  );
});

test('purchase wait, redemption wait and cash are separated without double counting', () => {
  const trades = [
    {
      id: 1,
      trade_date: '2026-08-31',
      confirm_date: '2026-08-31',
      trade_type: 'buy',
      status: 'confirmed',
      product_code: 'P001',
      product_name: '产品 A',
      amount: 30000,
    },
    {
      id: 2,
      trade_date: '2026-09-01',
      confirm_date: '2026-09-01',
      trade_type: 'redeem',
      status: 'confirmed',
      product_code: 'P001',
      product_name: '产品 A',
      amount: 3000,
      settlement_amount: 3000,
    },
    {
      id: 3,
      trade_date: '2026-09-02',
      confirm_date: '2026-09-04',
      trade_type: 'buy',
      status: 'confirmed',
      product_code: 'P002',
      product_name: '产品 B',
      amount: 3000,
    },
  ];
  const records = buildRecords({ days: 5, principal: 33000, dailyPnl: 0, trades });
  const attribution = buildReturnAttribution({
    records,
    trades,
    products: [
      {
        code: 'P001',
        name: '产品 A',
        reference_yield_pct: 3,
        data_date: '2026-08-31',
      },
      {
        code: 'P002',
        name: '产品 B',
        reference_yield_pct: 3,
        data_date: '2026-08-31',
      },
    ],
    valuations: [],
    settingsByCode: {
      P001: {
        redemption_days: 1,
        arrival_days: 1,
        purchase_confirm_days: 1,
        redemption_fee_bps: 10,
        purchase_fee_bps: 0,
        verified_at: '2026-08-31',
      },
      P002: {
        redemption_days: 1,
        arrival_days: 1,
        purchase_confirm_days: 1,
        redemption_fee_bps: 0,
        purchase_fee_bps: 5,
        verified_at: '2026-08-31',
      },
    },
    windowSummary: buildWindows(records)[30],
    targetAnnualized: 3,
  });

  assert.ok(attribution.deployment.purchase_wait_pnl < 0);
  assert.ok(attribution.deployment.redemption_wait_pnl < 0);
  assert.ok(attribution.deployment.cash_unclassified_pnl < 0);
  assert.equal(attribution.bridge.reconciled, true);
  assert.ok(
    Math.abs(expectedBridgeEnd(attribution) - attribution.actual.observed_period_pnl) <=
      0.01,
  );
  assert.equal(attribution.fee_estimate.included_in_bridge, false);
  assert.equal(attribution.fee_estimate.quality, 'verified_estimate');
  assert.equal(attribution.fee_estimate.amount, 4.5);
  assert.equal(attribution.tplus_evidence.available, true);
  assert.equal(attribution.tplus_evidence.product_count, 2);
  assert.equal(attribution.tplus_evidence.verified_product_count, 2);
});

test('missing reference yield is unavailable rather than zero-filled', () => {
  const trades = [
    {
      id: 1,
      trade_date: '2026-09-01',
      confirm_date: '2026-09-01',
      trade_type: 'buy',
      status: 'confirmed',
      product_code: 'P003',
      product_name: '无年化产品',
      amount: 30000,
    },
  ];
  const records = buildRecords({ days: 5, dailyPnl: 1.2, trades });
  const attribution = buildReturnAttribution({
    records,
    trades,
    products: [
      {
        code: 'P003',
        name: '无年化产品',
        reference_yield_pct: null,
        data_date: '2026-08-31',
      },
    ],
    valuations: records.map((record) => ({
      yield_date: record.date,
      product_code: 'P003',
      product_name: '无年化产品',
      daily_pnl: 1.2,
    })),
    windowSummary: buildWindows(records)[30],
    targetAnnualized: 3,
  });

  const selection = attribution.components.find(
    (item) => item.key === 'product_selection',
  );
  assert.equal(selection.amount, null);
  assert.equal(selection.included_in_bridge, false);
  assert.equal(selection.quality, 'unavailable');
  assert.equal(attribution.product_evidence.reference_yield_complete, false);
  assert.equal(
    attribution.product_evidence.products[0].reference_yield_pct,
    null,
  );
  assert.equal(attribution.bridge.reconciled, true);
});

test('product income remains a reconciliation source, not a second account total', () => {
  const trades = [
    {
      id: 1,
      trade_date: '2026-09-01',
      confirm_date: '2026-09-01',
      trade_type: 'buy',
      status: 'confirmed',
      product_code: 'P001',
      product_name: '测试产品',
      amount: 30000,
    },
  ];
  const records = buildRecords({ days: 5, dailyPnl: 2, trades });
  const accountPnl = records.reduce(
    (sum, record) => sum + record.daily_pnl,
    0,
  );
  const attribution = buildReturnAttribution({
    records,
    trades,
    products: [
      {
        code: 'P001',
        name: '测试产品',
        reference_yield_pct: 3,
        data_date: '2026-08-31',
      },
    ],
    valuations: [
      {
        yield_date: '2026-09-01',
        product_code: 'P001',
        product_name: '测试产品',
        daily_pnl: accountPnl + 100,
      },
    ],
    windowSummary: buildWindows(records)[30],
    targetAnnualized: 3,
  });

  assert.equal(attribution.product_evidence.account_pnl, accountPnl);
  assert.equal(attribution.product_evidence.recorded_product_pnl, accountPnl + 100);
  assert.equal(attribution.product_evidence.difference, 100);
  assert.equal(attribution.actual.observed_period_pnl, accountPnl);
  assert.equal(attribution.bridge.reconciled, true);
});

test('empty ledger returns an explicit insufficient attribution', () => {
  const attribution = buildReturnAttribution({ today: '2026-10-25' });
  assert.equal(attribution.status, 'insufficient');
  assert.equal(attribution.available, false);
  assert.equal(attribution.gap.annualized_pct, null);
  assert.equal(attribution.as_of_date, '2026-10-25');
  assert.match(attribution.headline, /至少两条收益记录/);
});
