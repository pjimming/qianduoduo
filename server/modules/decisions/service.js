'use strict';

const { todayShanghai } = require('../../../lib/metrics');
const { validateDecisionPayload } = require('./validation');

function decisionError(statusCode, message, payload = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (payload) error.payload = payload;
  return error;
}

function createDecisionsService({
  decisionsRepository,
  dashboardQuery,
  transactionManager,
  automationRunner = null,
  todayProvider = todayShanghai,
}) {
  function validate(body) {
    const result = validateDecisionPayload(body, {
      today: todayProvider(),
    });
    if (result.error) throw decisionError(400, result.error);
    return result.value;
  }

  async function evaluate(trigger) {
    if (automationRunner) {
      await automationRunner.run({
        today: todayProvider(),
        trigger,
      });
      return;
    }
    decisionsRepository.runEvaluationCycle(trigger, todayProvider());
  }

  async function createDecision(body) {
    const decision = decisionsRepository.createDecision(validate(body));
    await evaluate('decision-create');
    return {
      decision,
      dashboard: dashboardQuery.projectDashboard(),
    };
  }

  async function updateDecision(id, body) {
    const decision = decisionsRepository.updateDecision(id, validate(body));
    if (!decision) throw decisionError(404, '没有找到这条决策记录');
    await evaluate('decision-update');
    return {
      decision,
      dashboard: dashboardQuery.projectDashboard(),
    };
  }

  async function deleteDecision(id) {
    const linked = decisionsRepository.findLinkedTrade(id);
    if (linked) {
      throw decisionError(
        409,
        `决策 #${id} 已关联交易 #${linked.id}，请先改绑或撤销交易`,
        {
          error: `决策 #${id} 已关联交易 #${linked.id}，请先改绑或撤销交易`,
        },
      );
    }
    transactionManager.run(() => {
      const deleted = decisionsRepository.deleteDecision(id);
      if (!deleted) {
        throw decisionError(404, '没有找到这条决策记录');
      }
      decisionsRepository.detachProposal(
        id,
        `决策 #${id} 已删除，提案取消`,
      );
      decisionsRepository.discardEvaluations(id, `决策 #${id} 已删除`);
    });
    return {
      deleted: true,
      dashboard: dashboardQuery.projectDashboard(),
    };
  }

  function addPrediction(id, body) {
    if (!decisionsRepository.findDecision(id)) {
      throw decisionError(404, '没有找到这条决策');
    }
    const input = {
      recommendation_type: body.recommendation_type,
      action: body.action,
      source: body.source || 'human-correction',
      source_ref: body.source_ref,
      data_cutoff_at: body.data_cutoff_at,
      start_date: body.start_date,
      review_date: body.review_date,
      confidence: body.confidence,
      evidence_refs: body.evidence_refs,
      baseline: body.baseline,
      expected: body.expected,
      metric: body.metric,
      evaluation: body.evaluation,
      invalidation_condition: body.invalidation_condition,
      invalidation_triggers: body.invalidation_triggers,
      original_text: body.original_text,
      reason: body.reason,
    };
    const decision = decisionsRepository.addPredictionVersion(id, input);
    if (!decision) {
      throw decisionError(
        400,
        '预测字段不完整：至少需要复核日期和可检验目标',
      );
    }
    return {
      decision,
      prediction: decision.review_meta.predictions.at(-1),
      dashboard: dashboardQuery.projectDashboard(),
    };
  }

  return {
    addPrediction,
    createDecision,
    deleteDecision,
    updateDecision,
  };
}

module.exports = {
  createDecisionsService,
  decisionError,
};
