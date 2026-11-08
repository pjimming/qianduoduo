'use strict';

const { createHash } = require('node:crypto');
const { V9_EXECUTION_STRATEGY_VERSION } = require('../../../lib/r2-policy');

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (typeof value.toJSON === 'function') return stableJson(value.toJSON());
  if (Array.isArray(value)) return `[${Array.from(value, item => stableJson(item) ?? 'null').join(',')}]`;
  return `{${Object.keys(value).sort().map(key => [key, stableJson(value[key])]).filter(([, json]) => json !== undefined)
    .map(([key, json]) => `${JSON.stringify(key)}:${json}`).join(',')}}`;
}
const fingerprint = value => createHash('sha256').update(stableJson(value)).digest('hex');
function freeze(value) {
  for (const item of Object.values(value)) if (item && typeof item === 'object') freeze(item);
  return Object.freeze(value);
}

const CONTRACT = freeze({
  payload_version: 1,
  execution_version: V9_EXECUTION_STRATEGY_VERSION,
  selection_policy_version: 'v9',
  allocation_policy_version: 'r2-v9-bucket-allocation-v1',
  yield_policy_version: 'r2-term-yield-v1',
  holding_review_version: 'r2-v9-holding-review-v1',
  evaluation_policy_version: 'r2-v9-eval-v1',
  min_monthly_yield: '2.15', max_data_age_days: 6, max_term_days: 190,
  bucket_targets: { cash: 0, short: 30, medium: 35, long: 35 },
  liquidity_floor_pct: 30, max_single_pct: 30, max_strategy_family_pct: 50,
  evidence_caps: { six_month: { single: 10, aggregate: 20 }, three_month: { single: 10, aggregate: 20 } },
  group_order: ['term_days_asc', 'category_asc'],
  group_distribution: 'equal_first_round_then_stable_rounds',
  blank_quota_assumption: { lower_bound_cny: 50000000, source: 'user_rule', bank_disclosed: false },
  forced_exit: ['fresh_same_share_monthly_yield_below_2.15'],
  risk_review_only: ['drawdown', 'term', 'asset'],
  not_exit_conditions: ['sold_out', 'not_top_three'],
  max_snapshot_bytes: 65536,
});
const CONTRACT_HASH = fingerprint(CONTRACT);

module.exports = { CONTRACT, CONTRACT_HASH, fingerprint, stableJson, freeze };
