'use strict';

function createIncomeRepository(repository) {
  if (!repository) throw new Error('income repository 需要 repository');
  function withDataTrustTransaction(callback) {
    return repository.transactionManager.run(callback);
  }
  return {
    addInbox(input) {
      return repository.incomeStore.addInbox(input);
    },
    applyIncomeScreenshot(id, parsed, options) {
      return repository.applyIncomeScreenshot(id, parsed, options);
    },
    getAutoConfidenceThreshold() {
      return Number(
        repository.automationStore.getSettings().auto_confidence_threshold,
      );
    },
    getInboxFilePath(id) {
      return repository.incomeStore.getInboxFilePath(id);
    },
    getInboxItem(id) {
      return repository.incomeStore.getInboxItem(id);
    },
    getInboxLineage(id) {
      return repository.dataTrustStore.getInboxLineage('income', id);
    },
    registerInboxEvidence(id, input) {
      return repository.dataTrustStore.registerInboxEvidence(
        'income',
        id,
        input,
      );
    },
    appendInboxEvent(id, event, input) {
      return repository.dataTrustStore.appendInboxEvent(
        'income',
        id,
        event,
        input,
      );
    },
    transitionInbox(id, input) {
      return repository.dataTrustStore.transitionInbox('income', id, input);
    },
    withDataTrustTransaction,
    getPortfolio() {
      return repository.tradeStore.getPortfolio();
    },
    ignoreInbox(id, note) {
      return withDataTrustTransaction(() => {
        const inbox = repository.incomeStore.ignoreInbox(id, note);
        if (!inbox) return null;
        let lineage = repository.dataTrustStore.getInboxLineage(
          'income',
          id,
        );
        if (
          lineage?.inbox &&
          (!lineage.inbox.evidence_id || !lineage.inbox.selected_event_id)
        ) {
          repository.dataTrustStore.registerInboxEvidence('income', id, {
            workflowState:
              lineage.inbox.workflow_state || 'needs_correction',
            actorType: 'migration',
            actorRef: 'compatibility-backfill',
            requestId: `income-ignore:${id}`,
          });
          lineage = repository.dataTrustStore.getInboxLineage('income', id);
        }
        if (
          lineage?.inbox?.workflow_state &&
          lineage.inbox.workflow_state !== 'ignored'
        ) {
          repository.dataTrustStore.transitionInbox('income', id, {
            toState: 'ignored',
            actorType: 'human',
            actorRef: 'income-ignore',
            reason: note || '忽略收益截图',
            requestId: `income-ignore:${id}`,
            dedupeKey: `ignored:${id}`,
          });
        }
        return repository.incomeStore.getInboxItem(id);
      });
    },
    listInbox() {
      return repository.listIncomeScreenshots();
    },
    pruneScreenshots(options) {
      return repository.incomeStore.pruneScreenshots(options);
    },
    saveInboxImage(input) {
      return repository.incomeStore.saveInboxImage(input);
    },
    updateInbox(id, input) {
      return repository.incomeStore.updateInbox(id, input);
    },
    inboxDir: repository.incomeInboxDir,
  };
}

module.exports = {
  createIncomeRepository,
};
