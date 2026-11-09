'use strict';
// Entirely synthetic execution-chain fixture. No account or bank evidence.
const { screen } = require('../../server/modules/r2-screening/policy');
const { valuationCalendar } = require('../../server/modules/r2-screening/calendar');
const { CONTRACT_HASH, fingerprint } = require('../../server/modules/r2-strategy/contract');
const { shift } = require('../../server/modules/r2-screening/calendar');

function strategyFixture() {
  const date = '2026-11-07', stamp = '2026-11-07T04:00:00.000Z';
  const times = ['2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
  const products = [['S1', 30], ['S2', 30], ['S3', 30], ['M1', 90], ['M2', 90], ['L1', 180], ['L2', 180]].map(([code, days], i) => ({
    code, channel: 'TEST', name: `合成产品${code}`, issuer: '合成机构', min_amount: '1',
    performance_date: '2026-11-06', performance: { '1m': '2.5', '3m': '2.4', '6m': '2.4', '1y': '2.4' },
    quota: { status: 0, amount: null, checked_at: stamp },
    detail: { registration: `Z1234567890${i}`, term: { kind: 'minimum', days }, category: 'bond', valuation_basis: 'trading_days' },
    nav: { points: times.map((date, n) => ({ date, unit: `1.00${n}` })) },
  }));
  const screened = screen(products, date, valuationCalendar);
  const sourceSnapshot = { run: { id: 1, created_at: stamp, rule_version: 'v9', status: 'succeeded', business_date: date,
    counts: screened.counts, health: { pool: { requested: 1, ok: 1, included: products.length } } },
    rows: screened.results.map((data, i) => ({ source: 'cmb', channel: data.channel, code: data.code,
      data, nav_hash: fingerprint(products[i].nav.points) })), evidence: products.map(row => {
      const summary = { performance_date: row.performance_date, performance: row.performance, risk: 'R2', currency: 'CNY', public_offering: true };
      return { source: 'cmb', channel: row.channel, code: row.code, kind: 'performance', summary, hash: fingerprint(summary), url: 'https://example.invalid/synthetic', checked_at: stamp };
    }) };
  const mappings = products.map((row, i) => ({ id: i + 1, source: 'cmb', channel: row.channel, sales_code: row.code,
    product_code: row.code, registration_code: row.detail.registration, verified_by: 'fixture', verified_at: stamp, evidence_hash: fingerprint(row), revoked_at: null }));
  const hash = fingerprint('synthetic-proof');
  const doc = () => ({ hash, version: 'synthetic-v1', read_and_verified: true, checked_on: date });
  const checks = products.map((row, i) => ({ id: i + 1, mapping_id: i + 1, lot_id: '', version: 1, verified_by: 'fixture', verified_at: stamp,
    facts: { kind: 'product_pretrade', payload_version: 1, status: 'verified', identity: { source: 'cmb', channel: row.channel, code: row.code },
      registration_code: row.detail.registration, terms: { document: doc(), kind: row.detail.term.kind, days: row.detail.term.days,
        timing: { verified: true, earliest_funds_available_on: shift('2026-11-09', row.detail.term.days + 2),
          expected_confirm_on: '2026-11-09', expected_redeem_on: shift('2026-11-09', row.detail.term.days),
          expected_arrival_on: shift('2026-11-09', row.detail.term.days + 2), calculation_basis: '合成日历夹具',
          holding_day_basis: 'calendar_days', redemption_calendar: 'synthetic-calendar-v1', arrival_calendar: 'synthetic-calendar-v1', application_cutoff: '15:00' } },
      fees: { purchase_bps: 0, redemption_bps: 0, evidence_hash: hash },
      assets: { prospectus: doc(), report: { ...doc(), is_latest_available: true, period_end: '2026-09-30' },
        allowed_assets_verified: true, actual_assets_verified: true, equity_upper_pct: 0, duration_years: 0.3,
        prohibited_exposure: { property_bonds: false, low_rated_lgv_bonds: false, nonstandard_trust: false, directional_derivatives: false } },
      app: { as_of: date, can_buy: true, available_cents: 3000, max_order_cents: 3000, sales_restrictions_verified: true, evidence_hash: hash },
      allocation: { minimum_cents: 100, increment_cents: 100, liquidity_eligible: row.detail.term.days === 30,
        liquidity_basis_verified: true, liquidity_evidence_hash: hash,
        strategy_family: { key: `synthetic-family-${i}`, basis: 'verified_underlying', evidence_hash: hash } } } }));
  return { date, state: { schema_version: 1, mode: 'v9', activation_seq: 1, contract_hash: CONTRACT_HASH },
    sourceSnapshot, mappings, checks, portfolio: { principal: 100, holdings: [], trades: [], decisions: [], reservations: [] },
    collected: { products: products.map((row, index) => ({ ...row, evidence: [sourceSnapshot.evidence[index]] })),
      input: { share_count: products.length }, health: sourceSnapshot.run.health } };
}
module.exports = { strategyFixture };
