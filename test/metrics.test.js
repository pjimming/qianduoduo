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

test('empty ledger still exposes the current month, missing dates and next action', () => {
  const review = buildReview([], '2026-10-19');
  assert.equal(review.daily, null);
  assert.equal(review.weekly, null);
  assert.equal(review.current_month.month, '2026-10');
  assert.equal(review.current_month.has_records, false);
  assert.equal(review.current_month.record_days, 0);
  assert.equal(review.current_month.elapsed_days, 19);
  assert.equal(review.current_month.days_remaining, 12);
  assert.equal(review.current_month.missing_dates.length, 19);
  assert.equal(review.current_month.records_needed_for_grade, 20);
  assert.equal(review.current_month.score_status, 'no_records');
  assert.equal(review.monthly.length, 1);
  assert.ok(review.alerts.some((item) => item.code === 'no-month-records'));
});

test('T+1 reporting cutoff excludes today from missing-day calculations', () => {
  const rows = [];
  for (let day = 1; day <= 18; day += 1) {
    rows.push({
      date: `2026-10-${String(day).padStart(2, '0')}`,
      principal: 30000,
      daily_pnl: 1,
      action: '无操作',
      notes: '',
    });
  }
  const review = buildReview(enrichRecords(rows), '2026-10-20', {
    reportingDate: '2026-10-19',
  });
  assert.equal(review.reporting_date, '2026-10-19');
  assert.equal(review.current_month.elapsed_days, 19);
  assert.equal(review.current_month.missing_days, 1);
  assert.deepEqual(review.current_month.missing_dates, ['2026-10-19']);
  assert.ok(!review.current_month.missing_dates.includes('2026-10-20'));
  assert.equal(review.weekly.week_start, '2026-10-19');
  assert.equal(review.weekly.elapsed_days, 1);
  assert.equal(review.weekly.missing_days, 1);
});

test('T+1 cutoff keeps a completed prior month final on the first day of a new month', () => {
  const review = buildReview(
    enrichRecords([
      {
        date: '2026-10-31',
        principal: 30000,
        daily_pnl: 1,
        action: '无操作',
        notes: '',
      },
    ]),
    '2026-11-01',
    { reportingDate: '2026-10-31' },
  );
  const october = review.monthly.find((item) => item.month === '2026-10');
  assert.equal(review.current_month.month, '2026-11');
  assert.equal(review.current_month.elapsed_days, 0);
  assert.equal(review.current_month.missing_days, 0);
  assert.ok(october);
  assert.equal(october.is_current, false);
  assert.equal(october.provisional, false);
  assert.equal(october.elapsed_days, 31);
});

test('records before the capital start date are outside the review period', () => {
  const review = buildReview(
    enrichRecords([
      {
        date: '2026-10-19',
        principal: 30000,
        daily_pnl: 0,
        action: '无操作',
        notes: '',
      },
    ]),
    '2026-10-19',
    { initialDate: '2026-10-19' },
  );
  assert.equal(review.account_start_date, '2026-10-19');
  assert.equal(review.current_month.elapsed_days, 1);
  assert.equal(review.current_month.before_start_days, 18);
  assert.equal(review.current_month.active_start_date, '2026-10-19');
  assert.equal(review.current_month.missing_days, 0);
  assert.deepEqual(review.current_month.missing_dates, []);
  assert.equal(review.current_month.record_coverage_pct, 100);
  assert.equal(review.weekly.elapsed_days, 1);
  assert.equal(review.weekly.missing_days, 0);
  assert.ok(!review.alerts.some((item) => item.code === 'missing-days'));
  assert.ok(!review.alerts.some((item) => item.code === 'target-behind'));
});

test('monthly history fills missing months instead of hiding the gap', () => {
  const rows = [
    {
      date: '2026-08-01',
      principal: 500000,
      daily_pnl: 10,
      action: '无操作',
      notes: '',
    },
    {
      date: '2026-10-01',
      principal: 500000,
      daily_pnl: 20,
      action: '无操作',
      notes: '',
    },
  ];
  const review = buildReview(enrichRecords(rows), '2026-10-19');
  const september = review.monthly.find((item) => item.month === '2026-09');
  assert.ok(september);
  assert.equal(september.has_records, false);
  assert.equal(september.grade_display, '未记录');
  assert.equal(september.elapsed_days, 30);
  assert.equal(september.missing_dates.length, 30);
});

test('buildReview keeps a provisional month ungraded and exposes target progress', () => {
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
  assert.equal(review.current_month.grade, null);
  assert.equal(review.current_month.grade_preview, '及格');
  assert.equal(review.current_month.grade_display, '进行中');
  assert.equal(review.current_month.final, false);
  assert.equal(review.current_month.provisional, true);
  assert.ok(review.current_month.annualized_pct !== null);
  assert.ok(review.current_month.target_progress_pct !== null);
  assert.ok(review.current_month.max_drawdown_pct < 0);
  assert.equal(review.daily.date, '2026-10-02');
  assert.equal(review.daily.month_pnl, 1000);
  assert.equal(review.daily.month_grade, '进行中');
  assert.equal(review.daily.month_grade_preview, '及格');
  assert.equal(review.monthly[0].month, '2026-10');
  assert.equal(review.monthly[1].month, '2026-09');
  assert.equal(review.monthly[0].compare.prev_month, '2026-09');
  assert.equal(review.target_annualized_pct, 3);
  assert.ok(review.target_month_pct > 0.24 && review.target_month_pct < 0.25);
  assert.ok(Array.isArray(review.alerts));
  assert.ok(review.weekly);
});

test('a closed month with enough samples receives a final grade', () => {
  const rows = [];
  for (let day = 1; day <= 30; day += 1) {
    rows.push({
      date: `2026-09-${String(day).padStart(2, '0')}`,
      principal: 500000,
      daily_pnl: 50,
      action: '无操作',
      notes: '',
    });
  }
  const review = buildReview(enrichRecords(rows), '2026-10-05');
  assert.equal(review.current_month.month, '2026-10');
  assert.equal(review.current_month.has_records, false);
  assert.equal(review.current_month.grade_display, '待记录');
  assert.equal(review.current_month.missing_days, 5);
  assert.equal(review.current_month.missing_dates.length, 5);
  assert.ok(review.monthly.some((item) => item.month === '2026-10'));
  const september = review.monthly.find((item) => item.month === '2026-09');
  assert.equal(september.sample_sufficient, true);
  assert.equal(september.final, true);
  assert.equal(september.grade, '卓越');
  assert.equal(september.grade_display, '卓越');
  assert.equal(september.record_days, 30);
  assert.equal(september.missing_days, 0);
  assert.equal(september.missing_dates.length, 0);
  assert.equal(september.recorded_dates.length, 30);
  assert.equal(september.record_coverage_pct, 100);
  assert.ok(september.annualized_pct > 0);
  assert.ok(september.target_gap_pct !== null);
});

test('weekly block covers the current Monday-to-Sunday window', () => {
  const rows = [
    { date: '2026-10-12', principal: 500000, daily_pnl: 60, action: '无操作', notes: '' },
    { date: '2026-10-13', principal: 500000, daily_pnl: 40, action: '买入', notes: '' },
    { date: '2026-10-14', principal: 500000, daily_pnl: -30, action: '无操作', notes: '' },
    { date: '2026-10-15', principal: 500000, daily_pnl: -20, action: '无操作', notes: '' },
    { date: '2026-10-16', principal: 500000, daily_pnl: -10, action: '无操作', notes: '' },
  ];
  const review = buildReview(enrichRecords(rows), '2026-10-16');
  assert.equal(review.weekly.week_start, '2026-10-12');
  assert.equal(review.weekly.week_end, '2026-10-18');
  assert.equal(review.weekly.record_days, 5);
  assert.equal(review.weekly.elapsed_days, 5);
  assert.equal(review.weekly.missing_days, 0);
  assert.equal(review.weekly.pnl, 40);
  assert.equal(review.weekly.action_count, 1);
  assert.equal(review.weekly.consecutive_negative_days, 3);
  assert.ok(review.alerts.some((alert) => alert.code === 'negative-streak'));
});

test('monthly coverage reports missing records and stays provisional', () => {
  const rows = [];
  for (let day = 1; day <= 10; day += 1) {
    rows.push({
      date: `2026-10-${String(day).padStart(2, '0')}`,
      principal: 500000,
      daily_pnl: 40,
      action: '无操作',
      notes: '',
    });
  }
  const review = buildReview(enrichRecords(rows), '2026-10-19');
  assert.equal(review.current_month.elapsed_days, 19);
  assert.equal(review.current_month.missing_days, 9);
  assert.equal(review.current_month.record_coverage_pct, 52.63);
  assert.equal(review.current_month.provisional, true);
  assert.equal(review.current_month.grade, null);
  assert.equal(review.current_month.grade_display, '进行中');
  assert.ok(review.alerts.some((alert) => alert.code === 'missing-days'));
  assert.ok(review.alerts.some((alert) => alert.code === 'target-behind'));
});

test('alerts flag a large single-day drop and a recording gap', () => {
  const rows = [
    { date: '2026-10-01', principal: 500000, daily_pnl: 60, action: '无操作', notes: '' },
    { date: '2026-10-02', principal: 500000, daily_pnl: -600, action: '无操作', notes: '' },
  ];
  const review = buildReview(enrichRecords(rows), '2026-10-05');
  assert.ok(review.alerts.some((alert) => alert.code === 'single-day-drop'));
  assert.ok(review.alerts.some((alert) => alert.code === 'record-gap'));
});
