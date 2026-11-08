'use strict';

const { CONTRACT, CONTRACT_HASH, fingerprint } = require('./contract');
const { verifyExecutionSnapshot } = require('./snapshot');
const { effectiveCoveredYieldDates } = require('../../../lib/product-income-coverage');
const { daysBetween, isoDate, shift } = require('../r2-screening/calendar');
const { roundHalfAwayFromZero } = require('../../../lib/yield-policy');

const cents = value => typeof value === 'number' && Number.isFinite(value) ? roundHalfAwayFromZero(value * 100, 0) : null;
const codeFor = trade => trade.trade_type === 'switch' ? trade.target_product_code : trade.product_code;
const startFor = trade => trade.confirm_date || trade.trade_date;
const safeSnapshot = decision => {
  const value = decision?.review_meta?.execution_snapshot;
  try { return verifyExecutionSnapshot(value) ? value : null; } catch { return null; }
};

function measureFrozenNetPnl({ decision, trades = [], valuations = [], allocations = [], settlements = [], today }) {
  const snapshot = safeSnapshot(decision);
  const unavailable = (reason, evidence = {}) => ({ available: false, reason, actual: null, evidence });
  if (!snapshot) return unavailable('historical_unfrozen');
  const forecast = snapshot.forecast;
  const linked = trades.filter(trade => trade.decision_id === decision.id && trade.status !== 'cancelled');
  const buys = linked.filter(trade => trade.status === 'confirmed' && ['buy', 'switch'].includes(trade.trade_type) &&
    codeFor(trade) === snapshot.mapping.product_code);
  if (!buys.length) return unavailable(linked.length ? 'unconfirmed_execution' : 'not_executed');
  if (linked.some(trade => trade.status === 'pending')) return unavailable('unconfirmed_execution');
  const invested = buys.reduce((sum, trade) => sum + cents(trade.amount), 0);
  if (invested !== snapshot.amount_cents) return unavailable('execution_amount_changed', { invested_cents: invested, expected_cents: snapshot.amount_cents });
  if (buys.some(trade => startFor(trade) !== forecast.confirm_date)) return unavailable('comparison_period_changed');
  const buyIds = new Set(buys.map(trade => trade.id));
  const closing = allocations.filter(row => buyIds.has(row.buy_trade_id));
  if (closing.length) {
    const tradeById = new Map(trades.map(trade => [trade.id, trade]));
    const closed = closing.reduce((sum, row) => sum + (cents(row.principal) ?? 0), 0);
    if (closed !== invested) return unavailable('partial_redemption', { redeemed_cents: closed, invested_cents: invested });
    const net = closing.reduce((sum, row) => sum + (cents(row.realized_pnl) ?? 0), 0);
    const confirmed = closing.every(row => {
      const trade = tradeById.get(row.redeem_trade_id);
      return trade?.status === 'confirmed' && typeof trade.settlement_amount === 'number' && Number.isFinite(trade.settlement_amount) &&
        typeof row.realized_pnl === 'number' && Number.isFinite(row.realized_pnl);
    });
    if (!confirmed) return unavailable('settlement_amount_unverified');
    const proof = closing.map(row => settlements.find(fact => fact.trade_id === row.redeem_trade_id && fact.status === 'verified' &&
      fact.product_code === snapshot.mapping.product_code && /^[a-f0-9]{64}$/.test(fact.evidence_hash ?? '') && isoDate(fact.arrival_date)));
    if (proof.some(fact => !fact || fact.arrival_date > today)) return unavailable('settlement_arrival_unverified');
    if (proof.some(fact => fact.arrival_date !== forecast.end_date)) return unavailable('comparison_period_changed');
    return { available: true, reason: 'confirmed_cash_settlement', actual: net,
      evidence: { basis: 'confirmed_settlement_allocation', realization: 'settled_cash',
        allocation_ids: closing.map(row => row.id), trade_ids: buys.map(trade => trade.id),
        settlement_trade_ids: [...new Set(closing.map(row => row.redeem_trade_id))],
        start_date: forecast.confirm_date, end_date: forecast.end_date } };
  }
  // A booked product return can be compared on the exact frozen holding window
  // without pretending that a redemption occurred. Non-zero transaction fees
  // need actual cost evidence; quoted fees are never manufactured as facts.
  const cost = decision.review_meta?.execution_costs;
  const verifiedCosts = cost?.verified === true && /^[a-f0-9]{64}$/.test(cost.evidence_hash ?? '') &&
    Number.isSafeInteger(cost.purchase_cents) && cost.purchase_cents >= 0 && Number.isSafeInteger(cost.redemption_cents) && cost.redemption_cents >= 0;
  if ((forecast.purchase_fee_bps !== 0 || forecast.redemption_fee_bps !== 0) && !verifiedCosts) return unavailable('actual_fees_unverified');
  const end = forecast.redemption_date;
  if (today < forecast.end_date) return unavailable('before_review_date');
  const expectedDays = daysBetween(forecast.confirm_date, end);
  const covered = new Set(), used = [], code = snapshot.mapping.product_code;
  let pnl = 0;
  const byBuy = new Map(allocations.map(row => [row.id ?? `${row.buy_trade_id}:${row.redeem_trade_id}`, row]));
  const remaining = (trade, date) => {
    if (trade.status !== 'confirmed' || startFor(trade) > date || !['buy', 'switch'].includes(trade.trade_type) || codeFor(trade) !== code) return 0;
    const disposed = [...byBuy.values()].filter(row => row.buy_trade_id === trade.id &&
      trades.some(sale => sale.id === row.redeem_trade_id && sale.status === 'confirmed' && startFor(sale) <= date))
      .reduce((sum, row) => sum + cents(row.principal), 0);
    return Math.max(0, cents(trade.trade_type === 'switch' ? trade.settlement_amount ?? trade.amount : trade.amount) - disposed);
  };
  const unique = new Set();
  for (const row of valuations.filter(row => row.product_code === code && row.yield_date >= forecast.confirm_date && row.yield_date < end)
    .sort((a, b) => a.yield_date.localeCompare(b.yield_date))) {
    if (unique.has(row.yield_date)) return unavailable('duplicate_product_fact');
    unique.add(row.yield_date);
    const dates = effectiveCoveredYieldDates(row.notes, row.yield_date);
    const scope = [...new Set([row.yield_date, ...dates])];
    if (scope.some(date => date < forecast.confirm_date || date >= end)) return unavailable('combined_period_ambiguous');
    const ratios = scope.map(date => {
      const own = buys.reduce((sum, trade) => sum + remaining(trade, date), 0);
      const whole = trades.reduce((sum, trade) => sum + remaining(trade, date), 0);
      return { own, whole };
    });
    const denominator = cents(row.holding_amount);
    if (denominator === null || denominator <= 0 || ratios.some(value => value.whole !== denominator || value.own <= 0) ||
        ratios.some(value => value.own !== ratios[0].own || value.whole !== ratios[0].whole)) return unavailable('holding_attribution_unverified');
    const amount = cents(row.daily_pnl);
    if (amount === null) return unavailable('product_pnl_unverified');
    pnl += amount * ratios[0].own / denominator;
    for (const date of scope) covered.add(date);
    used.push(row.id);
  }
  const minimum = snapshot.evaluation_contract.min_observations;
  // A net amount is not annualized/extrapolated across a missing date, even if
  // a lower sample-coverage threshold is enough to DISPLAY an interim series.
  const missing = [];
  for (let date = forecast.confirm_date; date < end; date = shift(date, 1)) if (!covered.has(date)) missing.push(date);
  if (used.length < minimum || missing.length || expectedDays <= 0) return unavailable('product_income_coverage_incomplete', {
    observed_records: used.length, covered_days: covered.size, expected_days: expectedDays, missing_dates: missing.slice(0, 31) });
  const fees = verifiedCosts ? cost.purchase_cents + cost.redemption_cents : 0;
  return { available: true, reason: 'confirmed_product_income', actual: roundHalfAwayFromZero(pnl, 0) - fees,
    evidence: { basis: 'product_daily_valuations', attribution: 'confirmed_principal_prorata', realization: 'booked_not_redeemed',
      valuation_ids: used, observed_records: used.length, covered_days: covered.size,
      start_date: forecast.confirm_date, end_exclusive: end, actual_fee_cents: fees,
      note: '仅为冻结持有期间内已记录产品收益，不假设已赎回或已取得退出现金。' } };
}

function evaluateExecutionDecision({ decision, trades = [], valuations = [], allocations = [], settlements = [], today }) {
  const holding = decision?.review_meta?.execution_snapshot;
  if (['holding_exit', 'holding_switch'].includes(holding?.kind)) {
    return evaluateHoldingDecision({ decision, trades, today });
  }
  const snapshot = safeSnapshot(decision);
  const linked = trades.filter(trade => trade.decision_id === decision.id && trade.status !== 'cancelled');
  if (!linked.length && decision.action !== '观察') return [];
  const frozenVersion = snapshot?.evaluation_contract?.version ?? `${decision.strategy_version}:historical-unfrozen`;
  const checks = [];
  const check = (key, label, pass, detail) => checks.push({ key, label, pass, detail });
  check('frozen-contract', '原策略与证据快照', Boolean(snapshot), snapshot ? '按决策冻结版本评价' : '历史未冻结或快照校验失败，不能按当前全局设置补造');
  let process = null;
  if (snapshot) {
    check('selection', '当时v9准入', snapshot.source_evidence.automatic_eligible === true,
      '只复核当时证据；当前续持监控与当时决策评价分离');
    check('whole-portfolio', '冻结整体组合约束', snapshot.allocation.full_investment === true && snapshot.portfolio.verified === true,
      `统一组合本金${snapshot.portfolio.principal_cents}分；不以本张提案金额作分母`);
    const actualPortfolio = decision.review_meta?.execution_portfolio_check;
    check('actual-portfolio', '实际交易后整体组合', actualPortfolio?.verified === true && Number.isSafeInteger(actualPortfolio.principal_cents) &&
      actualPortfolio.principal_cents > 0 ? actualPortfolio.constraints_pass === true : null,
    actualPortfolio?.verified === true ? `实际统一组合本金${actualPortfolio.principal_cents}分` : '实际交易后的整体敞口与原约束待核，不能只凭原计划代替');
    check('liquidity', '冻结流动性子集', snapshot.allocation.liquidity_cents >= snapshot.allocation.liquidity_required_cents,
      `${snapshot.allocation.liquidity_cents}/${snapshot.allocation.liquidity_required_cents}分`);
    const confirmed = linked.filter(trade => trade.status === 'confirmed');
    const amount = confirmed.filter(trade => ['buy', 'switch'].includes(trade.trade_type) && codeFor(trade) === snapshot.mapping.product_code)
      .reduce((sum, trade) => sum + cents(trade.amount), 0);
    const pending = linked.some(trade => trade.status === 'pending');
    const complete = amount >= snapshot.amount_cents && !pending;
    check('execution-amount', '实际执行与原金额', complete ? amount === snapshot.amount_cents : null,
      `已确认${amount}分，原计划${snapshot.amount_cents}分；未执行余额不假定成交`);
    check('execution-window', '交易时点复核', confirmed.length ? confirmed.every(trade => trade.trade_date === snapshot.input.business_date) : null,
      'App额度与当日复核只证明原执行日；延后交易属于需复核偏差');
    check('screenshots', '原始交易截图链', confirmed.length && confirmed.every(trade => Boolean(trade.screenshot_id)) ? true : null,
      '缺原始截图时流程保持待确认，真实交易仍保留');
    if (decision.review_meta?.execution_deviation?.excess?.length) check('execution-deviation', '执行偏差', false, '实际金额超过原预留，事实已保留');
    process = checks.some(item => item.pass === false) ? false : checks.some(item => item.pass === null) ? null : true;
  }
  const base = { scope: 'decision', decision_id: decision.id, trade_id: null, evaluated_for: today, rule_version: frozenVersion,
    auto_confidence_threshold: snapshot?.evaluation_contract.auto_confidence_threshold ?? 75,
    process_ok: process, outcome: 'unknown', rating: '待评估',
    confidence: process === null ? 45 : 85, confidence_level: process === null ? 'low' : 'high',
    evidence: { checks, strategy_version: decision.strategy_version, evaluation_contract: snapshot?.evaluation_contract ?? null,
      snapshot_hash: snapshot?.snapshot_hash ?? null, historical_basis: snapshot ? 'frozen' : 'historical_unfrozen',
      linked_trade_ids: linked.map(trade => trade.id), next_update: '结果按冻结情景与正式个人事实评价，3%目标独立展示' } };
  const candidates = [{ ...base, dedupe_key: `decision:${decision.id}:buy_day:${decision.date}`, stage: 'buy_day', period: decision.date,
    summary: snapshot ? `冻结策略流程${process === true ? '通过' : process === false ? '有执行偏差' : '待补证据'}；组合分母与原预测保持不变。`
      : '历史未冻结：原评价参数或策略证据不足，不能按最新设置代评。' }];
  if (!snapshot || today < snapshot.forecast.end_date) return candidates;
  const measured = measureFrozenNetPnl({ decision, trades, valuations, allocations, settlements, today });
  const actual = measured.available ? measured.actual : null;
  const tolerance = snapshot.evaluation_contract.result_tolerance_cents;
  const outcome = actual === null ? 'unknown' : actual >= snapshot.forecast.expected_net_pnl_cents - tolerance ? 'good' : 'bad';
  candidates.push({ ...base, dedupe_key: `decision:${decision.id}:maturity:${snapshot.forecast.end_date}`,
    stage: 'maturity', period: snapshot.forecast.end_date, outcome,
    rating: process === null || outcome === 'unknown' ? '待评估' : `流程${process ? '正确' : '错误'}，结果${outcome === 'good' ? '好' : '差'}`,
    confidence: actual === null || process === null ? 45 : 90, confidence_level: actual === null || process === null ? 'low' : 'high',
    summary: actual === null ? `冻结比较期待核：${measured.reason}，不以公开1M或3%目标代替个人结果。`
      : `冻结净收益情景${snapshot.forecast.expected_net_pnl_cents}分，个人事实${actual}分；结果${outcome === 'good' ? '达到' : '低于'}原情景。`,
    evidence: { ...base.evidence, result: measured, target_annualized_pct: 3, target_is_selection_hurdle: false } });
  return candidates;
}

function evaluateHoldingDecision({ decision, trades, today }) {
  const snapshot = decision.review_meta.execution_snapshot, plan = snapshot.plan;
  const { content_hash: planHash, ...body } = plan ?? {};
  const valid = Boolean(plan && planHash === snapshot.plan_hash && planHash === fingerprint(body) &&
    plan.execution_version === CONTRACT.execution_version && plan.contract_hash === CONTRACT_HASH &&
    plan.lot_id === snapshot.lot_id && plan.executable === true && plan.action === decision.action);
  const linked = trades.filter(row => row.decision_id === decision.id && row.status !== 'cancelled');
  if (!linked.length) return [];
  const checks = [{ key: 'frozen-contract', label: '原持仓计划与证据', pass: valid,
    detail: valid ? '按原批次、原金额及赎回路径评价，不使用买入收益预测或当前全局门槛' : '持仓计划快照缺失或校验失败' }];
  if (valid) {
    const legs = [{ side: 'redeem', product_code: plan.product_code }];
    if (snapshot.kind === 'holding_switch') legs.push({ side: 'buy', product_code: plan.target_product_code });
    for (const leg of legs) {
      const amount = linked.filter(row => row.status === 'confirmed' &&
        (leg.side === 'buy' ? ['buy', 'switch'].includes(row.trade_type) && codeFor(row) === leg.product_code
          : ['redeem', 'switch'].includes(row.trade_type) && row.product_code === leg.product_code))
        .reduce((sum, row) => sum + cents(row.amount), 0);
      checks.push({ key: `${leg.side}-amount`, label: leg.side === 'buy' ? '替换买入金额' : '持仓赎回金额',
        pass: amount > plan.amount_cents ? false : amount === plan.amount_cents && !linked.some(row => row.status === 'pending') ? true : null,
        detail: `确认${amount}分 / 原计划${plan.amount_cents}分；部分成交保留待确认` });
    }
    checks.push({ key: 'execution-window', label: '原赎回窗口', pass: linked.every(row => row.trade_date === plan.business_date),
      detail: '交易延后需重新核验原窗口和证据' });
    checks.push({ key: 'screenshots', label: '原始成交截图', pass: linked.every(row => row.screenshot_id) ? true : null,
      detail: '原始成交证据缺失保持待核' });
  }
  const process = checks.some(row => row.pass === false) ? false : checks.some(row => row.pass === null) ? null : true;
  return [{ scope: 'decision', decision_id: decision.id, trade_id: null, evaluated_for: today,
    dedupe_key: `decision:${decision.id}:holding:${decision.date}`, stage: 'holding', period: decision.date,
    rule_version: valid ? `${plan.review_version}:execution-v1` : `${decision.strategy_version}:historical-unfrozen`,
    auto_confidence_threshold: 75, process_ok: process, outcome: 'unknown', rating: '待评估',
    confidence: process === null ? 45 : 85, confidence_level: process === null ? 'low' : 'high',
    summary: valid ? `冻结持仓计划流程${process === true ? '通过' : process === false ? '有执行偏差' : '待补证据'}；退出结果按实际成交和到账核验，未约定收益预测不补造。`
      : '持仓计划未冻结或校验失败，不能套用当前设置补评。',
    evidence: { checks, strategy_version: decision.strategy_version, historical_basis: valid ? 'frozen' : 'historical_unfrozen',
      snapshot_hash: planHash ?? null, lot_id: snapshot.lot_id, linked_trade_ids: linked.map(row => row.id),
      next_update: '核验成交截图、剩余执行金额及实际到账；持仓退出无买入收益预测' } }];
}

module.exports = { measureFrozenNetPnl, evaluateExecutionDecision, safeSnapshot };
