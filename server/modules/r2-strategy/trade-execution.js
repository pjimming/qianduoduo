'use strict';

const { CONTRACT } = require('./contract');
const { moneyCents, legKey } = require('./account');
const { mapTrade } = require('../../../lib/trade-store');

function createTradeExecutionReconciler({ repository, strategyRepository }) {
  return function reconcile({ trade, decision }) {
    if (decision?.strategy_version !== CONTRACT.execution_version) return;
    if (!repository.transactionManager.isActive()) throw new Error('执行策略与交易必须在同一业务事务内接续');
    const all = repository.db.prepare('SELECT * FROM trade_transactions WHERE decision_id=? ORDER BY id').all(decision.id).map(mapTrade);
    const active = all.filter(row => row.status !== 'cancelled');
    const legs = decision.review_meta?.expected_legs ?? [];
    const progress = legs.map(leg => {
      const matches = active.filter(row => {
        const direction = leg.side === 'buy' ? ['buy', 'switch'].includes(row.trade_type) : ['redeem', 'switch'].includes(row.trade_type);
        const code = leg.side === 'buy' && row.trade_type === 'switch' ? row.target_product_code : row.product_code;
        return direction && code === leg.product_code;
      });
      const total = matches.reduce((sum, row) => sum + moneyCents(row.amount), 0);
      const confirmed = matches.filter(row => row.status === 'confirmed').reduce((sum, row) => sum + moneyCents(row.amount), 0);
      return { side: leg.side, product_code: leg.product_code, expected_cents: moneyCents(leg.amount),
        submitted_cents: total, confirmed_cents: confirmed, trade_ids: matches.map(row => row.id) };
    });
    const reservations = strategyRepository.reservations().filter(row => row.decision_id === decision.id);
    const excess = [];
    for (const row of reservations) {
      const leg = progress.find(leg => leg.side === 'buy' && legKey(leg.product_code) === row.leg_key);
      if (!leg) throw new Error('正式交易无法匹配原资金预留腿');
      const result = strategyRepository.reconcileReservationFromFacts({ id: row.id, executedCents: leg.confirmed_cents,
        keepUnusedReserved: decision.review_meta?.lifecycle_status !== 'cancelled' && !decision.review_meta?.remaining_cancelled_at });
      if (result.excess_cents) excess.push({ product_code: leg.product_code, excess_cents: result.excess_cents });
    }
    const allSubmitted = progress.length > 0 && progress.every(leg => leg.submitted_cents >= leg.expected_cents);
    const allConfirmed = progress.length > 0 && progress.every(leg => leg.confirmed_cents >= leg.expected_cents);
    const deviation = excess.length > 0 || progress.some(leg => leg.submitted_cents > leg.expected_cents);
    const missingScreenshot = active.some(row => !row.screenshot_id);
    const executionStatus = deviation ? 'deviation' : allConfirmed ? 'confirmed'
      : decision.review_meta?.remaining_cancelled_at ? 'partial_cancelled' : allSubmitted ? 'executed'
      : active.length ? 'partial' : 'pending';
    const stamp = new Date().toISOString();
    const reviewMeta = { ...decision.review_meta, execution_status: executionStatus,
      audit_status: deviation || missingScreenshot ? 'pending' : allConfirmed ? 'confirmed' : 'pending',
      matched_trade_ids: active.map(row => row.id), execution_progress: progress,
      execution_deviation: { excess, missing_screenshot: missingScreenshot },
      // This is actual execution progress, not a recommendation approval.
      current_revalidation_required: executionStatus === 'pending' || executionStatus === 'partial' || deviation };
    const progressChanged = JSON.stringify(reviewMeta) !== JSON.stringify(decision.review_meta);
    if (progressChanged) {
      repository.updateDecision(decision.id, { ...decision, review_meta: reviewMeta });
    }
    const proposalId = decision.review_meta?.proposal_id;
    if (proposalId && progressChanged) {
      const status = allConfirmed ? 'confirmed' : allSubmitted ? 'executed' : 'accepted';
      repository.db.prepare(`UPDATE decision_proposals SET status=?,executed_at=CASE WHEN ? IN ('executed','confirmed')
        THEN coalesce(executed_at,?) ELSE executed_at END,updated_at=? WHERE id=? AND decision_id=?
        AND status IN ('accepted','executed','confirmed') AND json_extract(payload_json,'$.execution_version')=?`)
        .run(status, status, stamp, stamp, proposalId, decision.id, CONTRACT.execution_version);
    }
    return { progress, excess, execution_status: executionStatus };
  };
}

module.exports = { createTradeExecutionReconciler };
