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
  todayProvider = todayShanghai,
}) {
  function validate(body) {
    const result = validateDecisionPayload(body, {
      today: todayProvider(),
    });
    if (result.error) throw decisionError(400, result.error);
    return result.value;
  }

  function evaluate(trigger) {
    decisionsRepository.runEvaluationCycle(trigger, todayProvider());
  }

  function createDecision(body) {
    const decision = decisionsRepository.createDecision(validate(body));
    evaluate('decision-create');
    return {
      decision,
      dashboard: dashboardQuery.getDashboard(),
    };
  }

  function updateDecision(id, body) {
    const decision = decisionsRepository.updateDecision(id, validate(body));
    if (!decision) throw decisionError(404, '没有找到这条决策记录');
    evaluate('decision-update');
    return {
      decision,
      dashboard: dashboardQuery.getDashboard(),
    };
  }

  function deleteDecision(id) {
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
      dashboard: dashboardQuery.getDashboard(),
    };
  }

  return {
    createDecision,
    deleteDecision,
    updateDecision,
  };
}

module.exports = {
  createDecisionsService,
  decisionError,
};
