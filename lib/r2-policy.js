'use strict';

const DAILY_OPEN_TARGET_PCT = 0;
const TARGET3_STRATEGY_VERSION = 'r2-3pct-v1';
const TARGET3_BUCKET_TARGETS = Object.freeze({
  short: 30,
  medium: 35,
  long: 35,
});
const DAILY_OPEN_PLAN_KEYS = Object.freeze(['cash', 'liquid', 'daily_open']);

function isTarget3Strategy(strategyVersion, targetAnnualized = null) {
  const version = String(strategyVersion || '').trim();
  if (version === TARGET3_STRATEGY_VERSION || /target3/i.test(version)) return true;
  return /3pct/i.test(version) && Number(targetAnnualized) === 3;
}

function planObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function dailyOpenTargetPct(plan) {
  const source = planObject(plan);
  let target = 0;
  for (const key of DAILY_OPEN_PLAN_KEYS) {
    const value = Number(source[key]);
    if (Number.isFinite(value)) target = Math.max(target, value);
  }
  return target;
}

function validateDecisionBucketPolicy(plan, options = {}) {
  const source = planObject(plan);
  for (const key of DAILY_OPEN_PLAN_KEYS) {
    if (source[key] === null || source[key] === undefined || source[key] === '') continue;
    const value = Number(source[key]);
    if (!Number.isFinite(value) || Math.abs(value - DAILY_OPEN_TARGET_PCT) > 0.0001) {
      return `本项目日开新增额度固定为 ${DAILY_OPEN_TARGET_PCT}%，不能设置日开目标仓位`;
    }
  }
  if (!isTarget3Strategy(options.strategyVersion, options.targetAnnualized)) return null;
  for (const [key, expected] of Object.entries(TARGET3_BUCKET_TARGETS)) {
    if (source[key] === null || source[key] === undefined || source[key] === '') continue;
    const value = Number(source[key]);
    if (!Number.isFinite(value) || Math.abs(value - expected) > 0.0001) {
      return `${TARGET3_STRATEGY_VERSION} 固定为短期 ${TARGET3_BUCKET_TARGETS.short}% / 中期 ${TARGET3_BUCKET_TARGETS.medium}% / 长期 ${TARGET3_BUCKET_TARGETS.long}%`;
    }
  }
  return null;
}

function normalizeDecisionBucketPlan(value, options = {}) {
  const plan = planObject(value);
  for (const key of DAILY_OPEN_PLAN_KEYS) {
    plan[key] = DAILY_OPEN_TARGET_PCT;
  }
  if (isTarget3Strategy(options.strategyVersion, options.targetAnnualized)) {
    Object.assign(plan, TARGET3_BUCKET_TARGETS);
  }
  return plan;
}

module.exports = {
  DAILY_OPEN_TARGET_PCT,
  TARGET3_STRATEGY_VERSION,
  TARGET3_BUCKET_TARGETS,
  dailyOpenTargetPct,
  isTarget3Strategy,
  normalizeDecisionBucketPlan,
  validateDecisionBucketPolicy,
};
