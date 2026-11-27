'use strict';

const { CONTRACT, fingerprint, freeze } = require('./contract');

const KEY = 'r2_strategy_policy_settings_v1';
const FIELDS = freeze({
  screening: {
    min_monthly_yield: [Number(CONTRACT.min_monthly_yield), -20, 30, 0.0001],
    max_data_age_days: [CONTRACT.max_data_age_days, 0, 30, 1],
    max_term_days: [CONTRACT.max_term_days, 1, 3650, 1],
    drawdown_watch_pct: [1, 0.01, 100, 0.01],
    drawdown_reject_pct: [1.5, 0.01, 100, 0.01],
    shortlist_per_group: [3, 1, 30, 1],
    frequent_zero_count: [3, 1, 6, 1],
    equity_review_pct: [5, 0, 100, 0.01],
    low_quota_hint_cny: [10000, 0, 1e12, 1],
  },
  allocation: {
    principal_override: [null, 0, 1e12, 0.01],
    max_single_pct: [CONTRACT.max_single_pct, 25, 30, 0.01],
    liquidity_floor_pct: [CONTRACT.liquidity_floor_pct, 30, 100, 0.01],
    medium_cap_pct: [CONTRACT.bucket_caps_pct.medium, 0, 100, 0.01],
    long_cap_pct: [CONTRACT.bucket_caps_pct.long, 0, 100, 0.01],
    max_strategy_family_pct: [CONTRACT.max_strategy_family_pct, 1, 50, 0.01],
    six_month_single_pct: [CONTRACT.evidence_caps.six_month.single, 0, 10, 0.01],
    six_month_aggregate_pct: [CONTRACT.evidence_caps.six_month.aggregate, 0, 20, 0.01],
    three_month_single_pct: [CONTRACT.evidence_caps.three_month.single, 0, 10, 0.01],
    three_month_aggregate_pct: [CONTRACT.evidence_caps.three_month.aggregate, 0, 20, 0.01],
    blank_quota_cny: [CONTRACT.blank_quota_assumption.lower_bound_cny, 0, 1e12, 1],
  },
  exit: {
    monthly_yield_threshold_pct: [Number(CONTRACT.exit_policy.monthly_yield_threshold_pct), -20, 30, 0.0001],
    recent_return_threshold_pct: [Number(CONTRACT.exit_policy.recent_return_threshold_pct), -10, 10, 0.00000001],
    observation_upper_pct: [2.5, -20, 30, 0.0001],
  },
  replacement: {
    min_yield_edge_pp: [0.15, 0, 30, 0.0001],
    break_even_margin_pp: [0.05, 0, 30, 0.0001],
    minimum_gain_cny: [1, 0, 1e6, 0.01],
    minimum_gain_90d_pct: [0.1, 0, 30, 0.0001],
    candidate_limit: [6, 1, 20, 1],
    short_comparison_days: [30, 1, 3650, 1],
    medium_comparison_days: [100, 1, 3650, 1],
    long_comparison_days: [360, 1, 3650, 1],
  },
});
const DEFAULT_POLICY = freeze(Object.fromEntries(Object.entries(FIELDS).map(([group, fields]) =>
  [group, Object.fromEntries(Object.entries(fields).map(([key, [value]]) => [key, value]))])));

function validatePolicy(value) {
  const invalid = (message, field) => {
    throw Object.assign(new Error(message), { code: 'invalid_policy_settings', statusCode: 400, data: { field } });
  };
  const hasShape = (input, shape) => input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).length === Object.keys(shape).length && Object.keys(shape).every(key => Object.hasOwn(input, key));
  if (!hasShape(value, FIELDS)) invalid('策略分组缺失或包含未知分组');
  for (const [group, fields] of Object.entries(FIELDS)) {
    if (!hasShape(value[group], fields)) invalid('策略参数缺失或包含未知参数', group);
    for (const [key, [, min, max, step]] of Object.entries(fields)) {
      const v = value[group][key];
      if (key === 'principal_override' && v === null) continue;
      const scale = Math.round(1 / step);
      if (!Number.isFinite(v) || v < min || v > max || Math.round(v * scale) / scale !== v) {
        invalid(`参数须在 ${min} 至 ${max} 之间，最小调整单位为 ${step}`, `${group}.${key}`);
      }
    }
  }
  const { screening, allocation } = value;
  if (screening.drawdown_watch_pct > screening.drawdown_reject_pct) invalid('回撤观察线须小于或等于淘汰线', 'screening.drawdown_reject_pct');
  if (Math.round(allocation.medium_cap_pct * 100) + Math.round(allocation.long_cap_pct * 100) > 10000) invalid('中期与长期上限合计不能超过 100%', 'allocation.long_cap_pct');
  for (const tier of ['six_month', 'three_month']) {
    if (allocation[`${tier}_single_pct`] > allocation[`${tier}_aggregate_pct`]) {
      invalid('证据层单只上限不能超过同层合计上限', `allocation.${tier}_aggregate_pct`);
    }
  }
  return value;
}

function readPolicy(db, allocationSettings) {
  const stored = db.prepare('SELECT value, updated_at FROM app_meta WHERE key=?').get(KEY);
  const values = stored ? JSON.parse(stored.value) : DEFAULT_POLICY;
  const settings = { ...values, allocation: { ...values.allocation,
    principal_override: allocationSettings ? allocationSettings.principal_override ?? null : values.allocation.principal_override,
    max_single_pct: allocationSettings?.max_single_pct ?? values.allocation.max_single_pct,
    liquidity_floor_pct: allocationSettings?.liquidity_floor_pct ?? values.allocation.liquidity_floor_pct,
  } };
  return { settings, revision: fingerprint({ settings, stamp: stored?.updated_at }), updated_at: stored?.updated_at ?? null };
}

function writePolicy(db, values) {
  const stamp = new Date().toISOString();
  db.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(KEY, JSON.stringify(values), stamp);
}

function effectiveLimits(settings = DEFAULT_POLICY.allocation) {
  return {
    bucket_caps_pct: { medium: settings.medium_cap_pct, long: settings.long_cap_pct },
    max_strategy_family_pct: settings.max_strategy_family_pct,
    evidence_caps: {
      six_month: { single: settings.six_month_single_pct, aggregate: settings.six_month_aggregate_pct },
      three_month: { single: settings.three_month_single_pct, aggregate: settings.three_month_aggregate_pct },
    },
  };
}

function configuredContract(policy) {
  const { allocation, screening, exit } = policy;
  return { ...CONTRACT, ...effectiveLimits(allocation),
    min_monthly_yield: String(screening.min_monthly_yield), max_term_days: screening.max_term_days,
    max_data_age_days: screening.max_data_age_days, max_single_pct: allocation.max_single_pct,
    liquidity_floor_pct: allocation.liquidity_floor_pct,
    bucket_targets: { cash: 0, short: (10000 - Math.round(allocation.medium_cap_pct * 100) - Math.round(allocation.long_cap_pct * 100)) / 100,
      medium: allocation.medium_cap_pct, long: allocation.long_cap_pct },
    blank_quota_assumption: { ...CONTRACT.blank_quota_assumption, lower_bound_cny: allocation.blank_quota_cny },
    exit_policy: { ...CONTRACT.exit_policy, recent_return_threshold_pct: String(exit.recent_return_threshold_pct),
      monthly_yield_threshold_pct: String(exit.monthly_yield_threshold_pct) },
    forced_exit: ['seven_day_return_below_threshold', `fresh_same_share_monthly_yield_below_${exit.monthly_yield_threshold_pct}`, 'same_share_6m_gt_3m_gt_1m'],
  };
}

function matchesScreeningPolicy(run, screening) {
  return fingerprint(run?.input?.screening_policy ?? DEFAULT_POLICY.screening) === fingerprint(screening);
}

module.exports = { FIELDS, DEFAULT_POLICY, validatePolicy, readPolicy, writePolicy, effectiveLimits, configuredContract, matchesScreeningPolicy };
