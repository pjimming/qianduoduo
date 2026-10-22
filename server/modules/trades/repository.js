'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createTradesRepository(repository) {
  if (!repository) throw new Error('trades repository 需要 repository');
  return {
    inboxDir: repository.tradeInboxDir,
    addInbox(input) {
      return repository.tradeStore.addInbox(input);
    },
    applyInbox(id, fields) {
      return repository.tradeStore.applyInbox(id, fields);
    },
    cancelTrade(id, note) {
      return repository.tradeStore.cancelTrade(id, note);
    },
    confirmTrade(id, date, note) {
      return repository.tradeStore.confirmTrade(id, date, note);
    },
    createHolding(holding) {
      return repository.createHolding(holding);
    },
    createTrade(input, note) {
      return repository.tradeStore.createTrade(input, note);
    },
    deleteHolding(id) {
      return repository.deleteHolding(id);
    },
    ensureTradeDecisions() {
      return repository.automationStore.ensureTradeDecisions();
    },
    findMatchingTrade(fields) {
      return repository.tradeStore.findMatchingTrade(fields);
    },
    getAudits(id) {
      return repository.tradeStore.getAudits(id);
    },
    getInboxFilePath(id) {
      return repository.tradeStore.getInboxFilePath(id);
    },
    getInboxItem(id) {
      return repository.tradeStore.getInboxItem(id);
    },
    getInboxByHash(sha256) {
      return repository.tradeStore.getInboxByHash(sha256);
    },
    getOverview(today) {
      return repository.tradeStore.getOverview(today);
    },
    getPortfolio() {
      return repository.tradeStore.getPortfolio();
    },
    getTrade(id) {
      return repository.tradeStore.getTrade(id);
    },
    hasDecision(id) {
      return repository.listDecisions().some((item) => item.id === id);
    },
    ignoreInbox(id, note) {
      return repository.tradeStore.ignoreInbox(id, note);
    },
    listDecisions() {
      return repository.listDecisions();
    },
    listInbox() {
      return repository.tradeStore.listInbox();
    },
    listProducts() {
      return repository.listProducts();
    },
    listTrades() {
      return repository.tradeStore.listTrades();
    },
    matchProposal(trade, today) {
      return repository.decisionProposalStore.matchTrade(trade, today);
    },
    pruneScreenshots(options) {
      return repository.tradeStore.pruneScreenshots(options);
    },
    reconcileExecutionStatuses(today) {
      return repository.decisionProposalStore.reconcileExecutionStatuses(today);
    },
    runAutomationCycle(options) {
      return repository.automationStore.runCycle(options);
    },
    saveInboxImage(input) {
      return repository.tradeStore.saveInboxImage(input);
    },
    removeStoredInboxImage(storedName) {
      if (!storedName) return;
      const target = path.resolve(repository.tradeInboxDir, storedName);
      const prefix = `${path.resolve(repository.tradeInboxDir)}${path.sep}`;
      if (target.startsWith(prefix) && fs.existsSync(target)) {
        fs.unlinkSync(target);
      }
    },
    updateHolding(id, holding) {
      return repository.updateHolding(id, holding);
    },
    updateInbox(id, input) {
      return repository.tradeStore.updateInbox(id, input);
    },
    updateTrade(id, input, note) {
      return repository.tradeStore.updateTrade(id, input, note);
    },
  };
}

module.exports = {
  createTradesRepository,
};
