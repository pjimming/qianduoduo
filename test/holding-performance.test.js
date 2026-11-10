'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildHoldingPerformance } = require('../server/modules/dashboard/holding-performance');
const { effectiveCoveredYieldDates } = require('../lib/product-income-coverage');

const code = '120056A';
const endDate = '2026-11-05';
const startDate = '2026-10-30';
const today = '2026-11-06';
const disclosure = { reporting_date: endDate, default_yield_lag_days: 1, products: [] };

function buy(overrides = {}) {
  return {
    id: 1,
    product_code: code,
    trade_type: 'buy',
    trade_date: '2026-10-01',
    confirm_date: '2026-10-02',
    status: 'confirmed',
    amount: 10000,
    ...overrides,
  };
}

function fact(date, pnl, notes = '') {
  return {
    product_code: code,
    yield_date: date,
    daily_pnl: pnl,
    covered_yield_dates: effectiveCoveredYieldDates(notes, date),
    notes,
  };
}

function calculate(valuations, trades = [buy()], policy = disclosure, now = today) {
  return buildHoldingPerformance([{ product_code: code }], trades, valuations, policy, now);
}

const mergedWeek = [
  fact(startDate, 1),
  fact('2026-11-02', 3),
  fact('2026-11-03', 1),
  fact('2026-11-04', 1),
  fact(endDate, 1),
];

test('weekly return uses confirmed daily principal and counts a merged weekend only once', () => {
  const result = calculate(mergedWeek, [
    buy(),
    buy({ id: 2, trade_date: startDate, confirm_date: '2026-11-02', amount: 5000 }),
    buy({ id: 3, trade_type: 'redeem', confirm_date: '2026-11-04', amount: 4000 }),
    buy({ id: 4, status: 'pending', confirm_date: null }),
  ]);
  assert.equal(result.start_date, startDate);
  assert.equal(result.end_date, endDate);
  assert.deepEqual(result.weekly_by_code[code], {
    status: 'ready',
    record_count: 5,
    start_date: startDate,
    end_date: endDate,
    annualized_pct: (7 / (3 * 10000 + 2 * 15000 + 2 * 11000)) * 365 * 100,
  });
});

test('weekly return treats a confirmed switch as a source redemption and target buy', () => {
  const otherCode = '120026A';
  const result = buildHoldingPerformance(
    [{ product_code: code }, { product_code: otherCode }],
    [
      buy(),
      buy({ id: 2, product_code: otherCode }),
      buy({ id: 3, trade_type: 'switch', confirm_date: '2026-11-02', amount: 5000, target_product_code: otherCode, settlement_amount: 5010 }),
    ],
    [...mergedWeek, ...mergedWeek.map((item) => ({ ...item, product_code: otherCode }))],
    disclosure,
    today,
  );
  assert.equal(result.weekly_by_code[code].annualized_pct, (7 / 50000) * 365 * 100);
  assert.equal(result.weekly_by_code[otherCode].annualized_pct, (7 / 90040) * 365 * 100);
});


test('uses at most seven latest facts per product even with gaps and different cutoffs', () => {
  const otherCode = '120026A';
  const facts = ['01', '03', '06', '07', '08', '09', '10', '13'].map((day) =>
    fact(`2026-10-${day}`, day === '01' ? 500 : 1),
  );
  const result = buildHoldingPerformance(
    [{ product_code: code }, { product_code: otherCode }],
    [buy(), buy({ id: 2, product_code: otherCode, confirm_date: today })],
    [facts[4], ...facts.slice(0, 4), ...facts.slice(5),
      { ...fact(today, 2), product_code: otherCode },
      { ...fact('2026-11-07', 100), product_code: otherCode }],
    disclosure,
    today,
  );
  assert.deepEqual(result.weekly_by_code[code], {
    status: 'ready',
    record_count: 7,
    start_date: '2026-10-03',
    end_date: '2026-10-13',
    annualized_pct: (7 / 70000) * 365 * 100,
  });
  assert.deepEqual(result.weekly_by_code[otherCode], {
    status: 'ready',
    record_count: 1,
    start_date: today,
    end_date: today,
    annualized_pct: (2 / 10000) * 365 * 100,
  });
});

test('preserves zero and negative returns and leaves empty samples unavailable', () => {
  assert.equal(calculate([fact(endDate, 0)]).weekly_by_code[code].annualized_pct, 0);
  assert.ok(calculate([fact(endDate, -1)]).weekly_by_code[code].annualized_pct < 0);
  assert.deepEqual(calculate([]).weekly_by_code[code], {
    status: 'missing', annualized_pct: null, record_count: 0,
  });
  assert.equal(calculate([fact(endDate, 1)], []).weekly_by_code[code].annualized_pct, null);
});

test('separate weekend facts outside the sample supersede inferred Monday coverage', () => {
  const facts = [
    fact('2026-10-31', 1), fact('2026-11-01', 1), fact('2026-11-02', 1),
    ...['03', '04', '05', '06', '07', '08'].map((day) => fact(`2026-11-${day}`, 1)),
  ];
  const estimate = calculate(facts, [buy()], disclosure, '2026-11-09').weekly_by_code[code];
  assert.equal(estimate.start_date, '2026-11-02');
  assert.equal(estimate.annualized_pct, (7 / 70000) * 365 * 100);
});
