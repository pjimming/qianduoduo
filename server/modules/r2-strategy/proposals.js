'use strict';

const { CONTRACT, CONTRACT_HASH, fingerprint } = require('./contract');
const { identityKey } = require('./evidence');
const { evaluateStrategy } = require('./engine');
const { buildExecutionSnapshot, verifyExecutionSnapshot } = require('./snapshot');
const { buildHoldingActionPlans } = require('./holding-actions');
const { strategyError } = require('./repository');
const { createStrategyProposalRepository } = require('./proposal-repository');
const { buildPrediction } = require('../../../lib/decision-calibration');
const { legKey, moneyCents } = require('./account');
const { validateReplacementPortfolio } = require('./replacement-constraints');

const HOLDING_KINDS = ['holding_exit', 'holding_switch'];

function isHoldingPayload(payload) {
  return HOLDING_KINDS.includes(payload?.kind);
}
// Pure, conservative replacement screen. It never reads another account or
// assumes reinvestment; it only lets a same-bucket, no-longer-term candidate
// with no worse drawdown band proceed to the economic comparison.
function validateHoldingReplacement({ current, candidate, comparison_days: horizon, ...input }) {
  const band = value => ({ reject: 2, watch: 1 })[value] ?? 0;
  const riskNotWorse = band(candidate.metrics?.drawdown?.band) <= band(current.metrics?.drawdown?.band);
  const liquidityNotWorse = Number(candidate.term?.days) <= Number(current.term?.days);
  const reasons = [];
  if (!riskNotWorse) reasons.push('replacement_risk_worse');
  if (!liquidityNotWorse) reasons.push('replacement_liquidity_worse');
  const reinvestment = Number(candidate.term?.days) < Number(horizon);
  if (reinvestment) reasons.push('reinvestment_assumption_unaccepted');
  const portfolio = validateReplacementPortfolio({ ...input, candidate });
  reasons.push(...portfolio.reasons);
  return { ok: riskNotWorse && liquidityNotWorse && !reinvestment && portfolio.ok, reasons, risk_not_worse: riskNotWorse,
    liquidity_not_worse: liquidityNotWorse, reinvestment_assumption_accepted: !reinvestment };
}
function holdingPlans(input, result) {
  return buildHoldingActionPlans({ holdings: input.portfolio.holdings, context: result.evidence,
    monitoringContext: result.monitoringEvidence ?? result.evidence, date: input.date,
    validateReplacement: values => validateHoldingReplacement({ ...values, account: result.account, settings: input.settings }) });
}

function materialPortfolio(input) {
  // Old evaluations/prediction results can change without moving any money.
  // Freeze the financial facts, review versions and source identity separately.
  return { state: input.state, date: input.date, settings: input.settings,
    principal: input.portfolio.principal, holdings: input.portfolio.holdings, trades: input.portfolio.trades,
    reservations: input.portfolio.reservations };
}
function createStrategyProposalService({ repository, strategy, strategyRepository, evaluate = evaluateStrategy }) {
  const proposals = createStrategyProposalRepository(repository);
  function generateHolding({ kind, lotId, amountCents, targetProductCode, expectedInputFingerprint } = {}) {
    const frozen = strategy.frozenInput();
    const state = frozen.input.state;
    if (!state || state.mode !== 'v9' || state.contract_hash !== CONTRACT_HASH) throw strategyError('recommendation_disabled', '当前模式不生成正式提案');
    if (expectedInputFingerprint && expectedInputFingerprint !== frozen.fingerprint) throw strategyError('input_changed', '证据或账户已变化，请重算');
    const result = evaluate(frozen.input);
    const plan = holdingPlans(frozen.input, result).plans.find(row => row.lot_id === lotId) ?? null;
    if (!plan) throw strategyError('holding_missing', '未找到该持仓批次', 404);
    if (amountCents !== undefined && amountCents !== plan.amount_cents) throw strategyError('holding_amount_changed', '持仓金额已变化，请重新加载', 409);
    const reject = blockers => ({ created: [], blockers: [...new Set(blockers)], input_fingerprint: frozen.fingerprint, lot_id: plan.lot_id });
    if (!plan.executable) return reject(plan.blockers.length ? plan.blockers : ['holding_plan_not_executable']);
    if (kind === 'holding_exit' && plan.action !== '赎回') return reject(['holding_exit_not_current_plan']);
    if (kind === 'holding_switch' && plan.action !== '切换') return reject(['holding_switch_not_current_plan']);
    if (targetProductCode && plan.target_product_code !== targetProductCode) return reject(['target_not_selected_by_plan']);
    const target = plan.frozen_evidence?.candidate ?? null;
    const targetName = target?.name ?? plan.target_product_code ?? '';
    const label = kind === 'holding_exit' ? '退出' : '切换';
    const summary = kind === 'holding_exit'
      ? `${plan.reason} 采纳后仍需由用户在银行执行赎回，实际到账与费用以成交为准。`
      : `${plan.reason} 采纳后仍需由用户在银行执行赎回与买入，实际成交与到账以银行事实为准。`;
    const legs = [{ side: 'redeem', product_code: plan.product_code, product_name: plan.product_name,
      amount: plan.amount_cents / 100 }];
    if (kind === 'holding_switch') legs.push({ side: 'buy', product_code: plan.target_product_code, product_name: targetName,
      amount: plan.amount_cents / 100, term_days: Number.isSafeInteger(target?.term?.days) ? target.term.days : null });
    const dedupe = fingerprint({ execution_version: CONTRACT.execution_version, contract_hash: CONTRACT_HASH, kind,
      lot_id: plan.lot_id, amount_cents: plan.amount_cents, target_identity: plan.target_identity ?? null,
      plan_key: plan.dedupe_key });
    const proposal = { dedupe_key: `v9:${dedupe}`, group_key: `v9:holding:${plan.lot_id}`, proposal_type: 'holding_switch',
      action: plan.action, title: `持仓${label}待采纳：${plan.product_name}${kind === 'holding_switch' ? ` → ${targetName}` : ''}`,
      summary, product_name: plan.product_name, product_code: plan.product_code,
      target_product_code: plan.target_product_code ?? '', target_product_name: targetName,
      amount: plan.amount_cents / 100, evidence_date: plan.evidence_date ?? frozen.input.date,
      expires_at: frozen.input.date, verify_date: plan.verify_date ?? frozen.input.date, confidence: 70,
      payload: { payload_version: 1, execution_version: CONTRACT.execution_version, contract_hash: CONTRACT_HASH,
        holding_review_version: CONTRACT.holding_review_version, kind, lot_id: plan.lot_id,
        activation_seq: state.activation_seq, plan_hash: plan.content_hash, frozen_input_hash: frozen.fingerprint,
        material_portfolio_hash: fingerprint(materialPortfolio(frozen.input)),
        plan: JSON.parse(JSON.stringify(plan)), expected_legs: legs,
        decision: { reason: plan.reason,
          expectation: kind === 'holding_exit'
            ? '按已核验的赎回路径退出该持仓批次；实际到账、费用和确认日按银行成交事实核验，不把计划视为已执行。'
            : '按已核验的赎回与买入路径完成同本金替换；以实际两笔成交、到账和费用核验，不保证未来收益。',
          invalidation_condition: plan.invalidation_condition },
        review_meta: { source: 'v9-holding-proposal', strategy_mode: 'recommendation', holding_kind: kind,
          plan_hash: plan.content_hash, lot_id: plan.lot_id } } };
    const current = strategy.frozenInput();
    if (current.fingerprint !== frozen.fingerprint) throw strategyError('input_changed', '生成期间输入已变化，请重算');
    return repository.transactionManager.run(() => {
      const active = strategyRepository.state();
      if (active?.activation_seq !== state.activation_seq || active.mode !== 'v9') throw strategyError('activation_changed', '生成期间策略已切换');
      const locked = strategy.readLedgerInput(frozen.input.date);
      if (fingerprint(materialPortfolio(locked)) !== fingerprint(materialPortfolio(frozen.input))) {
        throw strategyError('input_changed', '提交前账户或复核事实已变化，请重算');
      }
      const created = proposals.create(proposal);
      return { created: [created], input_fingerprint: frozen.fingerprint, plan_hash: plan.content_hash, lot_id: plan.lot_id };
    });
  }
  function generate(options = {}) {
    if (isHoldingPayload(options)) return generateHolding(options);
    const { expectedInputFingerprint } = options;
    const frozen = strategy.frozenInput();
    const state = frozen.input.state;
    if (!state || state.mode !== 'v9' || state.contract_hash !== CONTRACT_HASH) throw strategyError('recommendation_disabled', '当前模式不生成正式提案');
    if (expectedInputFingerprint && expectedInputFingerprint !== frozen.fingerprint) throw strategyError('input_changed', '证据或账户已变化，请重算');
    const result = evaluate(frozen.input);
    if (!result.may_generate_buy_proposals) return { created: [], blockers: ['allocation_forecast_incomplete'],
      input_fingerprint: frozen.fingerprint };
    const planHash = fingerprint({ input: result.input_fingerprint, allocation: result.allocation.fingerprint });
    const prepared = result.allocation.rows.filter(row => row.amount_cents > 0).map(allocation => {
      const row = result.evidence.rows.find(item => identityKey(item.identity) === identityKey(allocation.identity));
      const snapshot = buildExecutionSnapshot({ result, row, amountCents: allocation.amount_cents });
      const dedupe = fingerprint({ execution_version: CONTRACT.execution_version, contract_hash: CONTRACT_HASH, plan_hash: planHash,
        identity: row.identity, amount_cents: allocation.amount_cents, evidence_hash: row.evidence_hash });
      const forecast = snapshot.forecast;
      const summary = `按v9组内第${row.rank}名配置；参考年化${forecast.reference_yield_pct}%为情景输入，预计资金空档${forecast.idle_days}天，` +
        `扣费情景净收益${(forecast.expected_net_pnl_cents / 100).toFixed(2)}元。采纳后仍待用户在银行执行。`;
      const prediction = buildPrediction({ recommendation_type: 'cash_allocation', action: '买入', source: 'v9-strategy-proposal',
        source_ref: `v9:${dedupe}`, created_at: new Date().toISOString(), data_cutoff_at: frozen.input.date,
        start_date: forecast.start_date, review_date: forecast.end_date, confidence: 75,
        metric: 'net_pnl_cents', unit: '分', baseline: { metric: 'net_pnl_cents', value: 0, unit: '分', label: '未投资本金基线' },
        expected: { direction: 'at_least', target: { point: forecast.expected_net_pnl_cents, unit: '分' } },
        evaluation: { metric: 'net_pnl_cents', method: 'v9_frozen_net_pnl', minimum_observations: 7,
          minimum_coverage_ratio: 0.5, tolerance_abs: snapshot.evaluation_contract.result_tolerance_cents },
        evidence_refs: [{ type: 'execution_snapshot', hash: snapshot.snapshot_hash, run_id: row.run_id }],
        invalidation_condition: '事实未确认、未到验证日或证据不足时保持待验证；取消/未执行不计命中。', original_text: summary });
      if (!prediction) throw strategyError('prediction_unavailable', '冻结收益预测不可构建');
      return { dedupe_key: `v9:${dedupe}`, group_key: `v9:allocation:${identityKey(row.identity)}`,
        proposal_type: 'cash_allocation', action: '买入', title: `配置待采纳：${row.name}`, summary,
        product_name: row.name, product_code: row.mapping.product_code, amount: allocation.amount_cents / 100,
        evidence_date: row.performance_date, expires_at: frozen.input.date, verify_date: forecast.end_date, confidence: 75,
        payload: { execution_version: CONTRACT.execution_version, selection_policy_version: CONTRACT.selection_policy_version,
          allocation_policy_version: CONTRACT.allocation_policy_version, yield_policy_version: CONTRACT.yield_policy_version,
          evaluation_policy_version: CONTRACT.evaluation_policy_version, contract_hash: CONTRACT_HASH,
          plan_hash: planHash, frozen_input_hash: frozen.fingerprint, material_portfolio_hash: fingerprint(materialPortfolio(frozen.input)),
          snapshot, forecast, prediction, yield_policy: { version: CONTRACT.yield_policy_version, snapshot_date: row.performance_date,
            product: { product_code: row.mapping.product_code, bucket: row.reference.bucket,
              reference_yield_pct: row.reference.value_pct, status: row.reference.status, reason: row.reference.reason,
              available_horizons: row.reference.available_horizons, normalized_weights: row.reference.normalized_weights,
              data_date: row.performance_date } },
          decision: { reason: summary, expectation: '按冻结情景比较正式交易及收益事实；不把近1月或3%目标当作个人收益保证。',
            invalidation_condition: '份额、近期业绩、公开或App额度、复核版本、资金或约束变化时重核；未执行不假定收益已实现。',
            bucket_plan: CONTRACT.bucket_targets },
          review_meta: { source: 'v9-strategy-proposal', strategy_mode: 'recommendation', plan_hash: planHash },
          expected_legs: [{ side: 'buy', product_code: row.mapping.product_code, product_name: row.name,
            amount: allocation.amount_cents / 100, term_days: row.term.days }] } };
    });
    // A completed calculation is never a license to write using an old cash
    // balance. Public input is revalidated outside, ledger input under the lock.
    const current = strategy.frozenInput();
    if (current.fingerprint !== frozen.fingerprint) throw strategyError('input_changed', '生成期间输入已变化，请重算');
    return repository.transactionManager.run(() => {
      const active = strategyRepository.state();
      if (active?.activation_seq !== state.activation_seq || active.mode !== 'v9') throw strategyError('activation_changed', '生成期间策略已切换');
      if (fingerprint(materialPortfolio(strategy.readLedgerInput(frozen.input.date))) !== fingerprint(materialPortfolio(frozen.input))) {
        throw strategyError('input_changed', '提交前账户或复核事实已变化，请重算');
      }
      const created = prepared.map(proposal => proposals.create(proposal));
      return { created, input_fingerprint: frozen.fingerprint, plan_hash: planHash };
    });
  }
  function admissionMaterial(input, planHash) {
    const ownDecisions = new Map(input.portfolio.decisions.filter(decision => decision.review_meta?.plan_hash === planHash &&
      decision.strategy_version === CONTRACT.execution_version && decision.review_meta?.source === 'v9-strategy-proposal')
      .map(decision => [decision.id, decision]));
    const reservations = input.portfolio.reservations.filter(reservation => {
      const decision = ownDecisions.get(reservation.decision_id);
      if (!decision || decision.review_meta.proposal_id !== reservation.proposal_id) return true;
      const owner = proposals.get(reservation.proposal_id);
      return owner?.payload?.plan_hash !== planHash || owner.decision_id !== decision.id || moneyCents(owner.amount) !== reservation.amount_cents;
    });
    return materialPortfolio({ ...input, portfolio: { ...input.portfolio, reservations } });
  }
  function adoptHolding(proposal, { expectedInputFingerprint } = {}) {
    const prior = proposal.decision_id ? repository.listDecisions().find(row => row.id === proposal.decision_id) : null;
    if (['accepted', 'executed', 'confirmed'].includes(proposal.status) && prior) return {
      proposal, decision: prior, existing: true, execution_status: 'pending_bank_execution',
      current_revalidation_required: true };
    if (proposal.status !== 'pending') throw strategyError('proposal_changed', '只有待采纳提案可以采纳');
    const payload = proposal.payload;
    if (!HOLDING_KINDS.includes(payload.kind) || payload.execution_version !== CONTRACT.execution_version ||
        payload.contract_hash !== CONTRACT_HASH) {
      throw strategyError('proposal_missing', '未找到当前执行策略提案', 404);
    }
    const frozen = strategy.frozenInput(), state = frozen.input.state;
    if (!state || state.mode !== 'v9' || state.contract_hash !== CONTRACT_HASH ||
        state.activation_seq !== payload.activation_seq) throw strategyError('activation_changed', '执行策略已变化，请重新生成');
    if (proposal.expires_at < frozen.input.date) throw strategyError('proposal_expired', '提案已过当日复核有效期，请重新生成');
    if (expectedInputFingerprint && expectedInputFingerprint !== frozen.fingerprint) throw strategyError('input_changed', '当前输入已变化，请重新加载');
    const result = evaluate(frozen.input);
    const plan = holdingPlans(frozen.input, result).plans.find(row => row.lot_id === payload.lot_id) ?? null;
    if (!plan || plan.content_hash !== payload.plan_hash || plan.action !== proposal.action ||
        plan.amount_cents !== moneyCents(proposal.amount)) {
      throw strategyError('proposal_revalidation_failed', '当前持仓、证据或金额已变化，请重新生成');
    }
    if (payload.plan?.target_product_code && plan.target_product_code !== payload.plan.target_product_code) {
      throw strategyError('proposal_revalidation_failed', '当前替换目标已变化，请重新生成');
    }
    if (!plan.executable) throw strategyError('holding_not_executable', `当前持仓计划不可执行：${plan.blockers.join(',') || 'holding_plan_not_executable'}`);
    const outside = strategy.frozenInput();
    if (outside.fingerprint !== frozen.fingerprint) throw strategyError('input_changed', '采纳准备期间输入已变化，请重算');
    return repository.transactionManager.run(() => {
      const active = strategyRepository.state();
      if (active?.activation_seq !== state.activation_seq || active.mode !== 'v9') throw strategyError('activation_changed', '采纳期间策略已切换');
      const current = proposals.get(proposal.id);
      if (current.status !== 'pending') {
        const existing = current.decision_id ? repository.listDecisions().find(row => row.id === current.decision_id) : null;
        if (existing && ['accepted', 'executed', 'confirmed'].includes(current.status)) return { proposal: current, decision: existing, existing: true };
        throw strategyError('proposal_changed', '提案已被其他请求处理');
      }
      const locked = strategy.readLedgerInput(frozen.input.date);
      if (fingerprint(materialPortfolio(locked)) !== payload.material_portfolio_hash) {
        throw strategyError('input_changed', '采纳前资金、复核或持仓已变化，请重算');
      }
      const definition = payload.decision ?? {};
      const decision = repository.createDecision({ date: frozen.input.date, product_name: proposal.product_name,
        action: plan.action, reason: definition.reason ?? plan.reason, expectation: definition.expectation ?? '',
        invalidation_condition: definition.invalidation_condition ?? plan.invalidation_condition, actual_result: '',
        strategy_version: CONTRACT.execution_version, target_annualized: 3,
        bucket_plan: { ...CONTRACT.bucket_targets, max_single: CONTRACT.max_single_pct },
        evidence_date: proposal.evidence_date, verify_date: proposal.verify_date,
        evaluation_at: ['holding', 'maturity'], rating: '待评估',
        review_meta: { ...payload.review_meta, proposal_id: proposal.id, proposal_type: proposal.proposal_type,
          holding_lot_id: payload.lot_id,
          execution_snapshot: { execution_version: CONTRACT.execution_version, contract_hash: CONTRACT_HASH,
            kind: payload.kind, lot_id: payload.lot_id, plan_hash: payload.plan_hash, plan: payload.plan },
          expected_legs: payload.expected_legs, predictions: [], prediction_results: {},
          lifecycle_status: 'accepted', execution_status: 'pending', audit_status: 'pending',
          source: 'v9-holding-proposal', operation_id: `v9-adopt:${proposal.id}` } });
      const accepted = proposals.accept(proposal.id, decision.id);
      const buyLeg = (payload.expected_legs ?? []).find(leg => leg.side === 'buy');
      if (buyLeg) {
        strategyRepository.reserve({ proposalId: proposal.id, decisionId: decision.id, legKey: legKey(buyLeg.product_code),
          amountCents: moneyCents(buyLeg.amount), expectedSeq: state.activation_seq, readAvailableCents: () => {
            if (fingerprint(materialPortfolio(strategy.readLedgerInput(frozen.input.date))) !== payload.material_portfolio_hash) {
              throw strategyError('input_changed', '预留前账户已变化');
            }
            return result.account.available_cents;
          } });
      }
      return { proposal: accepted, decision, existing: false, execution_status: 'pending_bank_execution' };
    });
  }
  function adopt(id, { expectedInputFingerprint } = {}) {
    const proposal = proposals.get(id);
    if (!proposal || proposal.payload?.execution_version !== CONTRACT.execution_version) throw strategyError('proposal_missing', '未找到当前执行策略提案', 404);
    if (isHoldingPayload(proposal.payload)) return adoptHolding(proposal, { expectedInputFingerprint });
    const prior = proposal.decision_id ? repository.listDecisions().find(row => row.id === proposal.decision_id) : null;
    if (['accepted', 'executed', 'confirmed'].includes(proposal.status) && prior) return {
      proposal, decision: prior, existing: true, execution_status: 'pending_bank_execution',
      current_revalidation_required: true };
    if (proposal.status !== 'pending') throw strategyError('proposal_changed', '只有待采纳提案可以采纳');
    if (!verifyExecutionSnapshot(proposal.payload.snapshot)) throw strategyError('snapshot_invalid', '提案快照不完整或校验失败，请重新生成');
    const frozen = strategy.frozenInput(), state = frozen.input.state;
    if (!state || state.mode !== 'v9' || state.contract_hash !== CONTRACT_HASH ||
        state.activation_seq !== proposal.payload.snapshot.input.activation_seq) throw strategyError('activation_changed', '执行策略已变化，请重新生成');
    if (proposal.expires_at < frozen.input.date) throw strategyError('proposal_expired', '提案已过当日复核有效期，请重新生成');
    if (expectedInputFingerprint && expectedInputFingerprint !== frozen.fingerprint) throw strategyError('input_changed', '当前输入已变化，请重新加载');
    const planHash = proposal.payload.plan_hash;
    const expectedMaterial = proposal.payload.material_portfolio_hash;
    if (fingerprint(admissionMaterial(frozen.input, planHash)) !== expectedMaterial) throw strategyError('input_changed', '账户、复核或非本计划承诺已变化，请重新生成');
    const result = evaluate(frozen.input);
    if (!result.may_generate_buy_proposals || result.evidence.fingerprint !== proposal.payload.snapshot.input.source_fingerprint) {
      throw strategyError('proposal_revalidation_failed', '当前候选、证据时效、配置或公开数据可行性未通过，请重算');
    }
    const row = result.evidence.rows.find(item => identityKey(item.identity) === identityKey(proposal.payload.snapshot.identity));
    const selected = result.allocation.rows.find(item => identityKey(item.identity) === identityKey(proposal.payload.snapshot.identity));
    if (!row || selected?.amount_cents !== proposal.payload.snapshot.amount_cents) throw strategyError('proposal_amount_changed', '当前配置金额已变化，请重新生成');
    const acceptedSnapshot = buildExecutionSnapshot({ result, row, amountCents: selected.amount_cents });
    if (acceptedSnapshot.forecast.hash !== proposal.payload.forecast.hash) throw strategyError('forecast_changed', '收益情景已变化，请重新生成');
    const outside = strategy.frozenInput();
    if (outside.fingerprint !== frozen.fingerprint) throw strategyError('input_changed', '采纳准备期间输入已变化，请重算');
    return repository.transactionManager.run(() => {
      const active = strategyRepository.state();
      if (active?.activation_seq !== state.activation_seq || active.mode !== 'v9') throw strategyError('activation_changed', '采纳期间策略已切换');
      const current = proposals.get(id);
      if (current.status !== 'pending') {
        const existing = current.decision_id ? repository.listDecisions().find(row => row.id === current.decision_id) : null;
        if (existing && ['accepted', 'executed', 'confirmed'].includes(current.status)) return { proposal: current, decision: existing, existing: true };
        throw strategyError('proposal_changed', '提案已被其他请求处理');
      }
      const locked = strategy.readLedgerInput(frozen.input.date);
      if (fingerprint(materialPortfolio(locked)) !== fingerprint(materialPortfolio(frozen.input))) throw strategyError('input_changed', '采纳前资金或复核已变化，请重算');
      const definition = proposal.payload.decision;
      const decision = repository.createDecision({ date: frozen.input.date, product_name: proposal.product_name,
        action: proposal.action, reason: definition.reason, expectation: definition.expectation,
        invalidation_condition: definition.invalidation_condition, actual_result: '', strategy_version: CONTRACT.execution_version,
        target_annualized: 3, bucket_plan: { ...CONTRACT.bucket_targets, max_single: CONTRACT.max_single_pct },
        evidence_date: proposal.evidence_date, verify_date: proposal.verify_date, evaluation_at: ['buy_day', 'holding', 'maturity'], rating: '待评估',
        review_meta: { ...proposal.payload.review_meta, proposal_id: proposal.id, proposal_type: proposal.proposal_type,
          execution_snapshot: acceptedSnapshot, proposal_snapshot_hash: proposal.payload.snapshot.snapshot_hash,
          evaluation_contract: acceptedSnapshot.evaluation_contract, forecast: acceptedSnapshot.forecast,
          expected_legs: proposal.payload.expected_legs, predictions: [proposal.payload.prediction], prediction_results: {},
          lifecycle_status: 'accepted', execution_status: 'pending', audit_status: 'pending',
          source: 'v9-strategy-proposal', operation_id: `v9-adopt:${proposal.id}` } });
      const accepted = proposals.accept(id, decision.id);
      strategyRepository.reserve({ proposalId: id, decisionId: decision.id, legKey: legKey(row.mapping.product_code),
        amountCents: selected.amount_cents, expectedSeq: state.activation_seq, readAvailableCents: () => {
          if (fingerprint(materialPortfolio(strategy.readLedgerInput(frozen.input.date))) !== fingerprint(materialPortfolio(locked))) {
            throw strategyError('input_changed', '预留前账户已变化');
          }
          return result.account.available_cents;
        } });
      return { proposal: accepted, decision, existing: false, execution_status: 'pending_bank_execution' };
    });
  }
  // After a partial bank fill, only the unexecuted balance may be cancelled.
  // Confirmed trades, their lots, the decision and the frozen prediction stay
  // untouched; the original reservation is released down to the confirmed sum.
  function cancelRemaining(id, { reason = '' } = {}) {
    if (typeof reason !== 'string' || reason.length > 500) throw strategyError('invalid_input', '取消原因需为500字以内文本', 400);
    return repository.transactionManager.run(() => {
      const current = proposals.get(id);
      if (!current || current.payload?.execution_version !== CONTRACT.execution_version) {
        throw strategyError('proposal_missing', '未找到当前执行策略提案', 404);
      }
      if (current.payload?.kind === 'holding_exit' && !current.decision_id) {
        throw strategyError('proposal_not_accepted', '提案尚未采纳，无法取消剩余金额');
      }
      if (!current.decision_id) throw strategyError('proposal_not_accepted', '提案尚未采纳，无法取消剩余金额');
      if (!['accepted', 'executed', 'confirmed'].includes(current.status)) {
        throw strategyError('proposal_changed', '该提案当前不能取消剩余金额');
      }
      const decision = repository.listDecisions().find(row => String(row.id) === String(current.decision_id));
      if (!decision) throw strategyError('decision_missing', '提案关联决策不存在', 404);
      const meta = decision.review_meta ?? {};
      if (meta.remaining_cancelled_at) {
        return { proposal: current, decision, released_cents: 0, remaining_cents: 0, existing: true };
      }
      const linked = repository.tradeStore.listTrades()
        .filter(trade => trade.decision_id === decision.id && trade.status !== 'cancelled');
      if (linked.some(trade => trade.status === 'pending')) {
        throw strategyError('execution_pending', '仍有待确认交易，不能取消剩余金额');
      }
      if (!linked.length) throw strategyError('execution_missing', '没有已确认成交，请走整笔取消');
      const legs = meta.expected_legs ?? [];
      if (!legs.length) throw strategyError('invalid_decision', '决策缺少执行腿');
      const progress = legs.map(leg => {
        const confirmed = linked.filter(trade => {
          if (trade.status !== 'confirmed') return false;
          if (leg.side === 'buy') {
            return (trade.trade_type === 'buy' && trade.product_code === leg.product_code)
              || (trade.trade_type === 'switch' && trade.target_product_code === leg.product_code);
          }
          return ['redeem', 'switch'].includes(trade.trade_type) && trade.product_code === leg.product_code;
        }).reduce((sum, trade) => sum + moneyCents(trade.amount), 0);
        return { ...leg, expected_cents: moneyCents(leg.amount), confirmed_cents: confirmed };
      });
      const expected = progress.reduce((sum, leg) => sum + leg.expected_cents, 0);
      const confirmed = progress.reduce((sum, leg) => sum + leg.confirmed_cents, 0);
      if (confirmed <= 0) throw strategyError('execution_missing', '没有已确认成交，请走整笔取消');
      if (confirmed >= expected) throw strategyError('execution_complete', '该决策已全部成交，没有可取消余额');
      let released = 0;
      for (const reservation of strategyRepository.reservations().filter(row => row.proposal_id === id && row.state === 'active')) {
        const leg = progress.find(row => row.side === 'buy' && legKey(row.product_code) === reservation.leg_key);
        if (!leg) throw strategyError('reservation_mismatch', '资金预留无法匹配执行腿');
        if (leg.confirmed_cents > reservation.amount_cents) {
          throw strategyError('execution_exceeds_reservation', '实际执行超出原预留，需记录执行偏差');
        }
        const after = strategyRepository.reconcileReservation({ id: reservation.id,
          executedCents: leg.confirmed_cents, releaseRemaining: true });
        released += after.released_cents - reservation.released_cents;
      }
      const remaining = expected - confirmed;
      const updated = repository.updateDecision(decision.id, {
        ...decision,
        review_meta: {
          ...meta,
          execution_status: 'partial_cancelled',
          remaining_cancelled_at: new Date().toISOString(),
          remaining_cancelled_cents: remaining,
          remaining_cancelled_reason: reason.trim() || '用户取消未执行余额',
          current_revalidation_required: false,
        },
      });
      return { proposal: current, decision: updated, released_cents: released, remaining_cents: remaining, existing: false };
    });
  }
  function reject(id, { reason = '' } = {}) {
    if (typeof reason !== 'string' || reason.length > 500) throw strategyError('invalid_input', '拒绝原因需为500字以内文本', 400);
    return repository.transactionManager.run(() => {
      const current = proposals.get(id);
      if (!current || current.payload?.execution_version !== CONTRACT.execution_version) throw strategyError('proposal_missing', '未找到当前执行策略提案', 404);
      if (current.status === 'rejected') return { proposal: current, existing: true };
      if (!['pending', 'accepted'].includes(current.status)) throw strategyError('proposal_changed', '该提案当前不能直接拒绝');
      const linked = repository.tradeStore.listTrades().filter(trade => trade.decision_id === current.decision_id && trade.status !== 'cancelled');
      if (linked.length) throw strategyError('execution_exists', '已有银行交易关联，需先核对执行事实与未执行余额，不能整笔取消');
      const decision = current.decision_id ? repository.listDecisions().find(row => row.id === current.decision_id) : null;
      if (decision) repository.updateDecision(decision.id, { ...decision,
        actual_result: [decision.actual_result, `[取消未执行提案] ${reason.trim() || '用户取消'}`].filter(Boolean).join('\n'),
        review_meta: { ...decision.review_meta, lifecycle_status: 'cancelled', execution_status: 'cancelled', audit_status: 'cancelled',
          proposal_cancelled_at: new Date().toISOString() } });
      for (const row of strategyRepository.reservations().filter(row => row.proposal_id === id && row.state === 'active')) {
        strategyRepository.reconcileReservation({ id: row.id, executedCents: row.executed_cents, releaseRemaining: true });
      }
      return { proposal: proposals.reject(id, reason.trim()), existing: false };
    });
  }
  return { generate, adopt, reject, cancelRemaining };
}

module.exports = { materialPortfolio, createStrategyProposalService };
