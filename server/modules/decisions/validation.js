'use strict';

const { parseYmd, todayShanghai } = require('../../../lib/metrics');
const {
  TARGET3_STRATEGY_VERSION,
  normalizeDecisionBucketPlan,
  validateDecisionBucketPolicy,
} = require('../../../lib/r2-policy');

const DECISION_ACTIONS = new Set(['买入', '赎回', '切换', '观察']);
const DECISION_RATINGS = new Set([
  '待评估',
  '流程正确，结果好',
  '流程正确，结果差',
  '流程错误，结果好',
  '流程错误，结果差',
]);

function validateDecisionPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '决策日志格式不正确' };
  }
  const today = options.today || todayShanghai();
  const date = String(payload.date ?? options.date ?? '').trim();
  if (!parseYmd(date)) return { error: '决策日期格式应为 YYYY-MM-DD' };
  if (date > today) return { error: '不能记录未来日期' };
  const productName = String(payload.product_name || '').trim();
  if (!productName) return { error: '请填写产品名称' };
  if (productName.length > 100) return { error: '产品名称不能超过 100 个字符' };
  const action = String(payload.action || '').trim();
  if (!DECISION_ACTIONS.has(action)) {
    return { error: '动作必须是买入、赎回、切换或观察' };
  }
  const reason = String(payload.reason || '').trim();
  if (!reason) return { error: '请填写当时的理由' };
  if (reason.length > 1000) return { error: '理由不能超过 1000 个字符' };
  const expectation = String(payload.expectation || '').trim();
  if (!expectation) return { error: '请填写收益、流动性或风险预期' };
  if (expectation.length > 1000) return { error: '预期不能超过 1000 个字符' };
  const invalidationCondition = String(
    payload.invalidation_condition || '',
  ).trim();
  if (!invalidationCondition) {
    return { error: '请填写失效条件，明确什么变化会推翻这次决策' };
  }
  if (invalidationCondition.length > 1000) {
    return { error: '失效条件不能超过 1000 个字符' };
  }
  const actualResult = String(payload.actual_result || '').trim();
  if (actualResult.length > 1000) return { error: '实际结果不能超过 1000 个字符' };
  const rating = String(payload.rating || '待评估').trim();
  if (!DECISION_RATINGS.has(rating)) {
    return { error: '事后评价不在允许范围内' };
  }
  const strategyVersion = String(
    payload.strategy_version || TARGET3_STRATEGY_VERSION,
  ).trim();
  if (!strategyVersion || strategyVersion.length > 60) {
    return { error: '策略版本需要填写，且不能超过 60 个字符' };
  }
  const targetAnnualized = Number(payload.target_annualized ?? 3);
  if (
    !Number.isFinite(targetAnnualized) ||
    targetAnnualized <= 0 ||
    targetAnnualized > 20
  ) {
    return { error: '目标年化需要是 0–20 之间的数字' };
  }
  let bucketPlanInput = payload.bucket_plan ?? {};
  if (typeof bucketPlanInput === 'string') {
    try {
      bucketPlanInput = JSON.parse(bucketPlanInput);
    } catch {
      return { error: '期限桶计划不是有效的 JSON' };
    }
  }
  if (
    !bucketPlanInput ||
    typeof bucketPlanInput !== 'object' ||
    Array.isArray(bucketPlanInput)
  ) {
    return { error: '期限桶计划格式不正确' };
  }
  const policyError = validateDecisionBucketPolicy(bucketPlanInput, {
    strategyVersion,
    targetAnnualized,
  });
  if (policyError) return { error: policyError };
  if (
    /r2-3pct|target3/i.test(strategyVersion) &&
    Math.abs(targetAnnualized - 3) > 0.0001
  ) {
    return { error: `${TARGET3_STRATEGY_VERSION} 的目标年化固定为 3.00%` };
  }
  const bucketPlan = {};
  for (const key of ['short', 'medium', 'long', 'max_single']) {
    if (
      bucketPlanInput[key] === null ||
      bucketPlanInput[key] === undefined ||
      bucketPlanInput[key] === ''
    ) {
      continue;
    }
    const value = Number(bucketPlanInput[key]);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return { error: '期限桶比例需要是 0–100 的数字' };
    }
    bucketPlan[key] = value;
  }
  Object.assign(
    bucketPlan,
    normalizeDecisionBucketPlan(bucketPlan, {
      strategyVersion,
      targetAnnualized,
    }),
  );
  const evaluationInput = Array.isArray(payload.evaluation_at)
    ? payload.evaluation_at
    : String(payload.evaluation_at || 'buy_day,holding,maturity').split(',');
  const allowedStages = new Set(['buy_day', 'holding', 'maturity']);
  const evaluationAt = evaluationInput
    .map((item) => String(item).trim())
    .filter(Boolean);
  if (
    !evaluationAt.length ||
    evaluationAt.some((item) => !allowedStages.has(item))
  ) {
    return { error: '评估时点必须是 buy_day、holding 或 maturity' };
  }
  const evidenceDate = String(payload.evidence_date || '').trim();
  if (!evidenceDate) return { error: '请填写证据日期' };
  if (!parseYmd(evidenceDate)) {
    return { error: '证据日期格式应为 YYYY-MM-DD' };
  }
  if (evidenceDate > today) {
    return { error: '证据日期不能晚于今天' };
  }
  const verifyDate = String(payload.verify_date || '').trim();
  if (!verifyDate) return { error: '请填写事后验证日期' };
  if (!parseYmd(verifyDate)) {
    return { error: '事后验证日期格式应为 YYYY-MM-DD' };
  }
  if (verifyDate < evidenceDate) {
    return { error: '事后验证日期不能早于证据日期' };
  }
  let reviewMeta = payload.review_meta ?? {};
  if (typeof reviewMeta === 'string') {
    try {
      reviewMeta = JSON.parse(reviewMeta);
    } catch {
      return { error: '替换测算不是有效的 JSON' };
    }
  }
  if (
    !reviewMeta ||
    typeof reviewMeta !== 'object' ||
    Array.isArray(reviewMeta)
  ) {
    return { error: '替换测算格式不正确' };
  }
  if (JSON.stringify(reviewMeta).length > 8000) {
    return { error: '替换测算内容过长' };
  }
  return {
    value: {
      date,
      product_name: productName,
      action,
      reason,
      expectation,
      invalidation_condition: invalidationCondition,
      actual_result: actualResult,
      strategy_version: strategyVersion,
      target_annualized: Math.round(targetAnnualized * 100) / 100,
      bucket_plan: bucketPlan,
      evaluation_at: [...new Set(evaluationAt)],
      evidence_date: evidenceDate,
      verify_date: verifyDate,
      review_meta: reviewMeta,
      rating,
    },
  };
}

module.exports = { validateDecisionPayload };
