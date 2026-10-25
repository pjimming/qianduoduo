'use strict';

function createProposalsRepository(repository) {
  if (!repository) throw new Error('proposals repository 需要 repository');
  return {
    adoptProposal(id, today) {
      return repository.decisionProposalStore.adoptProposal(id, { today });
    },
    expireInvalidCashProposal(id) {
      return repository.decisionProposalStore.expireInvalidCashProposal(id);
    },
    expireStaleYieldPolicyProposal(id) {
      return repository.decisionProposalStore.expireStaleYieldPolicyProposal(
        id,
      );
    },
    getProposal(id) {
      return repository.decisionProposalStore.getProposal(id);
    },
    rejectProposal(id, reason) {
      return repository.decisionProposalStore.rejectProposal(id, {
        reason,
      });
    },
  };
}

module.exports = {
  createProposalsRepository,
};
