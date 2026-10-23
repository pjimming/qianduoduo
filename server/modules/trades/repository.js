'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createTradesRepository(repository) {
  if (!repository) throw new Error('trades repository 需要 repository');
  function withDataTrustTransaction(callback) {
    return repository.transactionManager.run(callback);
  }
  function appendInboxEvent(id, event, requestId) {
    return repository.dataTrustStore.appendInboxEvent(
      'trade',
      id,
      event,
      { requestId },
    );
  }
  function selectInboxEvent(id, event) {
    return repository.dataTrustStore.selectInboxEvent('trade', id, event);
  }
  return {
    inboxDir: repository.tradeInboxDir,
    addInbox(input) {
      return repository.tradeStore.addInbox(input);
    },
    appendInboxEvent,
    applyInbox(id, fields, options = {}) {
      return withDataTrustTransaction(() => {
        const beforeLineage = repository.dataTrustStore.getInboxLineage(
          'trade',
          id,
        );
        if (
          beforeLineage?.inbox &&
          (!beforeLineage.inbox.evidence_id ||
            !beforeLineage.inbox.selected_event_id)
        ) {
          repository.dataTrustStore.registerInboxEvidence('trade', id, {
            workflowState:
              beforeLineage.inbox.workflow_state || 'needs_correction',
            actorType: 'migration',
            actorRef: 'compatibility-backfill',
            requestId: options.requestId || '',
            events: [
              {
                event_type: 'legacy_snapshot',
                actor_type: 'migration',
                actor_ref: 'compatibility-backfill',
                payload: {
                  ocr_text: beforeLineage.inbox.ocr_text || '',
                  parsed_json_raw: JSON.stringify(
                    beforeLineage.inbox.parsed || {},
                  ),
                  parse_confidence:
                    beforeLineage.inbox.parse_confidence,
                  legacy_status: beforeLineage.inbox.status,
                },
                dedupe_key: `legacy-lazy:${beforeLineage.inbox.sha256}`,
                created_at: beforeLineage.inbox.received_at,
              },
            ],
          });
        }
        const result = repository.tradeStore.applyInbox(id, fields);
        if (!result) return result;
        const lineage = repository.dataTrustStore.getInboxLineage(
          'trade',
          id,
        );
        const state = lineage?.inbox?.workflow_state;
        if (state && state !== 'ready_to_post' && state !== 'posted') {
          repository.dataTrustStore.transitionInbox('trade', id, {
            toState: 'ready_to_post',
            actorType: options.actorType || 'human',
            actorRef: options.actorRef || 'trade-inbox-apply',
            reason: '交易截图字段校验通过',
            requestId: options.requestId || '',
            dedupeKey: `ready:${options.requestId || id}`,
          });
        }
        repository.dataTrustStore.transitionInbox('trade', id, {
          toState: 'posted',
          actorType: options.actorType || 'human',
          actorRef: options.actorRef || 'trade-inbox-apply',
          reason: '交易截图事务入账完成',
          requestId: options.requestId || '',
          dedupeKey: `posted:${options.requestId || id}`,
        });
        repository.dataTrustStore.appendInboxEvent(
          'trade',
          id,
          {
            event_type: 'posted',
            actor_type: options.actorType || 'human',
            actor_ref: options.actorRef || 'trade-inbox-apply',
            payload: {
              trade_id: result.trade?.id ?? null,
              matched: Boolean(result.matched),
              duplicate: Boolean(result.duplicate),
            },
            dedupe_key: `posted-fact:${options.requestId || id}`,
            created_at: new Date().toISOString(),
          },
          { requestId: options.requestId || '' },
        );
        return {
          ...result,
          inbox: repository.tradeStore.getInboxItem(id),
        };
      });
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
    getInboxLineage(id) {
      return repository.dataTrustStore.getInboxLineage('trade', id);
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
      return withDataTrustTransaction(() => {
        const inbox = repository.tradeStore.ignoreInbox(id, note);
        if (!inbox) return null;
        let lineage = repository.dataTrustStore.getInboxLineage(
          'trade',
          id,
        );
        if (
          lineage?.inbox &&
          (!lineage.inbox.evidence_id || !lineage.inbox.selected_event_id)
        ) {
          repository.dataTrustStore.registerInboxEvidence('trade', id, {
            workflowState:
              lineage.inbox.workflow_state || 'needs_correction',
            actorType: 'migration',
            actorRef: 'compatibility-backfill',
            requestId: `trade-ignore:${id}`,
          });
          lineage = repository.dataTrustStore.getInboxLineage('trade', id);
        }
        if (
          lineage?.inbox?.workflow_state &&
          lineage.inbox.workflow_state !== 'ignored'
        ) {
          repository.dataTrustStore.transitionInbox('trade', id, {
            toState: 'ignored',
            actorType: 'human',
            actorRef: 'trade-ignore',
            reason: note || '忽略交易截图',
            requestId: `trade-ignore:${id}`,
            dedupeKey: `ignored:${id}`,
          });
        }
        return repository.tradeStore.getInboxItem(id);
      });
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
    registerInboxEvidence(id, input) {
      return repository.dataTrustStore.registerInboxEvidence(
        'trade',
        id,
        input,
      );
    },
    selectInboxEvent,
    transitionInbox(id, input) {
      return repository.dataTrustStore.transitionInbox('trade', id, input);
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
    withDataTrustTransaction,
  };
}

module.exports = {
  createTradesRepository,
};
