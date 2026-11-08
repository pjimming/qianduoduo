'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CONTRACT_HASH } = require('../server/modules/r2-strategy/contract');
const { buildHoldingMonitoring } = require('../server/modules/r2-strategy/holdings');

function input() {
  const identity = { source: 'cmb', channel: 'D07', code: 'A' };
  return { date: '2026-11-07', holdings: [{ lot_id: '1:A', product_code: 'A', amount: 100, purchase_date: '2026-10-01', maturity_date: '2026-12-01' }],
    context: { date: '2026-11-07', contract_hash: CONTRACT_HASH, available: true, fingerprint: 'context', blockers: [],
      rows: [{ identity, mapping: { id: 1, product_code: 'A' }, holding_yield_state: 'below', performance: { '1m': '2.14' },
        performance_date: '2026-11-06', evidence_hash: 'hash', term: { kind: 'minimum', days: 30 },
        quota: { status: 1 }, shortlisted: false, screening_status: 'rejected', run_id: 1 }] },
    checks: [{ id: 1, mapping_id: 1, lot_id: '1:A', version: 1, facts: { kind: 'holding_redemption', status: 'verified', identity,
      redemption: { rules_verified: true, source_hash: 'a'.repeat(64), terms_version: 'terms-v1', earliest_redeem_date: '2026-11-01',
        as_of: '2026-11-07', can_redeem_today: true, funds_available_date: '2026-11-10' } } }] };
}
const one = model => buildHoldingMonitoring(model).rows[0];
test('fresh below-threshold holdings exit without a replacement, quota or economic edge gate', () => {
  const value = one(input());
  assert.equal(value.state, 'exit_required');
  assert.equal(value.action, '赎回');
  assert.equal(value.planned_action, 'redeem');
  assert.equal(value.requires_user_action, true);
  assert.equal(value.confirm_date, '2026-10-01');
});
test('a locked below-threshold holding is an observation with exit intent, not an immediate switch', () => {
  const model = input();
  model.checks[0].facts.redemption.earliest_redeem_date = '2026-12-01';
  model.checks[0].facts.redemption.funds_available_date = '2026-12-03';
  const value = one(model);
  assert.equal(value.state, 'exit_at_open');
  assert.equal(value.action, '观察');
  assert.equal(value.planned_action, 'exit_at_maturity');
  assert.equal(value.redemption.earliest_redeem_date, '2026-12-01');
});
test('maturity and public purchase openings cannot prove today is a redemption window', () => {
  const model = input();
  model.holdings[0].maturity_date = '2026-10-31';
  model.context.rows[0].next_open_date = '2026-11-01';
  model.checks[0].facts.redemption.as_of = '2026-11-06';
  assert.equal(one(model).state, 'exit_rules_pending');
  model.checks = [];
  assert.equal(one(model).action, '观察');
});
test('missing/stale identity evidence is pending, never a forced yield exit or automatic renewal', () => {
  for (const change of [model => { model.context.rows[0].holding_yield_state = 'pending'; },
    model => { model.context.rows = []; }, model => { model.context.date = '2026-11-06'; },
    model => { model.context.blockers = ['source_identity_or_calendar']; }]) {
    const model = input(); change(model);
    const value = one(model);
    assert.equal(value.state, 'evidence_pending');
    assert.equal(value.action, '观察');
  }
});
test('sale status and research rank alone do not force a passing holding to exit', () => {
  const model = input(); model.context.rows[0].holding_yield_state = 'pass';
  model.context.rows[0].performance['1m'] = '2.15';
  const value = one(model);
  assert.equal(value.state, 'hold');
  assert.equal(value.requires_user_action, false);
  assert.equal(value.next_verify_date, '2026-11-13');
});
test('risk signals are distinct from the explicit yield exit rule and do not fake a redemption', () => {
  const model = input(); model.context.rows[0].holding_yield_state = 'pass';
  model.context.rows[0].metrics = { drawdown: { band: 'watch' } };
  model.context.rows[0].term.days = 191;
  assert.equal(one(model).state, 'risk_review');
  assert.equal(one(model).action, '观察');
  model.context.rows[0].holding_yield_state = 'below';
  assert.equal(one(model).state, 'exit_required');
});
test('latest check withdrawal and same-name wrong-share evidence invalidate redemption clearance', () => {
  const model = input();
  model.checks.push({ ...model.checks[0], id: 2, version: 2, facts: { ...model.checks[0].facts, status: 'withdrawn' } });
  assert.equal(one(model).state, 'exit_rules_pending');
  model.checks = [model.checks[0]];
  model.checks[0].facts.identity = { ...model.checks[0].facts.identity, channel: 'OTHER' };
  assert.equal(one(model).state, 'exit_rules_pending');
});
test('message identity is stable across evidence batches and handling states; source outage alone creates no daily user card', () => {
  const model = input(), first = one(model);
  model.context.fingerprint = 'new'; model.context.rows[0].run_id = 2;
  model.checks[0].facts.redemption.can_redeem_today = false;
  const next = one(model);
  assert.equal(next.message_key, first.message_key);
  assert.notEqual(next.fingerprint, first.fingerprint);
  model.context.rows[0].holding_yield_state = 'pending';
  assert.equal(one(model).requires_user_action, false);
});
test('monitoring is read-only, covers unmapped lots and rejects duplicate lot identities', () => {
  const model = input(), before = JSON.stringify(model);
  model.holdings.push({ lot_id: '2:B', product_code: 'B', amount: 10 });
  assert.equal(buildHoldingMonitoring(model).rows.length, 2);
  model.holdings.pop();
  one(model);
  assert.equal(JSON.stringify(model), before);
  model.holdings.push({ ...model.holdings[0] });
  assert.throws(() => buildHoldingMonitoring(model), /批次重复/);
});
test('a passing holding without fresh net value evidence goes to risk review instead of a hold or exit', () => {
  const model = input(), row = model.context.rows[0];
  row.holding_yield_state = 'pass'; row.performance = { '1m': '2.50' }; row.nav_fresh = false; row.monitoring_verified = true;
  const value = one(model);
  assert.equal(value.state, 'risk_review');
  assert.equal(value.action, '观察');
  assert.equal(value.planned_action, 'verify_holding');
  assert.equal(value.requires_user_action, true);
  assert.ok(value.risk_reasons.includes('nav_evidence_unverified'));
  assert.equal(value.yield_state, 'pass');
  assert.equal(value.redemption.redeemable_now, true);
});
test('a holding whose latest monitoring batch failed is flagged for review while recent evidence stays visible', () => {
  const model = input(), row = model.context.rows[0];
  row.holding_yield_state = 'pass'; row.performance = { '1m': '2.50' }; row.nav_fresh = true; row.monitoring_verified = false;
  const value = one(model);
  assert.equal(value.state, 'risk_review');
  assert.equal(value.action, '观察');
  assert.ok(value.risk_reasons.includes('monitor_evidence_unverified'));
  assert.equal(value.yield_1m, '2.50');
  assert.equal(value.performance_date, '2026-11-06');
});
