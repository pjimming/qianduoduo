'use strict';

function createDecisionsRepository(repository) {
  if (!repository) throw new Error('decisions repository 需要 repository');
  return {
    createDecision(decision) {
      return repository.createDecision(decision);
    },
    addPredictionVersion(id, input) {
      return repository.addPredictionVersion(id, input);
    },
    deleteDecision(id) {
      return repository.deleteDecision(id);
    },
    detachProposal(decisionId, reason) {
      return repository.decisionProposalStore.detachDecision(
        decisionId,
        reason,
      );
    },
    discardEvaluations(decisionId, reason) {
      return repository.automationStore.discardDecisionEvaluations(
        decisionId,
        reason,
      );
    },
    findLinkedTrade(decisionId) {
      return repository.tradeStore
        .listTrades()
        .find((trade) => trade.decision_id === decisionId) || null;
    },
    findDecision(id) {
      return repository
        .listDecisions()
        .find((decision) => Number(decision.id) === Number(id)) || null;
    },
    runEvaluationCycle(trigger, today) {
      return repository.automationStore.runCycle({
        today,
        trigger,
      });
    },
    updateDecision(id, decision) {
      return repository.updateDecision(id, decision);
    },
  };
}

module.exports = {
  createDecisionsRepository,
};
