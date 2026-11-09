'use strict';

const { todayShanghai } = require('../../../lib/metrics');
const { validateDecisionPayload } = require('./validation');
const { CONTRACT, CONTRACT_HASH } = require('../r2-strategy/contract');

function decisionError(statusCode, message, payload = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (payload) error.payload = payload;
  return error;
}

function createDecisionsService({
  decisionsRepository,
  dashboardQuery,
  transactionManager,
  automationRunner = null,
  todayProvider = todayShanghai,
}) {
  function validate(body) {
    const result = validateDecisionPayload(body, {
      today: todayProvider(),
    });
    if (result.error) throw decisionError(400, result.error);
    return result.value;
  }

  function linkedStrategyChanged(before, next) {
    const stable = (value) => JSON.stringify(value ?? null);
    for (const key of [
      'date',
      'product_name',
      'action',
      'strategy_version',
      'target_annualized',
      'bucket_plan',
      'evaluation_at',
    ]) {
      if (stable(before[key]) !== stable(next[key])) return true;
    }
    for (const key of [
      'proposal_id',
      'proposal_type',
      'holding_lot_id',
      'holding_code',
      'candidate_code',
      'product_code',
      'current_product_code',
      'candidate_product_code',
      'target_product_code',
      'trade_id',
      'screenshot_id',
      'expected_legs',
    ]) {
      if (
        stable(before.review_meta?.[key]) !==
        stable(next.review_meta?.[key])
      ) {
        return true;
      }
    }
    return false;
  }

  async function evaluate(trigger) {
    if (automationRunner) {
      await automationRunner.run({
        today: todayProvider(),
        trigger,
      });
      return;
    }
    decisionsRepository.runEvaluationCycle(trigger, todayProvider());
  }

  async function createDecision(body) {
    const decision = transactionManager.run(() => {
      const state = decisionsRepository.strategyState?.();
      const current = state?.mode === 'v9' && state.contract_hash === CONTRACT_HASH;
      const value = validate(state?.mode === 'v9' ? { ...body, strategy_version: CONTRACT.execution_version,
        target_annualized: 3, bucket_plan: { ...CONTRACT.bucket_targets, max_single: CONTRACT.max_single_pct } } : body);
      // This form records a human decision. Only proposal adoption can attest
      // the complete execution snapshot; never accept a client-authored pass.
      const meta = { ...value.review_meta };
      for (const key of ['execution_snapshot', 'evaluation_contract', 'forecast', 'proposal_snapshot_hash', 'evaluation_settings']) delete meta[key];
      if (state?.mode === 'v9') Object.assign(meta, { source: 'manual-decision', strategy_mode: 'actual_fact',
        current_revalidation_required: true, manual_strategy_context: { execution_version: CONTRACT.execution_version,
          contract_hash: state.contract_hash, activation_seq: state.activation_seq, status: current ? 'unverified' : 'contract_mismatch',
          reason: '手工决策事实记录；尚未经统一策略提案与交易前复核，不代表准入或配置通过' } });
      return decisionsRepository.createDecision({ ...value, review_meta: meta });
    });
    await evaluate('decision-create');
    return {
      decision,
      dashboard: dashboardQuery.projectDashboard(),
    };
  }

  async function updateDecision(id, body) {
    const before = decisionsRepository.findDecision(id);
    if (!before) throw decisionError(404, '没有找到这条决策记录');
    // Evidence, predictions, reservation state and execution legs are owned by
    // their business use cases. A note edit must neither replace that history
    // nor send a large frozen snapshot through the manual-input size limit.
    const linked = decisionsRepository.findLinkedTrade(id);
    const frozen = linked || before.strategy_version === CONTRACT.execution_version ||
      before.review_meta?.execution_snapshot || decisionsRepository.hasReservation?.(id);
    const rejectFrozenEdit = () => {
      throw decisionError(
        409,
        `决策 #${id} ${linked ? `已关联交易 #${linked.id}` : '已冻结执行依据'}，策略、动作、产品或交易腿不可改写；请新建决策`,
      );
    };
    if (frozen && body?.strategy_version !== undefined && body.strategy_version !== before.strategy_version) rejectFrozenEdit();
    const value = validate({ ...body, review_meta: {} });
    value.review_meta = before.review_meta ?? {};
    if (frozen && linkedStrategyChanged(before, value)) rejectFrozenEdit();
    const decision = decisionsRepository.updateDecision(id, value);
    if (!decision) throw decisionError(404, '没有找到这条决策记录');
    await evaluate('decision-update');
    return {
      decision,
      dashboard: dashboardQuery.projectDashboard(),
    };
  }

  async function deleteDecision(id) {
    if (decisionsRepository.hasReservation?.(id)) {
      throw decisionError(409, `决策 #${id} 保留资金预留审计，请在提案中取消未执行金额并保留决策历史`);
    }
    const linked = decisionsRepository.findLinkedTrade(id);
    if (linked) {
      throw decisionError(
        409,
        `决策 #${id} 已关联交易 #${linked.id}，请先改绑或撤销交易`,
        {
          error: `决策 #${id} 已关联交易 #${linked.id}，请先改绑或撤销交易`,
        },
      );
    }
    transactionManager.run(() => {
      const deleted = decisionsRepository.deleteDecision(id);
      if (!deleted) {
        throw decisionError(404, '没有找到这条决策记录');
      }
      decisionsRepository.detachProposal(
        id,
        `决策 #${id} 已删除，提案取消`,
      );
      decisionsRepository.discardEvaluations(id, `决策 #${id} 已删除`);
    });
    return {
      deleted: true,
      dashboard: dashboardQuery.projectDashboard(),
    };
  }

  function addPrediction(id, body) {
    if (!decisionsRepository.findDecision(id)) {
      throw decisionError(404, '没有找到这条决策');
    }
    const input = {
      recommendation_type: body.recommendation_type,
      action: body.action,
      source: body.source || 'human-correction',
      source_ref: body.source_ref,
      data_cutoff_at: body.data_cutoff_at,
      start_date: body.start_date,
      review_date: body.review_date,
      confidence: body.confidence,
      evidence_refs: body.evidence_refs,
      baseline: body.baseline,
      expected: body.expected,
      metric: body.metric,
      evaluation: body.evaluation,
      invalidation_condition: body.invalidation_condition,
      invalidation_triggers: body.invalidation_triggers,
      original_text: body.original_text,
      reason: body.reason,
    };
    const decision = decisionsRepository.addPredictionVersion(id, input);
    if (!decision) {
      throw decisionError(
        400,
        '预测字段不完整：至少需要复核日期和可检验目标',
      );
    }
    return {
      decision,
      prediction: decision.review_meta.predictions.at(-1),
      dashboard: dashboardQuery.projectDashboard(),
    };
  }

  return {
    addPrediction,
    createDecision,
    deleteDecision,
    updateDecision,
  };
}

module.exports = {
  createDecisionsService,
  decisionError,
};
