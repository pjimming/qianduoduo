'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { publicQuotaLimit, reviewPretrade } = require('../server/modules/r2-strategy/pretrade');

const hash = 'a'.repeat(64);
const document = () => ({ read_and_verified: true, hash, version: '2026Q3', checked_on: '2026-11-07' });
function input() {
  const identity = { source: 'cmb', channel: 'D07', code: 'A' };
  return { date: '2026-11-07', amountCents: 10000,
    row: { identity, automatic_eligible: true, mapping: { id: 1 }, registration: 'Z1234567890', evidence_hash: hash,
      term: { kind: 'minimum', days: 30 }, min_amount: '1', quota: { status: 0, amount: null } },
    check: { id: 1, mapping_id: 1, lot_id: '', verified_by: 'local-user', verified_at: '2026-11-07T04:00:00Z', facts: {
      kind: 'product_pretrade', payload_version: 1, identity, registration_code: 'Z1234567890', status: 'verified',
      terms: { document: document(), days: 30, kind: 'minimum', timing: { verified: true, earliest_funds_available_on: '2026-12-10',
        expected_confirm_on: '2026-11-09', expected_redeem_on: '2026-12-09', expected_arrival_on: '2026-12-10',
        calculation_basis: '确认持有30天后首个赎回交易日、赎回确认及到账均按核验日历', holding_day_basis: 'calendar_days',
        redemption_calendar: 'verified-product-calendar-v1', arrival_calendar: 'verified-bank-calendar-v1', application_cutoff: '15:00' } },
      assets: { prospectus: document(), report: { ...document(), is_latest_available: true, period_end: '2026-09-30' },
        allowed_assets_verified: true, actual_assets_verified: true, equity_upper_pct: 5, duration_years: null,
        duration_status: 'pending', maturity_distribution_verified: true, maturity_distribution_hash: hash,
        prohibited_exposure: { property_bonds: false, low_rated_lgv_bonds: false, nonstandard_trust: false, directional_derivatives: false } },
      fees: { purchase_bps: 0, redemption_bps: 0, evidence_hash: hash },
      app: { as_of: '2026-11-07', can_buy: true, sales_restrictions_verified: true, evidence_hash: hash, available_cents: 100000, max_order_cents: 10000 },
      allocation: { minimum_cents: 100, increment_cents: 100, liquidity_eligible: true, liquidity_basis_verified: true,
        liquidity_evidence_hash: hash, strategy_family: { key: 'verified-family', basis: 'benchmark_proxy', evidence_hash: hash } },
    } } };
}

test('quota decimal parsing preserves tiny amounts, strict upper bounds, units and user assumptions', () => {
  for (const [amount, expected] of [['剩余额度 0.01 元', 1], ['剩余额度 0.009 元', 0], ['剩余额度 < 1 元', 99],
    ['剩余额度 < 1.009 元', 100], ['剩余额度 ≤ 1 元', 100], ['剩余额度 1.2 万元', 1200000], ['剩余额度 0.01 亿元', 100000000]]) {
    assert.equal(publicQuotaLimit({ status: 0, amount }).cents, expected);
  }
  const assumed = publicQuotaLimit({ status: 0, amount: null });
  assert.equal(assumed.cents, 5000000000);
  assert.equal(assumed.basis.bank_disclosed, false);
  assert.equal(publicQuotaLimit({ status: 1, amount: null }).cents, null);
  assert.equal(publicQuotaLimit({ status: 0, amount: '未获取到' }).cents, null);
  assert.equal(publicQuotaLimit({ status: 0, amount: '剩余额度 1,,2 元' }).cents, null);
});
test('complete same-share reviewed evidence clears an order while retaining proxy and quota provenance', () => {
  const value = reviewPretrade(input());
  assert.equal(value.executable, true);
  assert.equal(value.limits.product_key, 'registration:Z1234567890');
  assert.equal(value.limits.family_basis, 'benchmark_proxy');
  assert.equal(value.limits.quota_basis.bank_disclosed, false);
  assert.equal(value.limits.available_cents, 100000);
  assert.equal(value.limits.max_order_cents, 10000);
});
test('PDF URLs do not substitute for reading and verifying report/prospectus content', () => {
  const model = input();
  model.check.facts.assets.report = { url: 'https://example.com/report.pdf' };
  const value = reviewPretrade(model);
  assert.equal(value.executable, false);
  assert.ok(value.blockers.includes('assets_unverified'));
});
test('stale returns and App quota are separate gates; latest dated terms are not mechanically aged7days', () => {
  const model = input();
  model.row.automatic_eligible = false;
  assert.ok(reviewPretrade(model).blockers.includes('screening_not_automatic'));
  model.row.automatic_eligible = true;
  model.check.facts.app.as_of = '2026-11-06';
  assert.ok(reviewPretrade(model).blockers.includes('app_availability_unverified'));
  model.check.facts.app.as_of = model.date;
  model.check.facts.terms.document.checked_on = '2026-10-01';
  assert.equal(reviewPretrade(model).executable, true);
});
test('forbidden assets, unknown exposure and equity over5% never clear an order', () => {
  for (const change of [model => { model.check.facts.assets.equity_upper_pct = 5.01; },
    model => { model.check.facts.assets.prohibited_exposure.property_bonds = true; },
    model => { delete model.check.facts.assets.prohibited_exposure.nonstandard_trust; }]) {
    const model = input(); change(model);
    assert.equal(reviewPretrade(model).executable, false);
  }
});
test('formal term conflicts, missing calendars, absent distribution and withdrawals remain pending', () => {
  for (const change of [model => { model.check.facts.terms.days = 31; },
    model => { model.check.facts.terms.timing.arrival_calendar = ''; },
    model => { model.check.facts.assets.maturity_distribution_verified = false; },
    model => { model.check.facts.status = 'withdrawn'; },
    model => { model.check.facts.assets.report.period_end = '2026-12-31'; },
    model => { model.check.facts.terms.timing.application_cutoff = '25:00'; }]) {
    const model = input(); change(model);
    assert.equal(reviewPretrade(model).executable, false);
  }
});
test('an unmatched channel/mapping or registration never borrows another share clearance', () => {
  for (const change of [model => { model.check.mapping_id = 2; },
    model => { model.check.facts.identity = { ...model.row.identity, channel: 'OTHER' }; },
    model => { model.check.facts.registration_code = 'Z9999999999'; }]) {
    const model = input(); change(model);
    assert.equal(reviewPretrade(model).executable, false);
    assert.equal(reviewPretrade(model).limits, null);
  }
});
test('order amount validates minimum, increment, public quota and actual account maximum independently', () => {
  for (const amount of [0, 99, 101, 10100]) assert.ok(reviewPretrade({ ...input(), amountCents: amount }).blockers.includes('order_amount_invalid'));
  const model = input(); model.row.quota.amount = '剩余额度 0.01 元';
  assert.ok(reviewPretrade(model).blockers.includes('order_amount_invalid'));
});
test('partial asset review can retain an explicit simulation limit without creating execution clearance', () => {
  const model = input(); model.check.facts.status = 'pending'; model.check.facts.assets.actual_assets_verified = false;
  const value = reviewPretrade(model);
  assert.equal(value.executable, false);
  assert.equal(value.limits.increment_cents, 100);
});
