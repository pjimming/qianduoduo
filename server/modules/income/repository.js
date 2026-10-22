'use strict';

function createIncomeRepository(repository) {
  if (!repository) throw new Error('income repository 需要 repository');
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
    getPortfolio() {
      return repository.tradeStore.getPortfolio();
    },
    ignoreInbox(id, note) {
      return repository.incomeStore.ignoreInbox(id, note);
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
