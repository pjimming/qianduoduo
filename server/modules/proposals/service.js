'use strict';

const { todayShanghai } = require('../../../lib/metrics');

function proposalError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createProposalsService({
  proposalsRepository,
  dashboardQuery,
  transactionManager,
  todayProvider = todayShanghai,
}) {
  function list() {
    const dashboard = dashboardQuery.getDashboard();
    return {
      decision_proposals: dashboard.decision_proposals,
      dashboard,
    };
  }

  function act(id, action, body) {
    let result;
    try {
      if (
        action === 'adopt' &&
        proposalsRepository.expireStaleYieldPolicyProposal(id)
      ) {
        throw proposalError(
          400,
          '提案收益策略已升级，请刷新后重新生成',
        );
      }
      result = transactionManager.run(() =>
        action === 'adopt'
          ? proposalsRepository.adoptProposal(id, todayProvider())
          : {
              proposal: proposalsRepository.rejectProposal(
                id,
                body.reason,
              ),
            },
      );
    } catch (error) {
      throw proposalError(400, error.message);
    }
    if (!result?.proposal) {
      throw proposalError(404, '没有找到这条决策提案');
    }
    return {
      result,
      dashboard: dashboardQuery.projectDashboard(),
    };
  }

  return {
    list,
    act,
  };
}

module.exports = {
  createProposalsService,
};
