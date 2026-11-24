'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CONTRACT, CONTRACT_HASH } = require('../server/modules/r2-strategy/contract');
const { holdingExitConditions } = require('../server/modules/r2-strategy/exit-conditions');
const { buildHoldingMonitoring } = require('../server/modules/r2-strategy/holdings');
const { adaptSnapshot } = require('../server/modules/r2-strategy/evidence');
const { strategyFixture } = require('./fixtures/r2-strategy.cjs');

const DATE = '2026-11-07';
function row() {
  return { identity: { source: 'cmb', channel: 'TEST', code: 'A' }, mapping: { product_code: 'A' },
    performance: { '6m': '3.0', '3m': '2.5', '1m': '2.14' }, performance_date: '2026-11-06',
    holding_yield_state: 'below', holding_exit_performance_verified: true, nav_fresh: true, monitoring_verified: true,
    metrics: { observation: { basis: 'cumulative_change_over_start_unit', recent: {
      status: 'available', days: 7, start_date: '2026-10-30', end_date: '2026-11-06', return_pct: 0.01 } } } };
}
const conditions = value => holdingExitConditions(value, value.holding_yield_state, DATE);
function monitor(value, maturity_date = '2026-11-01') {
  return buildHoldingMonitoring({ date: DATE, holdings: [{ lot_id: '1:A', product_code: 'A', amount: 100, maturity_date }],
    context: { date: DATE, contract_hash: CONTRACT_HASH, fingerprint: 'fixture', rows: [value] } }).rows[0];
}

test('all eight combinations require all three conditions, including redeemable holdings', () => {
  for (let mask = 0; mask < 8; mask++) {
    const current = row();
    current.metrics.observation.recent.return_pct = mask & 1 ? 0.043 : 0.06;
    current.performance['1m'] = mask & 2 ? '2.29' : '2.30';
    current.holding_yield_state = 'pass';
    if (!(mask & 4)) current.performance['6m'] = '2.0';
    const value = monitor(current);
    assert.equal(value.exit_conditions.status, mask === 7 ? 'met' : 'not_met', `combination ${mask}`);
    assert.equal(value.action === '赎回', mask === 7, `combination ${mask}`);
    assert.equal(value.state.startsWith('exit_'), mask === 7, `combination ${mask}`);
  }
});

test('seven-day threshold is exactly the requested percentage and compares unrounded returns strictly', () => {
  assert.equal(CONTRACT.exit_policy.recent_return_threshold_pct, (2.3 * 7 / 365).toFixed(8));
  for (const [value, expected] of [[0.044109589999, 'met'], [0.04410959, 'not_met'], [0.044109590001, 'not_met']]) {
    const current = row(); current.metrics.observation.recent.return_pct = value;
    assert.equal(conditions(current).status, expected);
  }
  const current = row(); current.performance['1m'] = '2.30';
  assert.equal(conditions(current).status, 'not_met');
  current.performance['1m'] = '2.14'; current.performance['3m'] = '3.0';
  assert.equal(conditions(current).status, 'not_met');
  current.performance['3m'] = '2.14';
  assert.equal(conditions(current).status, 'not_met');
});

test('a share between 2.15% and 2.3% with a missing exit input remains under review', () => {
  const current = row();
  current.performance['1m'] = '2.29';
  current.metrics.observation.recent.status = 'pending';
  current.holding_yield_state = 'pass';
  const value = monitor(current);
  assert.equal(value.exit_conditions.status, 'pending');
  assert.equal(value.state, 'evidence_pending');
  assert.equal(value.action, '观察');
});

test('missing six-month evidence, missing week, stale dates and unverified data cannot force an exit', () => {
  for (const change of [r => { r.performance['6m'] = null; }, r => { r.performance['3m'] = ''; },
    r => { r.performance_date = '2026-10-30'; }, r => { r.holding_exit_performance_verified = false; },
    r => { r.nav_fresh = false; }, r => { r.monitoring_verified = false; },
    r => { r.metrics.observation.recent.status = 'pending'; }, r => { r.metrics.observation.recent.days = 6; },
    r => { r.metrics.observation.recent.start_date = '2026-10-29'; },
    r => { r.metrics.observation.recent.end_date = '2026-11-08'; },
    r => { delete r.metrics.observation.recent.return_pct; },
    r => { r.metrics.observation.recent.return_pct = null; }]) {
    const current = row(); change(current);
    const value = monitor(current);
    assert.equal(value.exit_conditions.status, 'pending');
    assert.equal(value.state, 'evidence_pending');
    assert.equal(value.action, '观察');
  }
  const current = row(); current.performance['1m'] = '2.78'; current.performance['6m'] = null;
  assert.equal(conditions(current).status, 'not_met', 'a known false monthly condition suffices to reject the conjunction');
});

test('zero and negative disclosure counts and unrelated complete-month trends do not replace the three windows', () => {
  const current = row();
  current.performance['6m'] = '2.0';
  Object.assign(current.metrics.observation, { trend: { status: 'available', weak: true } });
  Object.assign(current.metrics.observation.recent, { zero_count: 7, negative_count: 7 });
  assert.equal(conditions(current).status, 'not_met');
});

test('triggered holdings respect locked, open and unknown redemption windows', () => {
  assert.equal(monitor(row()).state, 'exit_required');
  const locked = monitor(row(), '2026-12-01');
  assert.equal(locked.state, 'exit_at_open');
  assert.equal(locked.action, '观察');
  const value = buildHoldingMonitoring({ date: DATE, holdings: [{ lot_id: '1:A', product_code: 'A', amount: 100, term_days: 7 }],
    context: { date: DATE, contract_hash: CONTRACT_HASH, rows: [row()] } }).rows[0];
  assert.equal(value.state, 'exit_rules_pending');
  assert.equal(value.action, '观察');
});

test('six/three/one-month evidence must agree with the same-share dated source proof', () => {
  const fixture = strategyFixture();
  assert.equal(adaptSnapshot(fixture.sourceSnapshot, DATE).rows[0].holding_exit_performance_verified, true);
  fixture.sourceSnapshot.evidence[0].summary.performance = { ...fixture.sourceSnapshot.evidence[0].summary.performance, '6m': '9.0' };
  const adapted = adaptSnapshot(fixture.sourceSnapshot, DATE).rows[0];
  assert.equal(adapted.holding_exit_performance_verified, false);
  assert.equal(adapted.holding_yield_state, 'pass', 'purchase and monthly evidence remain independently evaluated');
});
