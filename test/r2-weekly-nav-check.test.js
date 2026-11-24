'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkWeek } = require('../scripts/r2-weekly-nav-check.cjs');

const threshold = 0.04410959;
const date = '2026-11-24';
const points = ['16', '17', '18', '19', '20', '21', '22', '23'].map(day => ({
  date: '2026-11-' + day, unit: '1', cumulative: day === '23' ? '1.0004410959' : '1',
}));

test('public NAV check accepts disclosed weekends and compares unrounded total return strictly', () => {
  const result = checkWeek(points, date, threshold);
  assert.equal(result.status, 'calculated');
  assert.equal(result.disclosed_dates, 8);
  assert.equal(result.below_threshold, false);
  const below = points.map(point => point.date === '2026-11-23' ? { ...point, cumulative: '1.000441095899' } : point);
  assert.equal(checkWeek(below, date, threshold).below_threshold, true);
  const workingDays = points.filter(point => !['2026-11-21', '2026-11-22'].includes(point.date));
  assert.equal(checkWeek(workingDays, date, threshold).disclosed_dates, 6);
});

test('missing endpoints, normal trading days, cumulative values and conflicting observations stay pending', () => {
  const without = day => points.filter(point => point.date !== '2026-11-' + day);
  assert.equal(checkWeek(without('16'), date, threshold).reason, 'start_nav_missing');
  assert.equal(checkWeek(without('17'), date, threshold).reason, 'nav_gap');
  assert.equal(checkWeek([...without('23'), { ...points.at(-1), cumulative: null }], date, threshold).reason, 'cumulative_unavailable');
  assert.equal(checkWeek([...points, { ...points.at(-1), cumulative: '1.002' }], date, threshold).reason, 'nav_conflict');
  assert.equal(checkWeek(points, '2026-11-30', threshold).reason, 'nav_stale_or_unavailable');
});
