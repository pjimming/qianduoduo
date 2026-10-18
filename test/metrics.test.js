'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildWindows,
  buildReview,
  enrichRecords,
  gradeMonthReturn,
  summarize,
  windowRecords,
} = require('../lib/metrics');

const baseRecords = [
  {
    date: '2026-09-01',
    principal: 540000,
    daily_pnl: 54,
    action: '无操作',
    notes: '',
  },
  {
    date: '2026-09-02',
    principal: 540000,
    daily_pnl: -108,
    action: '无操作',
    notes: '债市调整',
  },
  {
    date: '2026-09-03',
    principal: 540000,
    daily_pnl: 81,
    action: '买入',
    notes: '',
  },
];

test('enrichRecords compounds returns and derives account value', () => {
  const enriched = enrichRecords(baseRecords);
  assert.equal(enriched[0].daily_return, 0.0001);
  assert.equal(enriched[0].net_value, 540054);
  assert.equal(enriched[1].cumulative_pnl, -54);
  assert.equal(enriched[1].net_value, 539946);
  assert.ok(enriched[1].drawdown < 0);
  assert.equal(enriched[2].net_value, 540027);
});

test('summarize reports total P&L, drawdown and target gap', () => {
  const enriched = enrichRecords(baseRecords);
  const summary = summarize(enriched, 3);
  assert.equal(summary.total_pnl, 27);
  assert.equal(summary.record_count, 3);
  assert.equal(summary.calendar_days, 3);
  assert.equal(summary.negative_days, 1);
  assert.ok(summary.max_drawdown_pct < 0);
  assert.equal(summary.sample_sufficient, false);
  assert.equal(summary.target_status, '样本不足');
  assert.ok(summary.annualized_pct !== null);
});

test('windowRecords and buildWindows use the latest calendar window', () => {
  const enriched = enrichRecords(baseRecords);
  const lastTwo = windowRecords(enriched, 2);
  assert.deepEqual(
    lastTwo.map((item) => item.date),
    ['2026-09-02', '2026-09-03'],
  );
  const windows = buildWindows(enriched);
  assert.equal(windows[7].record_count, 3);
  assert.equal(windows[30].record_count, 3);
});

test('monthly grades use the 0.16/0.20/0.25/0.30 thresholds', () => {
  assert.equal(gradeMonthReturn(0.1599), '不及格');
  assert.equal(gradeMonthReturn(0.16), '及格');
  assert.equal(gradeMonthReturn(0.20), '良好');
  assert.equal(gradeMonthReturn(0.25), '优秀');
  assert.equal(gradeMonthReturn(0.30), '卓越');
});

test('buildReview summarizes the latest day and monthly cumulative return', () => {
  const enriched = enrichRecords([
    ...baseRecords,
    {
      date: '2026-10-01',
      principal: 540000,
      daily_pnl: 1200,
      action: '无操作',
      notes: '',
    },
    {
      date: '2026-10-02',
      principal: 540000,
      daily_pnl: -200,
      action: '无操作',
      notes: '',
    },
  ]);
  const review = buildReview(enriched, '2026-10-02');
  assert.equal(review.current_month.month, '2026-10');
  assert.equal(review.current_month.pnl, 1000);
  assert.equal(review.current_month.avg_principal, 540000);
  assert.equal(review.current_month.return_pct, 0.185185);
  assert.equal(review.current_month.grade, '及格');
  assert.equal(review.current_month.provisional, true);
  assert.equal(review.daily.date, '2026-10-02');
  assert.equal(review.daily.month_pnl, 1000);
  assert.equal(review.daily.month_grade, '及格');
  assert.equal(review.monthly[0].month, '2026-10');
  assert.equal(review.monthly[1].month, '2026-09');
});
