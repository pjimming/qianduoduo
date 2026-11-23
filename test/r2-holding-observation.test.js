'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { navMetrics } = require('../server/modules/r2-screening/policy');
const { valuationCalendar: calendar } = require('../server/modules/r2-screening/calendar');
const { CONTRACT_HASH } = require('../server/modules/r2-strategy/contract');
const { buildHoldingMonitoring } = require('../server/modules/r2-strategy/holdings');
const { compactStrategyResult, evaluateStrategy } = require('../server/modules/r2-strategy/engine');
const { strategyFixture } = require('./fixtures/r2-strategy.cjs');

const dates = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16'];
function metrics(values, extra = [], date = '2026-11-17', basis = 'trading_days') {
  return navMetrics({ points: [...extra, ...values.map((value, index) => ({ date: dates[index],
    unit: String(value), cumulative: String(value) }))] }, date, calendar, basis);
}
function monitor(observation, { monthly = '2.30', yieldState = 'pass', changes = {}, contextChanges = {} } = {}) {
  return buildHoldingMonitoring({ date: '2026-11-17',
    holdings: [{ lot_id: 'A', product_code: 'A', amount: 1000 }],
    context: { date: '2026-11-17', contract_hash: CONTRACT_HASH, fingerprint: 'fixture', blockers: [],
      rows: [{ identity: { source: 'cmb', channel: 'TEST', code: 'A' }, mapping: { product_code: 'A' },
        performance: { '1m': monthly }, performance_date: '2026-11-16', holding_yield_state: yieldState,
        nav_fresh: true, monitoring_verified: true, metrics: { observation }, ...changes }], ...contextChanges } }).rows[0];
}
test('seven calendar days use proportional cumulative return, not an absolute NAV delta or seven trading points', () => {
  const a = metrics([1, 1.0001, 1.0002, 1.0003, 1.0003, 1.0004]).observation.recent;
  const b = metrics([2, 2.0002, 2.0004, 2.0006, 2.0006, 2.0008]).observation.recent;
  assert.equal(a.status, 'available');
  assert.equal(a.days, 7);
  assert.equal(a.annualized_pct, 2.0857);
  assert.equal(a.return_pct, 0.04);
  assert.equal(a.annualized_pct, b.annualized_pct);
  assert.equal(a.interval_count, 5);
  assert.equal(a.zero_count, 1);
  assert.equal(a.negative_count, 0);
});
test('cash distributions do not become false losses, and unavailable cumulative NAV is never inferred from unit NAV', () => {
  const points = dates.map((date, i) => ({ date, unit: i < 3 ? '1.0100' : '1.0000', cumulative: '1.0100' }));
  const read = () => navMetrics({ points }, '2026-11-17', calendar, 'trading_days').observation.recent;
  assert.equal(read().negative_count, 0);
  assert.equal(read().zero_count, 5);
  assert.equal(read().annualized_pct, 0);
  delete points[2].cumulative;
  assert.equal(read().status, 'pending');
  assert.equal(read().reason, 'cumulative_unavailable');
});
test('missing disclosure days, holiday weeks, unknown calendars and valuation rules remain pending', () => {
  const points = dates.filter((_, i) => i !== 2).map(date => ({ date, unit: '1', cumulative: '1' }));
  assert.equal(navMetrics({ points }, '2026-11-17', calendar, 'trading_days').observation.recent.reason, 'nav_gap');
  assert.equal(metrics([1, 1, 1, 1, 1, 1], [], '2026-11-17', null).observation.recent.reason, 'valuation_basis_unverified');
  const holiday = { points: ['2026-09-30', '2026-10-08', '2026-10-09'].map(date => ({ date, unit: '1', cumulative: '1' })) };
  assert.equal(navMetrics(holiday, '2026-10-10', calendar, 'trading_days').observation.recent.reason, 'holiday_window');
  assert.equal(navMetrics({ points }, '2026-11-17', { ...calendar, start: '2026-11-10' }, 'trading_days').issue, 'calendar_gap');
});
test('cumulative conflicts and stale NAV cannot produce valid observations', () => {
  const points = dates.map(date => ({ date, unit: '1', cumulative: '1' }));
  points.push({ ...points[2], cumulative: '1.1' });
  assert.equal(navMetrics({ points }, '2026-11-17', calendar, 'trading_days').observation.recent.reason, 'cumulative_conflict');
  assert.equal(navMetrics({ points: points.slice(0, 6) }, '2026-11-23', calendar, 'trading_days').observation, undefined);
});
test('three non-overlapping complete monthly intervals use cumulative NAV and actual calendar days', () => {
  const ends = [['2026-07-31', '1'], ['2026-08-31', '1.0031'], ['2026-09-30', '1.0050'], ['2026-10-30', '1.0059']]
    .map(([date, value]) => ({ date, unit: value, cumulative: value }));
  const trend = metrics([1.006, 1.006, 1.006, 1.006, 1.006, 1.006], ends).observation.trend;
  assert.equal(trend.status, 'available');
  assert.equal(trend.weak, true);
  assert.deepEqual(trend.periods.map(row => row.days), [31, 30, 30]);
  assert.equal(trend.periods[0].annualized_pct, 3.65);
  assert.equal(metrics([1, 1, 1, 1, 1, 1]).observation.trend.reason, 'month_end_missing');
});
test('warning band adds an observation without an exit, user-action card or change to the floor', () => {
  const observation = metrics([1, 1, 1, 1, 1, 1]).observation;
  const row = monitor(observation);
  assert.equal(row.observation.state, 'watch');
  assert.deepEqual(row.observation.reasons, ['recent_yield_weak']);
  assert.equal(row.observation.recent_return_threshold_pct, 2.15 * 7 / 365);
  assert.equal(row.state, 'hold');
  assert.equal(row.action, '观察');
  assert.equal(row.planned_action, 'review_holding');
  assert.equal(row.requires_user_action, false);
  assert.equal(monitor(observation, { monthly: '2.15' }).observation.state, 'watch');
  assert.equal(monitor(observation, { monthly: '2.50' }).observation.state, 'clear');
  const exit = monitor(null, { monthly: '2.14', yieldState: 'below' });
  assert.equal(exit.state, 'evidence_pending');
  assert.equal(exit.action, '观察');
  const locked = buildHoldingMonitoring({ date: '2026-11-17', holdings: [{ lot_id: 'L', product_code: 'L', amount: 10, maturity_date: '2026-12-01' }],
    context: { date: '2026-11-17', contract_hash: CONTRACT_HASH, rows: [{ mapping: { product_code: 'L' }, holding_yield_state: 'below' }] } }).rows[0];
  assert.equal(locked.state, 'evidence_pending');
});
test('zero/negative counts remain diagnostic and a profitable week is not warned just because its gains are concentrated', () => {
  const row = monitor(metrics([1.000, 1.002, 1.001, 1.003, 1.002, 1.004]).observation);
  assert.deepEqual(row.observation.reasons, []);
  assert.equal(row.observation.metrics.recent.zero_count, 0);
  assert.deepEqual(monitor(metrics([1, 1.002, 1.001, 1.003, 1.004, 1.005]).observation).observation.reasons, []);
  const concentrated = monitor(metrics([1, 1, 1, 1.0006, 1.0006, 1.0006]).observation);
  assert.equal(concentrated.observation.metrics.recent.zero_count, 4);
  assert.equal(concentrated.observation.metrics.recent.return_pct, 0.06);
  assert.deepEqual(concentrated.observation.reasons, []);
});
test('seven-day return uses the unrounded 2.15% annual floor, strict less-than, and no rounded annual-yield fallback', () => {
  // 365 starting NAV and 0.1505 gain land exactly on the 2.15% × 7 / 365 line.
  const at = metrics([365, 365, 365, 365, 365, 365.1505]).observation;
  const below = metrics([365, 365, 365, 365, 365, 365.150499999999]).observation;
  const above = metrics([365, 365, 365, 365, 365, 365.150500000001]).observation;
  assert.deepEqual(monitor(at).observation.reasons, []);
  assert.deepEqual(monitor(below).observation.reasons, ['recent_yield_weak']);
  assert.deepEqual(monitor(above).observation.reasons, []);
  assert.equal(at.recent.annualized_pct, below.recent.annualized_pct);
  assert.equal(at.recent.annualized_pct, above.recent.annualized_pct);
  const legacy = structuredClone(at); delete legacy.recent.return_pct;
  assert.equal(monitor(legacy).observation.state, 'pending');
  assert.deepEqual(monitor(legacy).observation.reasons, []);
});
test('a verified complete-month trend can trigger observation without a usable week, but an old monthly window cannot', () => {
  const ends = [['2026-07-31', '1'], ['2026-08-31', '1.0031'], ['2026-09-30', '1.0050'], ['2026-10-30', '1.0059']]
    .map(([date, value]) => ({ date, unit: value, cumulative: value }));
  const observation = metrics([1.006, 1.006, 1.006, 1.006, 1.006, 1.006], ends).observation;
  observation.recent = { status: 'pending', reason: 'nav_gap' };
  assert.deepEqual(monitor(observation).observation.reasons, ['monthly_trend_weak']);
  const old = structuredClone(observation);
  old.trend.periods[2].end_date = '2026-09-30';
  assert.equal(monitor(old).observation.state, 'pending');
});
test('unverified, failed, out-of-date or missing observation inputs stay pending instead of becoming warnings', () => {
  const observation = metrics([1, 1, 1, 1, 1, 1]).observation;
  for (const changes of [{ nav_fresh: false }, { monitoring_verified: false }, { performance_date: '2026-11-01' }]) {
    assert.equal(monitor(observation, { changes }).observation.state, 'pending');
  }
  assert.equal(monitor(observation, { contextChanges: { date: '2026-11-16' } }).observation.state, 'pending');
  assert.equal(monitor(null).observation.state, 'pending');
  const old = structuredClone(observation); old.recent.end_date = '2026-11-01';
  assert.equal(monitor(old).observation.state, 'pending');
});
test('warning products precede ordinary holds while mandatory exits keep their priority, and compact API preserves evidence', () => {
  const fixture = strategyFixture();
  fixture.date = '2026-11-17';
  fixture.sourceSnapshot.run.business_date = fixture.date;
  fixture.sourceSnapshot.rows.forEach(row => {
    row.data.performance_date = '2026-11-16'; row.data.performance['1m'] = '2.30';
    row.data.metrics.latest = row.data.metrics.end = '2026-11-16';
    row.data.metrics.observation = metrics([1, 1, 1, 1, 1, 1]).observation;
  });
  fixture.sourceSnapshot.evidence.forEach(row => { row.summary.performance_date = '2026-11-16'; row.summary.performance['1m'] = '2.30'; });
  fixture.sourceSnapshot.rows[0].data.performance['1m'] = '2.60';
  fixture.sourceSnapshot.evidence[0].summary.performance['1m'] = '2.60';
  fixture.sourceSnapshot.rows[2].data.performance['1m'] = '2.14';
  fixture.sourceSnapshot.rows[2].data.performance['3m'] = '2.5';
  fixture.sourceSnapshot.rows[2].data.performance['6m'] = '3.0';
  fixture.sourceSnapshot.evidence[2].summary.performance = { ...fixture.sourceSnapshot.rows[2].data.performance };
  fixture.portfolio.holdings = ['S1', 'S2', 'S3'].map((product_code, i) => ({ lot_id: String(i), product_code, amount: 10, purchase_date: '2026-10-01', term_days: 30 }));
  const result = evaluateStrategy(fixture);
  assert.deepEqual(result.monitoring.rows.map(row => row.product_code), ['S3', 'S2', 'S1']);
  assert.equal(compactStrategyResult(result).monitoring.rows[1].observation.state, 'watch');
  assert.deepEqual(compactStrategyResult(result).monitoring.rows[1].observation, result.monitoring.rows[1].observation);
  assert.equal(result.exit_intents.length, 1);
  assert.equal(result.exit_intents[0].lot_id, '2');
});
