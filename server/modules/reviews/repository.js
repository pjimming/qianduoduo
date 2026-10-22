'use strict';

function createReviewsRepository(repository) {
  if (!repository) throw new Error('reviews repository 需要 repository');
  return {
    confirmDraft(periodType, period, input) {
      return repository.automationStore.confirmDraft(
        periodType,
        period,
        input,
      );
    },
    createProductEvent(event) {
      return repository.createProductEvent(event);
    },
    deleteProductEvent(id) {
      return repository.deleteProductEvent(id);
    },
    generateDraft(periodType, period) {
      return repository.automationStore.generateDraft(periodType, period);
    },
    getDraft(periodType, period) {
      return repository.automationStore.getDraft(periodType, period);
    },
    getReviewNote(month) {
      return repository.getReviewNote(month);
    },
    getWorkspace(today) {
      return repository.automationStore.getWorkspace(today);
    },
    saveQuarterlyNote(quarter, note) {
      return repository.saveQuarterlyNote(quarter, note);
    },
    saveReviewNote(month, note) {
      return repository.saveReviewNote(month, note);
    },
    updateProductEvent(id, event) {
      return repository.updateProductEvent(id, event);
    },
  };
}

module.exports = {
  createReviewsRepository,
};
