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

test('weekly return distinguishes zero, negative, incomplete holding and disclosure gaps', () => {
  assert.deepEqual(calculate(mergedWeek.map((item) => ({ ...item, daily_pnl: 0 }))).weekly_by_code[code], {
    status: 'ready', annualized_pct: 0,
  });
  assert.ok(calculate(mergedWeek.map((item) => ({ ...item, daily_pnl: -1 }))).weekly_by_code[code].annualized_pct < 0);
  assert.equal(calculate(mergedWeek, [buy({ confirm_date: '2026-10-31' })]).weekly_by_code[code].status, 'short-holding');
  assert.equal(calculate(mergedWeek.slice(0, -1)).weekly_by_code[code].status, 'waiting');
  assert.equal(calculate(mergedWeek.slice(1)).weekly_by_code[code].status, 'missing');
  const weekendPolicy = { ...disclosure, reporting_date: '2026-11-01' };
  assert.equal(calculate(mergedWeek, [buy()], weekendPolicy, '2026-11-02').weekly_by_code[code].status, 'cross-boundary');
});

test('weekly return detects cross-boundary merges but accepts separately recorded weekend days', () => {
  const mondayPolicy = { ...disclosure, reporting_date: '2026-11-02' };
  const saturdayPolicy = { ...disclosure, reporting_date: '2026-11-07' };
  const pastWeek = ['2026-10-27', '2026-10-28', '2026-10-29'].map((date) => fact(date, 1));
  const splitWeek = [...pastWeek, fact(startDate, 1), fact('2026-10-31', 1), fact('2026-11-01', 1), fact('2026-11-02', 1)];
  assert.equal(calculate(splitWeek, [buy()], mondayPolicy).weekly_by_code[code].status, 'ready');

  const sundayToSaturday = [fact('2026-11-02', 3), ...['03', '04', '05', '06', '07'].map((day) => fact(`2026-11-${day}`, 1))];
  assert.equal(calculate(sundayToSaturday, [buy()], saturdayPolicy, '2026-11-08').weekly_by_code[code].status, 'cross-boundary');
  const splitOutside = [fact('2026-10-31', 1), fact('2026-11-01', 1), ...sundayToSaturday];
  assert.equal(calculate(splitOutside, [buy()], saturdayPolicy, '2026-11-08').weekly_by_code[code].status, 'ready');

  const explicit = fact('2026-11-02', 3, '覆盖收益日期：2026-10-31 至 2026-11-02');
  assert.equal(calculate([...splitOutside.filter((item) => item.yield_date !== '2026-11-02'), explicit], [buy()], saturdayPolicy, '2026-11-08').weekly_by_code[code].status, 'cross-boundary');
});
