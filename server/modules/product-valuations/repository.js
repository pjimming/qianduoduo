'use strict';

function createProductValuationsRepository(repository) {
  if (!repository) {
    throw new Error('product valuations repository 需要 repository');
  }
  return {
    createHoldingValuation(input, context) {
      return repository.holdingValuationStore.createSnapshot(
        input,
        context,
      );
    },
    flagProductIncomeConflict(input) {
      return repository.flagProductIncomeConflict(input);
    },
    getDetail(productCode, today) {
      return repository.productValuationStore.getProductDetail(
        productCode,
        today,
      );
    },
    getValuation(id) {
      return repository.productValuationStore.getValuation(id);
    },
    getWorkspace(today, holdings) {
      return repository.productValuationStore.getWorkspace(today, holdings);
    },
    getCurrentHoldingsValuation(today, holdings) {
      return repository.holdingValuationStore.getCurrent(today, holdings);
    },
    getHoldingValuationEvidenceFile(id) {
      return repository.holdingValuationStore.getEvidenceFile(id);
    },
    listHoldingValuations(limit) {
      return repository.holdingValuationStore.listSnapshots(limit);
    },
    listValuations() {
      return repository.productValuationStore.listValuations();
    },
    listYieldSettings() {
      return repository.productValuationStore.listYieldSettings();
    },
    saveHoldingValuationEvidence(decoded) {
      return repository.holdingValuationStore.saveEvidenceImage(decoded);
    },
    saveYieldSetting(productCode, body) {
      return repository.productValuationStore.saveYieldSetting(
        productCode,
        body,
      );
    },
    updateValuationById(id, input, options) {
      return repository.productValuationStore.updateValuationById(
        id,
        input,
        options,
      );
    },
    upsertValuation(input, options) {
      return repository.productValuationStore.upsertValuation(
        input,
        options,
      );
    },
    getPortfolio() {
      return repository.tradeStore.getPortfolio();
    },
  };
}

module.exports = {
  createProductValuationsRepository,
};
