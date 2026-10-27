'use strict';

function createLedgerRepository(repository) {
  if (!repository) throw new Error('ledger repository 需要 repository');
  return {
    createRecord(record) {
      return repository.createRecord(record);
    },
    deleteRecord(date) {
      return repository.deleteRecord(date);
    },
    flagIncomeConflict(input) {
      return repository.flagIncomeRecordConflict(input);
    },
    getCapitalState(today) {
      return repository.getCapitalState(today);
    },
    getProductIncomeSummary(date) {
      return repository.getProductIncomeSummary(date);
    },
    getRecord(date) {
      return repository.getRecord(date);
    },
    listRecords() {
      return repository.listRecords();
    },
    updateRecord(date, record) {
      return repository.updateRecord(date, record);
    },
  };
}

module.exports = {
  createLedgerRepository,
};
