'use strict';

const { CONTRACT, CONTRACT_HASH, fingerprint, freeze } = require('./contract');
const { productFamilyKey } = require('../../../lib/products');
const { bucketForTerm } = require('../../../lib/yield-policy');
const { identityKey } = require('./evidence');
const { isoDate } = require('../r2-screening/calendar');

// Public screening only exposes display text. The old verified pretrade facts
// supplied order increments and availability dates; without them the adapter
// keeps the same allocation contract with conservative, documented defaults.
const PUBLIC_INCREMENT_CENTS = 100;

function publicQuotaLimit(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return {
      cents: CONTRACT.blank_quota_assumption.lower_bound_cny * 100,
      basis: { kind: 'user_rule_lower_bound', original: '', bank_disclosed: false },
    };
  }
  const text = String(value).trim();
  const parsed = text.match(
    /^\s*剩余\s*额度\s*[:：]?\s*([<>≤≥约]?)\s*([\d,]+(?:\.\d+)?)\s*(万|亿)?\s*元\s*$/,
  );
  if (!parsed) return null;
  const amount = Number(parsed[2].replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = parsed[3] === '亿' ? 1e10 : parsed[3] === '万' ? 1e6 : 100;
  const cents = Math.round(amount * unit);
  if (!Number.isSafeInteger(cents)) return null;
  const comparison = parsed[1];
  return {
    cents,
    basis: {
      kind: comparison === '<' || comparison === '≤' ? 'public_lower_bound' : 'public_amount',
      original: text,
      bank_disclosed: false,
    },
  };
}

function amountCents(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }
  const text = String(value).replace(/,/g, '');
  const parsed = text.match(/(\d+(?:\.\d+)?)\s*(万|亿)?/);
  if (!parsed) return null;
  const amount = Number(parsed[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round(amount * (parsed[2] === '亿' ? 1e10 : parsed[2] === '万' ? 1e6 : 100));
  return Number.isSafeInteger(cents) ? cents : null;
}

function buildPublicLimits({ row, product = null, date, amountCents: orderCents = null }) {
  if (!row || !isoDate(date)) throw new Error('公开额度核验需要有效的策略业务日');
  const blockers = [];
  if (!row.automatic_eligible) blockers.push('screening_not_automatic');
  const quota = publicQuotaLimit(row.quota?.amount);
  if (!quota || row.quota?.status !== 0) blockers.push('public_quota_unverified');
  const available = quota?.cents ?? 0;
  const parsedMinimum = amountCents(row.min_amount);
  const minimum = parsedMinimum ?? 100;
  if (row.min_amount !== null && row.min_amount !== undefined && row.min_amount !== '' && parsedMinimum === null) {
    blockers.push('minimum_amount_conflict');
  }
  const identity = row.identity;
  const registration = row.registration ?? row.mapping?.registration_code ?? null;
  const productKey = registration
    ? `registration:${registration}`
    : `sales_share:${identityKey(identity)}`;
  const familyKey = product
    ? productFamilyKey(product)
    : registration
      ? `registration:${registration}`
      : `sales_share:${identityKey(identity)}`;
  const termDays = row.term?.days;
  const limits = {
    minimum_cents: minimum,
    increment_cents: PUBLIC_INCREMENT_CENTS,
    available_cents: available,
    max_order_cents: available,
    product_key: productKey,
    product_key_basis: registration ? 'registration' : 'sales_share',
    family_key: familyKey,
    family_basis: product ? 'ledger_product_master' : registration ? 'registration' : 'sales_share',
    liquidity_eligible: bucketForTerm(termDays) === 'short',
    quota_basis: quota?.basis ?? null,
    available_on: null,
    increment_basis: 'public_default_one_yuan',
    availability_basis: 'public_quota_only',
  };
  if (orderCents !== null) {
    if (!Number.isSafeInteger(orderCents) || orderCents <= 0) blockers.push('order_amount_invalid');
    else if (orderCents < limits.minimum_cents) blockers.push('minimum_amount_conflict');
    else if (orderCents % limits.increment_cents !== 0) blockers.push('order_amount_invalid');
    else if (orderCents > limits.available_cents) blockers.push('order_amount_invalid');
  }
  const unique = [...new Set(blockers)];
  const body = {
    contract_hash: CONTRACT_HASH,
    business_date: date,
    blockers: unique,
    executable: unique.length === 0,
    limits,
    amount_cents: orderCents,
  };
  return freeze({ ...body, fingerprint: fingerprint(body) });
}

module.exports = {
  PUBLIC_INCREMENT_CENTS,
  amountCents,
  buildPublicLimits,
  publicQuotaLimit,
};
