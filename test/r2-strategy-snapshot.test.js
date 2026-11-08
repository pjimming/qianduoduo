'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { strategyFixture } = require('./fixtures/r2-strategy.cjs');
const { evaluateStrategy } = require('../server/modules/r2-strategy/engine');
const { buildBuyForecast, buildExecutionSnapshot, verifyExecutionSnapshot } = require('../server/modules/r2-strategy/snapshot');

function fixture() {
  const input = strategyFixture(), result = evaluateStrategy(input);
  const selected = result.allocation.rows.find(row => row.amount_cents > 0);
  const row = result.evidence.rows.find(row => row.identity.code === selected.identity.code);
  const check = input.checks.find(item => item.mapping_id === row.mapping.id);
  return { input, result, row, check, amountCents: selected.amount_cents };
}
test('forecast freezes reference-yield scenario, dates, fees and idle days independently from1M', () => {
  const value = fixture();
  const forecast = buildBuyForecast({ ...value, date: value.input.date });
  assert.equal(forecast.status, 'available');
  assert.equal(forecast.reference_yield_pct, 2.42);
  assert.equal(forecast.holding_days, value.row.term.days);
  assert.equal(forecast.idle_days, 4);
  assert.equal(forecast.reinvestment_assumed, false);
  assert.ok(forecast.expected_net_annualized_pct < forecast.reference_yield_pct);
});
test('fees can make a qualified product forecast negative without relabeling1M qualification', () => {
  const value = fixture(); value.check.facts.fees.purchase_bps = 500;
  const forecast = buildBuyForecast({ ...value, date: value.input.date });
  assert.equal(forecast.status, 'available');
  assert.ok(forecast.expected_net_pnl_cents < 0);
  assert.equal(value.row.yield_state, 'pass');
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
  value.check.facts.terms.timing.expected_confirm_on = '2026-11-06';
  assert.equal(buildBuyForecast({ ...value, date: value.input.date }).value, null);
});
