'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { strategyFixture } = require('./fixtures/r2-strategy.cjs');
const { evaluateStrategy } = require('../server/modules/r2-strategy/engine');
const { PREVIOUS_CONTRACT_HASH, HISTORICAL_CONTRACT_HASHES, fingerprint } = require('../server/modules/r2-strategy/contract');
const { buildBuyForecast, buildExecutionSnapshot, verifyExecutionSnapshot } = require('../server/modules/r2-strategy/snapshot');

function fixture() {
  const input = strategyFixture(), result = evaluateStrategy(input);
  const selected = result.allocation.rows.find(row => row.amount_cents > 0);
  const row = result.evidence.rows.find(row => row.identity.code === selected.identity.code);
  return { input, result, row, amountCents: selected.amount_cents };
}
test('forecast freezes reference-yield scenario, dates, public T+1/T+2 timing and idle days independently from1M', () => {
  const value = fixture();
  const forecast = buildBuyForecast({ ...value, date: value.input.date });
  assert.equal(forecast.status, 'available');
  assert.equal(forecast.reference_yield_pct, 2.42);
  assert.equal(forecast.holding_days, value.row.term.days);
  assert.equal(forecast.idle_days, 3);
  assert.equal(forecast.reinvestment_assumed, false);
  assert.ok(forecast.expected_net_annualized_pct < forecast.reference_yield_pct);
});
test('execution snapshot survives JSON round-trip and source closure, and detects tampering', () => {
  const value = fixture();
  const snapshot = buildExecutionSnapshot(value);
  assert.equal(verifyExecutionSnapshot(snapshot), true);
  assert.equal(verifyExecutionSnapshot(JSON.parse(JSON.stringify(snapshot))), true);
  value.input.sourceSnapshot = null;
  assert.equal(snapshot.source_evidence.performance['1m'], '2.5');
  assert.equal(snapshot.portfolio.principal_cents, 10000);
  assert.equal(snapshot.evaluation_contract.target_is_selection_hurdle, false);
  const changed = JSON.parse(JSON.stringify(snapshot)); changed.amount_cents++;
  assert.equal(verifyExecutionSnapshot(changed), false);
});
test('an unavailable calculation, partial amount or unactivated mode cannot become a formal snapshot', () => {
  const value = fixture();
  assert.throws(() => buildExecutionSnapshot({ ...value, amountCents: value.amountCents - 1 }), /不能冻结/);
  const shadow = strategyFixture(); shadow.state.mode = 'shadow';
  assert.throws(() => buildExecutionSnapshot({ ...value, result: evaluateStrategy(shadow) }), /不能冻结/);
  assert.equal(buildBuyForecast({ ...value, date: value.input.date }).status, 'available');
});
test('all prior v9 contracts verify for frozen evaluation and are rejected for new adoption', () => {
  const { snapshot_hash, ...body } = buildExecutionSnapshot(fixture());
  const previous = { ...body.contract, holding_review_version: 'r2-v9-holding-review-v2',
    exit_policy: { ...body.contract.exit_policy, recent_return_threshold_pct: '0.04123288', monthly_yield_threshold_pct: '2.15' },
    forced_exit: ['seven_day_return_below_threshold', 'fresh_same_share_monthly_yield_below_2.15', 'same_share_6m_gt_3m_gt_1m'] };
  const { exit_policy, ...contract } = body.contract;
  const monthlyOnly = { ...contract, holding_review_version: 'r2-v9-holding-review-v1',
    forced_exit: ['fresh_same_share_monthly_yield_below_2.15'] };
  const { bucket_caps_pct, ...first } = monthlyOnly;
  const original = { ...first, allocation_policy_version: 'r2-v9-bucket-allocation-v1',
    bucket_targets: { cash: 0, short: 30, medium: 35, long: 35 } };
  assert.equal(PREVIOUS_CONTRACT_HASH, '31bf22a1db21a05cd1b4921fddcae152416b6fff454dc35df340d0e3c3ce4d6b');
  for (const historicalContract of [previous, monthlyOnly, original]) {
    const payload = { ...body, contract: historicalContract, contract_hash: fingerprint(historicalContract) };
    assert.ok(HISTORICAL_CONTRACT_HASHES.includes(payload.contract_hash));
    const historical = { ...payload, snapshot_hash: fingerprint(payload) };
    assert.equal(verifyExecutionSnapshot(historical), false);
    assert.equal(verifyExecutionSnapshot(historical, { historical: true }), true);
    assert.equal(verifyExecutionSnapshot({ ...historical, amount_cents: 1 }, { historical: true }), false);
  }
});
