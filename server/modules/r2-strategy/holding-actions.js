'use strict';

const { CONTRACT, CONTRACT_HASH, fingerprint, freeze } = require('./contract');
const { identityKey } = require('./evidence');
const { buildPublicLimits } = require('./public-limits');
const { moneyCents } = require('./account');
const { buildHoldingMonitoring } = require('./holdings');
const { isoDate, shift, daysBetween } = require('../r2-screening/calendar');
const { bucketForTerm, roundHalfAwayFromZero } = require('../../../lib/yield-policy');
const { calculateSwitch, dynamicMinGainAmount, comparisonDaysForBucket, MIN_YIELD_EDGE_PP, BREAK_EVEN_MARGIN_PP } = require('../../../lib/holdings-review');

const codeCompare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// Public screening has no verified redemption fee or arrival facts. Keep the
// plan's fee/arrival evidence explicitly unverified while allowing the
// ledger-derived redemption state to decide whether an exit intent can execute.
function currentPath() {
  return { verified: false, redemption_fee_bps: null, fee_verified: false,
    funds_available_date: null, reason: null };
}

function buildHoldingActionPlans({ holdings, context, monitoringContext = context, date,
  validateReplacement = null }) {
  if (!isoDate(date) || context?.date !== date || monitoringContext?.date !== date) throw new Error('持仓计划需使用当前业务日的冻结上下文');
  const monitoring = buildHoldingMonitoring({ holdings, context: monitoringContext, date });
  const holdingByLot = new Map(holdings.map(row => [row.lot_id, row]));
  const plans = monitoring.rows.map(monitor => {
    const holding = holdingByLot.get(monitor.lot_id);
    const amountCents = moneyCents(holding.amount);
    const current = monitoringContext.rows.find(row => row.mapping?.product_code === holding.product_code) ?? null;
    const path = currentPath();
    const base = { payload_version: 1, execution_version: CONTRACT.execution_version, review_version: CONTRACT.holding_review_version,
      selection_policy_version: CONTRACT.selection_policy_version, yield_policy_version: CONTRACT.yield_policy_version,
      contract_hash: CONTRACT_HASH, business_date: date, lot_id: holding.lot_id,
      product_code: holding.product_code, product_name: holding.product_name ?? holding.product_code,
      amount_cents: amountCents, current_identity: current?.identity ?? null, target_identity: null,
      source_fingerprint: context.fingerprint, monitoring_fingerprint: monitoringContext.fingerprint,
      monitor_fingerprint: monitor.fingerprint, evidence_date: monitor.performance_date,
      verify_date: monitor.next_verify_date, invalidation_condition: '同份额收益、赎回窗口、到账、费用或组合承诺变化时重新核验；观察计划不得自动变为银行交易。',
      action: '观察', planned_action: monitor.planned_action, state: monitor.state, reason: monitor.summary,
      executable: false, blockers: [], warnings: [], candidates: [], comparison: null,
      redemption: { ...monitor.redemption, ...path },
      dedupe_key: fingerprint({ type: monitor.yield_state === 'below' ? 'mandatory_holding_exit' : 'holding_review',
        lot_id: holding.lot_id, contract_hash: CONTRACT_HASH }),
      frozen_evidence: { current } };
    if (monitor.yield_state === 'below') {
      // This branch deliberately precedes candidate/economic comparison. No
      // replacement or positive net edge is needed to retain an exit intent.
      base.action = monitor.action;
      base.executable = monitor.redemption.redeemable_now;
      base.blockers = base.executable ? [] : [monitor.redemption.reason];
      base.warnings = base.executable
        ? ['赎回费用与到账日未核验，以银行实际扣费/到账为准']
        : ['退出意图保留；费用或到账待核，不把不达标产品改判为符合续持'];
      return seal(base);
    }
    if (monitor.yield_state !== 'pass' || monitor.state === 'risk_review' || !current) {
      base.blockers = monitor.yield_state !== 'pass' ? ['holding_yield_unverified'] : monitor.risk_reasons;
      return seal(base);
    }
    const reference = current.reference;
    const currentBucket = bucketForTerm(current.term?.days);
    const horizon = comparisonDaysForBucket(currentBucket);
    const end = shift(date, horizon);
    const minGain = dynamicMinGainAmount(holding.amount, horizon);
    // The comparison scenario is a property of the holding, not of whether a
    // candidate survives; keep it even when there is nothing to switch into.
    base.comparison = { start_date: date, end_date: end, days: horizon,
      current_reference_yield_pct: Number.isFinite(reference?.value_pct) ? reference.value_pct : null,
      minimum_gain_amount: minGain, reinvestment_is_guaranteed: false };
    if (reference?.status !== 'available' || !Number.isFinite(reference.value_pct)) {
      base.blockers = ['current_reference_unavailable'];
      base.reason = '续持收益门槛通过，但当前产品指定参考收益窗口不可计算，不能用1月年化代算替换增益。';
      return seal(base);
    }
    const candidateRows = context.available && context.contract_hash === CONTRACT_HASH ? context.rows.filter(row =>
      row.automatic_eligible && row.mapping && identityKey(row.identity) !== identityKey(current.identity) &&
      Number.isInteger(row.term?.days) && row.term.days > 0 && row.term.days <= CONTRACT.max_term_days &&
      bucketForTerm(row.term?.days) === currentBucket && row.reference?.status === 'available') : [];
    candidateRows.sort((a, b) => a.term.days - b.term.days || codeCompare(a.category, b.category) ||
      (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
      codeCompare(identityKey(a.identity), identityKey(b.identity)));
    const evaluated = candidateRows.map(candidate => {
      const review = buildPublicLimits({ row: candidate, date, amountCents });
      const blockers = [...review.blockers];
      const confirm = shift(date, 1);
      if (!isoDate(confirm) || (path.funds_available_date && confirm < path.funds_available_date)) blockers.push('switch_funding_date_unverified');
      const wait = isoDate(confirm) ? daysBetween(date, confirm) : null;
      let economics = null;
      if (path.redemption_fee_bps === null || !path.fee_verified) {
        blockers.push('redemption_fee_unverified');
      } else if (wait !== null && wait >= 0) {
        economics = calculateSwitch({ amount: holding.amount, currentYieldPct: reference.value_pct, horizonDays: horizon,
          redemptionFeeBps: path.redemption_fee_bps, switchWaitDays: wait,
          newYieldPct: candidate.reference.value_pct, purchaseFeeBps: 0 });
      }
      const edge = roundHalfAwayFromZero(candidate.reference.value_pct - reference.value_pct);
      const economicPass = Boolean(economics && edge >= MIN_YIELD_EDGE_PP && economics.difference >= minGain &&
        economics.break_even_yield_pct !== null && candidate.reference.value_pct > economics.break_even_yield_pct + BREAK_EVEN_MARGIN_PP);
      if (!economicPass) blockers.push('switch_economics_not_met');
      let portfolio = { ok: false, reasons: ['portfolio_revalidation_required'], risk_not_worse: false, liquidity_not_worse: false };
      if (typeof validateReplacement === 'function') {
        const supplied = validateReplacement({ holding: structuredClone(holding), current, candidate, amount_cents: amountCents,
          comparison_end: end, comparison_days: horizon, limits: review.limits });
        if (supplied?.then) throw new Error('组合替换核验必须为同步纯计算');
        if (supplied && typeof supplied === 'object') portfolio = supplied;
      }
      if (portfolio.ok !== true) blockers.push(...(Array.isArray(portfolio.reasons) && portfolio.reasons.length ? portfolio.reasons : ['portfolio_revalidation_required']));
      if (portfolio.risk_not_worse !== true) blockers.push('replacement_risk_unverified');
      if (portfolio.liquidity_not_worse !== true) blockers.push('replacement_liquidity_unverified');
      const reinvestment = candidate.term.days < horizon;
      if (!monitor.redemption.redeemable_now) blockers.push('holding_not_redeemable_now');
      return { identity: candidate.identity, product_code: candidate.mapping.product_code, name: candidate.name,
        group: candidate.group, rank: candidate.rank, evidence_hash: candidate.evidence_hash,
        check_id: null, check_hash: null,
        amount_cents: amountCents, reference_yield_pct: candidate.reference.value_pct, yield_edge_pp: edge,
        comparison_start: date, comparison_end: end, comparison_days: horizon, switch_wait_days: wait,
        min_gain_amount: minGain, economics, economic_pass: economicPass, reinvestment_required: reinvestment,
        reinvestment_note: reinvestment ? '比较期是情景，超过候选最短持有期的部分涉及再投资；未来额度与收益不能保证。' : null,
        executable: blockers.length === 0, blockers: [...new Set(blockers)], portfolio_check: portfolio };
    });
    const chosen = evaluated.find(row => row.executable) ?? null;
    // Only a locked holding can have a post-maturity observation plan; an open
    // window never defers an executable switch to a later date.
    const future = !monitor.redemption.redeemable_now ? evaluated.find(row => row.economic_pass &&
      row.blockers.every(code => code === 'holding_not_redeemable_now')) ?? null : null;
    base.candidates = evaluated.slice(0, 6);
    if (chosen && !base.candidates.includes(chosen)) base.candidates[base.candidates.length - 1] = chosen;
    if (chosen) {
      if (chosen.reinvestment_required) base.warnings = [chosen.reinvestment_note];
      const target = candidateRows.find(row => identityKey(row.identity) === identityKey(chosen.identity));
      base.action = '切换'; base.planned_action = 'replace'; base.state = 'replacement_ready'; base.executable = true;
      base.target_identity = chosen.identity; base.target_product_code = chosen.product_code;
      base.reason = `同本金比较至${end}，按v9原组内第${chosen.rank}名选择；扣费及空档后增益${chosen.economics.difference.toFixed(2)}元达到门槛。银行执行前仍需检查当时窗口。`;
      base.frozen_evidence.candidate = target;
      base.dedupe_key = fingerprint({ type: 'voluntary_holding_switch', lot_id: holding.lot_id,
        target_identity: chosen.identity, contract_hash: CONTRACT_HASH });
    } else if (future) {
      base.planned_action = 'replace_at_maturity'; base.state = 'replacement_at_open';
      base.target_identity = future.identity; base.target_product_code = future.product_code;
      base.blockers = ['holding_not_redeemable_now'];
      base.reason = '替换情景具有经济性，但当前仍锁定；仅保存到期后观察计划，到窗口必须重新验证候选、额度和收益。';
    } else {
      base.planned_action = 'review_holding';
      base.blockers = !candidateRows.length ? ['no_verified_replacement_candidates'] : [...new Set(evaluated.flatMap(row => row.blockers))];
      base.reason = '当前近期收益达到续持门槛，尚无同时满足经济性、条款、额度和组合约束的可执行替换；保留证据与下次验证日期，不自动续作。';
    }
    return seal(base);
  });
  return freeze({ version: CONTRACT.holding_review_version, business_date: date, plans,
    fingerprint: fingerprint(plans), monitoring });
}

function seal(body) {
  const normalized = JSON.parse(JSON.stringify(body));
  return { ...normalized, content_hash: fingerprint(normalized) };
}

module.exports = { buildHoldingActionPlans };
