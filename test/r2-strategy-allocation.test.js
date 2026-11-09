'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const solver = require('javascript-lp-solver');
const { CONTRACT_HASH, fingerprint } = require('../server/modules/r2-strategy/contract');
const { allocateV9 } = require('../server/modules/r2-strategy/allocation');
const { identityKey } = require('../server/modules/r2-strategy/evidence');

function input() {
  const source = [
    ['S1', 30, 1, 500], ['S2', 30, 2, 2000], ['S3', 30, 3, 2000], ['S4', 30, 4, 3000],
    ['M1', 90, 1, 3000], ['M2', 90, 2, 3000], ['L1', 180, 1, 3000], ['L2', 180, 2, 3000],
  ];
  const rows = source.map(([code, days, rank]) => ({ identity: { source: 'cmb', channel: 'test', code }, mapping: { product_code: code },
    rank, term: { days, kind: 'minimum' }, category: 'bond', quota: { status: 0 }, evidence_tier: 'full_1y',
    reference: { status: 'available', value_pct: 2.3 }, yield_state: 'pass', evidence_hash: fingerprint(code), automatic_eligible: true, blockers: [] }));
  const limits = Object.fromEntries(rows.map((row, i) => [identityKey(row.identity), {
    minimum_cents: 100, increment_cents: 1, available_cents: source[i][3], family_key: `family-${i}`, product_key: source[i][0],
    liquidity_eligible: row.term.days >= 7 && row.term.days <= 30, available_on: row.term.days < 100 ? '2027-02-01' : '2027-05-01',
    quota_basis: { kind: 'public', disclosed: true },
  }]));
  return { context: { date: '2026-11-07', available: true, contract_hash: CONTRACT_HASH, fingerprint: fingerprint('source'), rows },
    account: { principal_cents: 10000, exposures: [] }, limits };
}
const amountFor = (result, code) => result.rows.find(row => row.identity.code === code)?.amount_cents ?? 0;
const limitFor = (model, code) => model.limits[identityKey(model.context.rows.find(row => row.identity.code === code).identity)];

test('v9 allocation closes to the cent, preserves rank and uses reserves beyond top three', () => {
  const model = input(), before = JSON.stringify(model);
  const value = allocateV9(model);
  assert.equal(value.status, 'simulation_passed');
  assert.equal(value.full_investment, true);
  assert.equal(value.executable, false);
  assert.equal(value.allocated_cents, 10000);
  assert.equal(value.unallocated_cents, 0);
  assert.equal(amountFor(value, 'S1'), 500);
  assert.equal(amountFor(value, 'S2'), 2000);
  assert.equal(amountFor(value, 'S3'), 2000);
  assert.equal(amountFor(value, 'S4'), 3000);
  assert.equal(value.rows.find(row => row.identity.code === 'S4').reason, 'ranked_reserve_used');
  assert.deepEqual(value.bucket_budgets_cents, { short: 10000, medium: 2000, long: 1000 });
  assert.equal(JSON.stringify(model), before);
  assert.equal(allocateV9(model).fingerprint, value.fingerprint);
});
test('LP repairs a greedy dead end across bucket and family limits', () => {
  const model = input();
  // Sharing a family across terms must leave room for the other eligible shares.
  for (const code of ['S2', 'S3', 'S4', 'M1', 'L1']) limitFor(model, code).family_key = 'shared';
  limitFor(model, 'S1').available_cents = 3000;
  const value = allocateV9(model);
  assert.equal(value.full_investment, true);
  assert.equal(['S2', 'S3', 'S4', 'M1', 'L1'].reduce((sum, code) => sum + amountFor(value, code), 0), 5000);
});
test('an early rank is skipped only when its minimum/increment would prevent the full plan', () => {
  const model = input();
  const a = limitFor(model, 'S1'); a.minimum_cents = 501; a.increment_cents = 7; a.available_cents = 501;
  limitFor(model, 'S2').minimum_cents = 1000; limitFor(model, 'S2').increment_cents = 1000;
  limitFor(model, 'S3').minimum_cents = 1000; limitFor(model, 'S3').increment_cents = 1000;
  limitFor(model, 'S4').minimum_cents = 1000; limitFor(model, 'S4').increment_cents = 1000;
  for (const code of ['M1', 'M2', 'L1', 'L2']) {
    limitFor(model, code).minimum_cents = 1000;
    limitFor(model, code).increment_cents = 1000;
  }
  const value = allocateV9(model);
  assert.equal(value.full_investment, true);
  assert.equal(amountFor(value, 'S1'), 0);
  assert.equal(amountFor(value, 'S4'), 3000);
});
test('medium and long limits are independent and an extra cent freezes that bucket', () => {
  const model = input();
  model.account.exposures = [
    { key: 'old-m', amount_cents: 2000, bucket: 'medium', product_key: 'old-m', family_key: 'old-m', evidence_tier: 'full_1y' },
    { key: 'old-l', amount_cents: 999, bucket: 'long', product_key: 'old-l', family_key: 'old-l', evidence_tier: 'full_1y' },
  ];
  const atLimit = allocateV9(model);
  assert.equal(atLimit.bucket_limits.medium.remaining_cents, 0);
  assert.equal(atLimit.bucket_limits.long.remaining_cents, 1);
  model.account.exposures[0].amount_cents++;
  const excess = allocateV9(model);
  assert.equal(excess.bucket_limits.medium.excess_cents, 1);
  assert.ok(excess.blockers.includes('existing_medium_bucket_cap'));
  assert.equal(amountFor(excess, 'M1') + amountFor(excess, 'M2'), 0);
});
test('different term groups share the budget before stable group-order preferences', () => {
  const model = input();
  model.context.rows[0].term.days = 7;
  limitFor(model, 'S1').available_cents = 3000;
  const value = allocateV9(model);
  assert.equal(value.full_investment, true);
  assert.equal(amountFor(value, 'S1'), 3000);
  assert.equal(amountFor(value, 'S2') + amountFor(value, 'S3') + amountFor(value, 'S4'), 7000);
});
test('single-family100% exception is not imported; source and issuer data cannot relax family caps', () => {
  const model = input();
  Object.values(model.limits).forEach(limit => { limit.family_key = 'one-family'; });
  const value = allocateV9(model);
  assert.equal(value.full_investment, false);
  assert.equal(value.allocated_cents, 5000);
  assert.equal(value.unallocated_cents, 5000);
  assert.ok(value.blockers.includes('capacity_or_increment_gap'));
});
test('liquidity subset is checked separately from the short scoring bucket, with no20% bypass', () => {
  const model = input();
  for (const code of ['S1', 'S2', 'S3', 'S4']) limitFor(model, code).liquidity_eligible = false;
  const value = allocateV9(model);
  assert.equal(value.full_investment, false);
  assert.equal(value.allocated_cents, 10000);
  assert.equal(value.liquidity_cents, 0);
  assert.ok(value.blockers.includes('liquidity_or_cashflow_conflict'));
  model.settings = { liquidity_floor_pct: 20 };
  assert.ok(allocateV9(model).blockers.includes('settings_invalid'));
});
test('evidence caps, registered-product aggregation and existing commitments share the portfolio denominator', () => {
  const model = input();
  for (const row of model.context.rows.filter(row => row.term.days === 180)) row.evidence_tier = 'six_month';
  const value = allocateV9(model);
  assert.equal(value.full_investment, true);
  assert.equal(amountFor(value, 'L1') + amountFor(value, 'L2'), 500);
  const held = input();
  held.account.exposures = [{ key: 'lot:1', amount_cents: 2000, bucket: 'short', product_key: 'S1', family_key: 'family-0',
    evidence_tier: 'full_1y', liquidity_eligible: true }];
  limitFor(held, 'S1').available_cents = 3000;
  assert.equal(allocateV9(held).full_investment, true);
  assert.equal(amountFor(allocateV9(held), 'S1'), 1000);
  limitFor(held, 'S2').product_key = 'S1';
  const registered = allocateV9(held);
  assert.equal(amountFor(registered, 'S2'), 0);
});
test('explicit tiny quotas and order increments are never enlarged to meet the minimum', () => {
  const model = input();
  limitFor(model, 'S1').available_cents = 1;
  const value = allocateV9(model);
  assert.equal(amountFor(value, 'S1'), 0);
  assert.equal(value.excluded.find(row => row.identity.code === 'S1').reasons[0], 'quota_below_minimum');
  assert.equal(value.full_investment, true);
});
test('cash-flow dates and cash in transit remain unavailable until verified arrival', () => {
  const model = input();
  model.settings = { cash_needs: [{ by_date: '2026-12-01', required_cents: 1000 }] };
  const reserved = allocateV9(model);
  assert.equal(reserved.allocated_cents, 9000);
  assert.equal(reserved.unallocated_cents, 1000);
  delete model.settings;
  model.account.blocked_cash_cents = 100;
  const value = allocateV9(model);
  assert.equal(value.full_investment, false);
  assert.ok(value.unallocated_cents >= 100);
  assert.ok(value.blockers.includes('cash_in_transit'));
});
test('quota loss and a delayed arrival show a funding gap without exceeding the term caps', () => {
  const model = input();
  model.settings = { cash_needs: [{ by_date: '2026-11-20', required_cents: 1000 }] };
  const short = limitFor(model, 'S4');
  short.available_on = '2026-11-20';
  assert.equal(allocateV9(model).full_investment, true);
  short.available_on = '2026-11-25';
  assert.equal(allocateV9(model).unallocated_cents, 1000);
  short.available_cents = 0;
  const stressed = allocateV9(model);
  assert.ok(stressed.unallocated_cents > 1000);
  assert.ok(amountFor(stressed, 'M1') + amountFor(stressed, 'M2') <= 2000);
  assert.ok(amountFor(stressed, 'L1') + amountFor(stressed, 'L2') <= 1000);
});
test('ineligible or unavailable input cannot fall back to legacy score or missing reference yield', () => {
  const model = input();
  model.context.rows[0].automatic_eligible = false;
  model.context.rows[0].selection_score = 99999;
  assert.equal(amountFor(allocateV9(model), 'S1'), 0);
  model.context.available = false;
  assert.ok(allocateV9(model).blockers.includes('evidence_unavailable'));
  assert.equal(allocateV9({ ...input(), account: { principal_cents: 0, exposures: [] } }).allocated_cents, 0);
});
test('existing concentration breaches cannot be labeled compliant by allocating other products', () => {
  const model = input();
  model.account.exposures = [{ key: 'old', amount_cents: 6000, bucket: 'short', product_key: 'old', family_key: 'old',
    evidence_tier: 'full_1y', liquidity_eligible: true }];
  const value = allocateV9(model);
  assert.equal(value.full_investment, false);
  assert.ok(value.blockers.includes('existing_product_cap'));
  assert.ok(value.blockers.includes('existing_family_cap'));
});
test('a fractional, inconsistent or timed-out solver result fails closed', () => {
  const bad = allocateV9(input(), { solve: () => ({ feasible: true, bounded: true, y_0: 0.5, z_0: 0 }) });
  assert.equal(bad.full_investment, false);
  assert.ok(bad.blockers.includes('allocation_not_verified'));
  let calls = 0;
  const incomplete = allocateV9(input(), { solve: model => ++calls > 1 ? null : solver.Solve(model) });
  assert.equal(incomplete.full_investment, false);
  assert.ok(incomplete.blockers.includes('allocation_preferences_not_verified'));
  const exhausted = allocateV9(input(), { clock: (() => { let value = 0; return () => value += 3000; })() });
  assert.equal(exhausted.full_investment, false);
  assert.ok(exhausted.blockers.includes('solver_budget_exhausted'));
});
