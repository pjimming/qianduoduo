'use strict';

const { CONTRACT, CONTRACT_HASH } = require('./contract');
const { pct } = require('./allocation');
const { bucketForTerm } = require('../../../lib/yield-policy');
const { isoDate } = require('../r2-screening/calendar');
const safe = n => Number.isSafeInteger(n) && n >= 0;

// Validate the exact post-switch exposure against the same principal and caps
// used by allocation. No extra purchase budget or assumed future quota is added.
function validateReplacementPortfolio({ account, settings = {}, holding, candidate, limits = null, amount_cents: amount }) {
  const reasons = [];
  const fail = reason => ({ ok: false, reasons: [reason] });
  if (!account?.verified || account.contract_hash !== CONTRACT_HASH || account.blockers?.length ||
      !safe(account.principal_cents) || account.principal_cents <= 0 || !safe(amount) || amount <= 0 ||
      !Array.isArray(account.exposures)) return fail('replacement_account_unverified');
  if (!candidate?.automatic_eligible || !limits?.product_key || !limits.family_key ||
      typeof limits.liquidity_eligible !== 'boolean' || !safe(limits.available_cents) ||
      limits.minimum_cents > amount || amount % limits.increment_cents !== 0 ||
      limits.available_cents < amount || !['full_1y', 'six_month', 'three_month'].includes(candidate.evidence_tier)) {
    return fail('replacement_limits_unverified');
  }
  const singlePct = settings.max_single_pct ?? CONTRACT.max_single_pct;
  const liquidityPct = settings.liquidity_floor_pct ?? CONTRACT.liquidity_floor_pct;
  if (!Number.isFinite(singlePct) || singlePct < 25 || singlePct > CONTRACT.max_single_pct ||
      !Number.isFinite(liquidityPct) || liquidityPct < CONTRACT.liquidity_floor_pct || liquidityPct > 100) return fail('settings_invalid');
  const source = account.exposures.filter(row => row.lot_id === holding?.lot_id && row.source === 'confirmed_holding');
  if (source.length !== 1 || source[0].product_code !== holding.product_code || !safe(source[0].amount_cents) ||
      source[0].amount_cents < amount) return fail('replacement_source_committed');
  const bucket = bucketForTerm(candidate.term?.days);
  if (bucket !== source[0].bucket || !Number.isInteger(candidate.term?.days) || candidate.term.days < 1 ||
      candidate.term.days > CONTRACT.max_term_days) return fail('replacement_bucket_changed');
  const rows = account.exposures.map(row => row === source[0] ? { ...row, amount_cents: row.amount_cents - amount } : { ...row });
  rows.push({ amount_cents: amount, product_key: limits.product_key, family_key: limits.family_key,
    product_code: candidate.mapping?.product_code, evidence_tier: candidate.evidence_tier, bucket,
    liquidity_eligible: limits.liquidity_eligible, available_on: limits.available_on });
  const seen = new Set();
  for (const row of rows) {
    if (!safe(row.amount_cents) || !row.product_key || !row.family_key ||
        !['cash','short','medium','long'].includes(row.bucket) ||
        !['full_1y','six_month','three_month','one_month','no_data'].includes(row.evidence_tier)) return fail('replacement_exposure_unverified');
  }
  const total = rows.reduce((n,row)=>n+row.amount_cents,0);
  if (!safe(total) || total !== account.committed_cents || !safe(account.blocked_cash_cents) || total + account.blocked_cash_cents > account.principal_cents) return fail('replacement_account_unverified');
  const sum = (field, key) => rows.filter(row => row[field] === key).reduce((n,row)=>n+row.amount_cents,0);
  if (CONTRACT.bucket_caps_pct[bucket] !== undefined &&
      sum('bucket', bucket) > pct(account.principal_cents, CONTRACT.bucket_caps_pct[bucket])) {
    reasons.push(`replacement_${bucket}_bucket_cap`);
  }
  for (const row of rows.filter(row => row.amount_cents > 0)) {
    if (seen.has(row.product_key)) continue;
    seen.add(row.product_key);
    if (sum('product_key',row.product_key) > pct(account.principal_cents,singlePct)) reasons.push('replacement_product_cap');
  }
  for (const key of new Set(rows.map(row=>row.family_key))) if (sum('family_key',key) > pct(account.principal_cents,CONTRACT.max_strategy_family_pct)) reasons.push('replacement_family_cap');
  for (const [tier,cap] of Object.entries(CONTRACT.evidence_caps)) {
    if (sum('evidence_tier',tier) > pct(account.principal_cents,cap.aggregate)) reasons.push('replacement_evidence_tier_cap');
    for (const row of rows.filter(row=>row.evidence_tier===tier && row.amount_cents > 0)) if (sum('product_key',row.product_key)>pct(account.principal_cents,cap.single)) reasons.push('replacement_evidence_single_cap');
  }
  const liquid = rows.filter(row=>row.liquidity_eligible).reduce((n,row)=>n+row.amount_cents,0);
  const liquidBefore = account.exposures.filter(row=>row.liquidity_eligible).reduce((n,row)=>n+row.amount_cents,0);
  if (liquid < pct(account.principal_cents,liquidityPct) || liquid < liquidBefore) reasons.push('replacement_liquidity_conflict');
  const needs=settings.cash_needs ?? [];
  if(!Array.isArray(needs)||needs.length>12||needs.some(row=>!isoDate(row.by_date)||!safe(row.required_cents))) return fail('cash_needs_invalid');
  const free=account.principal_cents-total-account.blocked_cash_cents;
  for(const need of needs){
    const available=free+rows.filter(row=>isoDate(row.available_on)&&row.available_on<=need.by_date).reduce((n,row)=>n+row.amount_cents,0);
    if(available<need.required_cents) reasons.push('replacement_cashflow_conflict');
  }
  return { ok: reasons.length===0, reasons:[...new Set(reasons)] };
}
module.exports={validateReplacementPortfolio};
