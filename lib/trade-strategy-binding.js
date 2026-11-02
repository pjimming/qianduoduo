'use strict';

const { todayShanghai } = require('./metrics');

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function strategyBindingError(message) {
  const error = new Error(message);
  error.code = 'STRATEGY_BINDING_INVALID';
  return error;
}

function tradeActionAllowed(tradeType, decisionAction) {
  if (decisionAction === '观察') return false;
  if (tradeType === 'buy') {
    return decisionAction === '买入' || decisionAction === '切换';
  }
  if (tradeType === 'redeem') {
    return decisionAction === '赎回' || decisionAction === '切换';
  }
  return tradeType === 'switch' && decisionAction === '切换';
}

function assertStructuredBinding(trade, decision, decisionProposalStore) {
  const reviewMeta = decision.review_meta || {};
  const proposalId = Number(reviewMeta.proposal_id || 0);
  const proposal =
    proposalId > 0 ? decisionProposalStore.getProposal(proposalId) : null;
  if (
    proposal &&
    !['accepted', 'executed', 'confirmed'].includes(proposal.status)
  ) {
    throw strategyBindingError(
      `交易 #${trade.id} 关联的提案 #${proposal.id} 当前为 ${proposal.status}，不可继续绑定`,
    );
  }
  const expectedLegs = Array.isArray(reviewMeta.expected_legs)
    ? reviewMeta.expected_legs
    : [];
  const fallbackLegs = Array.isArray(proposal?.payload?.expected_legs)
    ? proposal.payload.expected_legs
    : [];
  if (expectedLegs.length || fallbackLegs.length) {
    if (
      !decisionProposalStore.matchDecisionLeg(
        trade,
        decision,
        fallbackLegs,
      )
    ) {
      throw strategyBindingError(
        `交易 #${trade.id} 与决策 #${decision.id} 的策略腿不一致`,
      );
    }
    return;
  }
  const productCode = normalizeCode(reviewMeta.product_code);
  if (
    productCode &&
    trade.trade_type !== 'switch' &&
    normalizeCode(trade.product_code) !== productCode
  ) {
    throw strategyBindingError(
      `交易 #${trade.id} 的产品代码与决策 #${decision.id} 不一致`,
    );
  }
  if (trade.trade_type === 'switch') {
    const currentCode = normalizeCode(
      reviewMeta.current_product_code ||
        reviewMeta.holding_code ||
        reviewMeta.product_code,
    );
    const candidateCode = normalizeCode(
      reviewMeta.candidate_product_code ||
        reviewMeta.target_product_code ||
        reviewMeta.candidate_code,
    );
    if (
      (currentCode && currentCode !== normalizeCode(trade.product_code)) ||
      (candidateCode &&
        candidateCode !== normalizeCode(trade.target_product_code))
    ) {
      throw strategyBindingError(
        `交易 #${trade.id} 的切换产品与决策 #${decision.id} 不一致`,
      );
    }
  }
}

function assertTradeStrategyBinding({
  trade,
  decisions,
  decisionProposalStore,
}) {
  if (!trade?.decision_id) {
    throw strategyBindingError(`交易 #${trade?.id ?? ''} 未绑定决策策略`);
  }
  const decision = decisions.find(
    (item) => Number(item.id) === Number(trade.decision_id),
  );
  if (!decision) {
    throw strategyBindingError(
      `交易 #${trade.id} 关联的决策 #${trade.decision_id} 不存在`,
    );
  }
  if (!String(decision.strategy_version || '').trim()) {
    throw strategyBindingError(
      `交易 #${trade.id} 关联的决策 #${decision.id} 缺少策略版本`,
    );
  }
  if (!tradeActionAllowed(trade.trade_type, decision.action)) {
    throw strategyBindingError(
      `交易 #${trade.id} 的${trade.trade_type}动作与决策 #${decision.id} 的“${decision.action}”动作不匹配`,
    );
  }
  assertStructuredBinding(trade, decision, decisionProposalStore);
  return decision;
}

function findUniqueManualDecision(trade, decisions, decisionProposalStore) {
  const candidates = decisions.filter((decision) => {
    if (!String(decision.strategy_version || '').trim()) return false;
    if (!tradeActionAllowed(trade.trade_type, decision.action)) return false;
    if (decision.date !== trade.trade_date) return false;
    const proposalId = Number(decision.review_meta?.proposal_id || 0);
    if (proposalId > 0) return false;
    const expectedLegs = Array.isArray(decision.review_meta?.expected_legs)
      ? decision.review_meta.expected_legs
      : [];
    if (expectedLegs.length) {
      return Boolean(
        decisionProposalStore.matchDecisionLeg(trade, decision),
      );
    }
    const structuredCodes = [
      decision.review_meta?.product_code,
      decision.review_meta?.current_product_code,
      decision.review_meta?.holding_code,
      decision.review_meta?.candidate_product_code,
      decision.review_meta?.target_product_code,
      decision.review_meta?.candidate_code,
    ].filter(Boolean);
    if (structuredCodes.length) {
      try {
        assertStructuredBinding(trade, decision, decisionProposalStore);
        return true;
      } catch {
        return false;
      }
    }
    return (
      decision.product_name.trim() === trade.product_name.trim() &&
      trade.trade_type !== 'switch'
    );
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function ensureTradeStrategyBinding({
  trade,
  today = todayShanghai(),
  listDecisions,
  tradeStore,
  decisionProposalStore,
  automationStore,
}) {
  if (!trade) return null;
  let bound = trade;
  if (!bound.decision_id) {
    const matched = decisionProposalStore.matchTrade(bound, today);
    if (matched?.trade) bound = matched.trade;
  }
  if (!bound.decision_id) {
    const manualDecision = findUniqueManualDecision(
      bound,
      listDecisions(),
      decisionProposalStore,
    );
    if (manualDecision) {
      bound = tradeStore.updateTrade(
        bound.id,
        { ...bound, decision_id: manualDecision.id },
        `匹配同日唯一决策 #${manualDecision.id}`,
      );
    }
  }
  automationStore.ensureTradeDecisions();
  bound = tradeStore.getTrade(bound.id);
  assertTradeStrategyBinding({
    trade: bound,
    decisions: listDecisions(),
    decisionProposalStore,
  });
  return bound;
}

module.exports = {
  assertTradeStrategyBinding,
  ensureTradeStrategyBinding,
  strategyBindingError,
};
