'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkWeek, collectWeeklyNav, createWeeklyNavReader, pendingShares } = require('../server/modules/r2-strategy/weekly-nav');

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

const row = (code, channel, recent = 'pending') => ({
  product_code: code, identity: { source: 'cmb', channel, code },
  exit_conditions: { checks: { recent_return: recent, monthly_yield: 'met', declining_windows: 'met' } },
});
const workspace = rows => ({ mode: 'v9', stale: false, contract_matches: true, business_date: date,
  result: { monitoring: { rows } } });

test('public lookup deduplicates lots, keeps conflicting channels pending, and preserves formal checks', async () => {
  const input = workspace([row('A', 'D07'), row('A', 'D07'), row('B', 'D07'), row('B', 'D08', 'met'), row('C', 'D07', 'met')]);
  const before = structuredClone(input);
  let closed = false;
  const fetched = [];
  const result = await collectWeeklyNav(pendingShares(input, date), date, threshold, {
    openBrowser: async () => ({ close: async () => { closed = true; } }),
    createClient: async () => ({}),
    readNav: async (_, share) => { fetched.push(share); return { points }; },
  });
  assert.deepEqual(fetched, [{ source: 'cmb', code: 'A', channel: 'D07' }]);
  assert.equal(result.products.find(entry => entry.code === 'A').status, 'calculated');
  assert.equal(result.products.find(entry => entry.code === 'B').reason, 'same_cmb_share_unverified');
  assert.equal(closed, true);
  assert.deepEqual(input, before);
});

test('display lookups share an in-flight request and retry pending results after the short cache expires', async () => {
  let clock = 0;
  let calls = 0;
  const read = createWeeklyNavReader({ now: () => clock, collect: async (...args) => {
    if (args[0]) calls++;
    return collectWeeklyNav(...args.slice(0, 3), { ...args[3], openBrowser: async () => { throw new Error('offline'); } });
  } });
  const current = workspace([row('A', 'D07')]);
  const first = read(current);
  assert.equal(read(current), first);
  assert.equal((await first).products[0].reason, 'public_source_unavailable');
  assert.equal((await read({ ...current, stale: true })).status, 'skipped');
  clock = 29_999;
  assert.equal(read(current), first);
  clock++;
  assert.notEqual(read(current), first);
  assert.equal(calls, 2);
});
