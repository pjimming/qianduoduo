'use strict';

const { CONTRACT, CONTRACT_HASH, fingerprint, freeze } = require('./contract');
const { identityKey } = require('./evidence');
const { isoDate } = require('../r2-screening/calendar');
const HASH = /^[a-f0-9]{64}$/;
const cents = value => Number.isSafeInteger(value) && value >= 0;
const checkedDocument = (value, date) => value?.read_and_verified === true && HASH.test(value.hash ?? '') &&
  typeof value.version === 'string' && Boolean(value.version.trim()) && Boolean(isoDate(value.checked_on) && value.checked_on <= date);

// Decimal money is floored at one cent. A public upper bound is never rounded
// upward; a lower bound is used only as a conservative simulation limit.
function publicQuotaLimit(quota) {
  if (quota?.status !== 0) return { cents: null, basis: { kind: 'unavailable', original: quota?.amount ?? null } };
  if (quota.amount === null || quota.amount === undefined || quota.amount === '') return {
    cents: CONTRACT.blank_quota_assumption.lower_bound_cny * 100,
    basis: { kind: 'user_rule_lower_bound', original: null, bank_disclosed: false, ...CONTRACT.blank_quota_assumption },
  };
  const original = String(quota.amount).normalize('NFKC');
  const found = original.match(/^\s*剩余\s*额度\s*[:：]?\s*([<>≤≥约]?)\s*([\d,]+(?:\.\d+)?)\s*(万|亿)?元\s*$/);
  if (!found) return { cents: null, basis: { kind: 'unrecognized', original } };
  const number = found[2].replaceAll(',', '');
  if (found[2].includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(found[2])) return { cents: null, basis: { kind: 'unrecognized', original } };
  if (!/^\d+(?:\.\d+)?$/.test(number) || number.length > 30) return { cents: null, basis: { kind: 'unrecognized', original } };
  const [whole, fraction = ''] = number.split('.');
  const scale = found[3] === '亿' ? 10000000000n : found[3] === '万' ? 1000000n : 100n;
  const denominator = 10n ** BigInt(fraction.length);
  const raw = (BigInt(whole) * denominator + BigInt(fraction || '0')) * scale;
  let value = raw / denominator;
  if (found[1] === '<' && raw % denominator === 0n && value > 0n) value--;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return { cents: null, basis: { kind: 'unrecognized', original } };
  return { cents: Number(value), basis: { kind: ['>', '≥'].includes(found[1]) ? 'public_lower_bound'
    : found[1] === '约' ? 'public_estimate' : 'public_amount', original, bank_disclosed: true } };
}

function reviewPretrade({ row, check, date, amountCents = null }) {
  if (!isoDate(date)) throw new Error('交易前复核业务日无效');
  const blockers = [];
  const facts = check?.facts ?? {};
  const identityValid = row?.mapping && check?.mapping_id === row.mapping.id && check?.lot_id === '' &&
    facts.kind === 'product_pretrade' && facts.payload_version === 1 && facts.identity &&
    identityKey(facts.identity) === identityKey(row.identity) && facts.registration_code === (row.registration ?? null);
  if (!identityValid) blockers.push('pretrade_identity_unverified');
  if (!row?.automatic_eligible) blockers.push('screening_not_automatic');
  if (facts.status !== 'verified') blockers.push(facts.status === 'withdrawn' ? 'pretrade_withdrawn' : 'pretrade_incomplete');
  if (!check?.verified_by || !isoDate(String(check?.verified_at ?? '').slice(0, 10)) || String(check.verified_at).slice(0, 10) > date) blockers.push('verifier_unavailable');
  const terms = facts.terms ?? {};
  if (!checkedDocument(terms.document, date) || !['minimum', 'closed'].includes(terms.kind) ||
      !Number.isSafeInteger(terms.days) || terms.days < 1 || terms.days > CONTRACT.max_term_days ||
      terms.days !== row?.term?.days || terms.kind !== row?.term?.kind) blockers.push('formal_terms_unverified');
  const timing = terms.timing ?? {};
  if (timing.verified !== true || !isoDate(timing.earliest_funds_available_on) || timing.earliest_funds_available_on < date ||
      !isoDate(timing.expected_confirm_on) || !isoDate(timing.expected_redeem_on) || !isoDate(timing.expected_arrival_on) ||
      timing.expected_confirm_on < date || timing.expected_redeem_on < timing.expected_confirm_on ||
      timing.expected_arrival_on < timing.expected_redeem_on || timing.expected_arrival_on !== timing.earliest_funds_available_on ||
      !timing.calculation_basis || !timing.holding_day_basis || !timing.redemption_calendar || !timing.arrival_calendar ||
      !/^\d{2}:\d{2}$/.test(timing.application_cutoff ?? '') ||
      Number(timing.application_cutoff?.slice(0, 2)) > 23 || Number(timing.application_cutoff?.slice(3)) > 59) blockers.push('settlement_path_unverified');
  const fees = facts.fees ?? {};
  if (!['purchase_bps', 'redemption_bps'].every(key => typeof fees[key] === 'number' && Number.isFinite(fees[key]) && fees[key] >= 0 && fees[key] <= 500) ||
      !HASH.test(fees.evidence_hash ?? '')) blockers.push('fees_unverified');
  const assets = facts.assets ?? {};
  if (!checkedDocument(assets.prospectus, date) || !checkedDocument(assets.report, date) ||
      assets.allowed_assets_verified !== true || assets.actual_assets_verified !== true || assets.report.is_latest_available !== true ||
      !isoDate(assets.report.period_end) || assets.report.period_end > date) blockers.push('assets_unverified');
  const prohibited = ['property_bonds', 'low_rated_lgv_bonds', 'nonstandard_trust', 'directional_derivatives'];
  if (!prohibited.every(key => assets.prohibited_exposure?.[key] === false)) blockers.push('prohibited_assets_or_unknown');
  if (typeof assets.equity_upper_pct !== 'number' || !Number.isFinite(assets.equity_upper_pct) || assets.equity_upper_pct < 0 || assets.equity_upper_pct > 5) blockers.push('equity_limit_unverified');
  if (!(typeof assets.duration_years === 'number' && Number.isFinite(assets.duration_years) && assets.duration_years >= 0) &&
      !(assets.duration_status === 'pending' && assets.maturity_distribution_verified === true && HASH.test(assets.maturity_distribution_hash ?? ''))) blockers.push('duration_or_distribution_unverified');
  const app = facts.app ?? {};
  if (app.as_of !== date || app.can_buy !== true || app.sales_restrictions_verified !== true ||
      !HASH.test(app.evidence_hash ?? '') || !cents(app.available_cents) ||
      (app.max_order_cents !== null && app.max_order_cents !== undefined && !cents(app.max_order_cents))) blockers.push('app_availability_unverified');
  const allocation = facts.allocation ?? {};
  const family = allocation.strategy_family ?? {};
  const limitsValid = identityValid && cents(allocation.minimum_cents) && cents(allocation.increment_cents) && allocation.increment_cents > 0 &&
    typeof family.key === 'string' && family.key.trim().length > 0 && ['verified_underlying', 'benchmark_proxy'].includes(family.basis) &&
    HASH.test(family.evidence_hash ?? '') && typeof allocation.liquidity_eligible === 'boolean' &&
    (allocation.liquidity_eligible !== true || (allocation.liquidity_basis_verified === true && HASH.test(allocation.liquidity_evidence_hash ?? '')));
  if (!limitsValid) blockers.push('allocation_limits_unverified');
  const quota = publicQuotaLimit(row?.quota);
  if (quota.cents === null) blockers.push('public_quota_unverified');
  const publicMinimum = row?.min_amount === null || row?.min_amount === undefined || row?.min_amount === '' ? null : Number(row.min_amount);
  if (publicMinimum !== null && (!Number.isFinite(publicMinimum) || publicMinimum < 0 || allocation.minimum_cents < Math.ceil(publicMinimum * 100 - 1e-8))) blockers.push('minimum_amount_conflict');
  // A simulation may use public quota while App clearance is still pending;
  // it can never become executable until every review item above is complete.
  const available = quota.cents === null ? null : Math.min(quota.cents, cents(app.available_cents) && app.as_of === date ? app.available_cents : quota.cents);
  const limits = limitsValid && available !== null ? {
    minimum_cents: allocation.minimum_cents, increment_cents: allocation.increment_cents,
    available_cents: available, max_order_cents: cents(app.max_order_cents) && app.as_of === date ? app.max_order_cents : available,
    product_key: row.registration ? `registration:${row.registration}` : `sales_share:${identityKey(row.identity)}`,
    product_key_basis: row.registration ? 'registration' : 'sales_share_proxy',
    family_key: family.key, family_basis: family.basis,
    liquidity_eligible: allocation.liquidity_eligible, quota_basis: quota.basis,
    available_on: isoDate(timing.earliest_funds_available_on),
  } : null;
  if (amountCents !== null && (!cents(amountCents) || amountCents <= 0 || !limits || amountCents < Math.max(1, limits.minimum_cents) ||
      (amountCents - Math.max(1, limits.minimum_cents)) % limits.increment_cents !== 0 ||
      amountCents > limits.available_cents || amountCents > limits.max_order_cents)) blockers.push('order_amount_invalid');
  const result = { contract_hash: CONTRACT_HASH, business_date: date, check_id: check?.id ?? null,
    mapping_id: row?.mapping?.id ?? null, evidence_hash: row?.evidence_hash ?? null,
    blockers: [...new Set(blockers)], executable: blockers.length === 0, limits };
  return freeze({ ...result, fingerprint: fingerprint(result) });
}

module.exports = { publicQuotaLimit, reviewPretrade };
