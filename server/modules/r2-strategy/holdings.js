'use strict';

const { CONTRACT, CONTRACT_HASH, fingerprint, freeze } = require('./contract');
const { DEFAULT_POLICY } = require('./policy-settings');
const { isoDate, shift } = require('../r2-screening/calendar');
const { decimal, fresh } = require('../r2-screening/policy');
const { holdingExitConditions } = require('./exit-conditions');

// A review parameter, not an execution contract or a forecast. A warning never
// changes mandatory exits, candidate eligibility or the switch break-even test.
function holdingObservation(current, yieldState, date, policy = DEFAULT_POLICY) {
  const { screening, exit } = policy;
  const metrics = current?.metrics?.observation ?? null;
  const recentReturnThreshold = screening.min_monthly_yield * 7 / 365;
  const result = { version: 2, state: 'pending', threshold_pct: exit.observation_upper_pct,
    recent_return_threshold_pct: recentReturnThreshold, reasons: [], metrics };
  if (yieldState !== 'pass' || !current || !fresh(current.performance_date, date, screening.max_data_age_days) ||
      current.nav_fresh !== true || current.monitoring_verified === false) return result;
  const monthly = decimal(current.performance?.['1m']);
  if (monthly === null) return result;
  if (monthly >= decimal(String(exit.observation_upper_pct))) return { ...result, state: 'clear' };
  const recent = metrics?.recent, trend = metrics?.trend;
  const recentUsable = recent?.status === 'available' && fresh(recent.end_date, date, screening.max_data_age_days) && recent.days === 7 &&
    Number.isFinite(recent.return_pct);
  const periods = trend?.periods;
  const trendUsable = trend?.status === 'available' && periods?.length === 3 &&
    periods[2].end_date < date && periods[2].end_date.slice(0, 7) === shift(date.slice(0, 7) + '-01', -1).slice(0, 7);
  if (trendUsable && trend.weak) result.reasons.push('monthly_trend_weak');
  if (recentUsable && recent.return_pct < recentReturnThreshold) result.reasons.push('recent_yield_weak');
  return { ...result, state: result.reasons.length ? 'watch' : recentUsable && trendUsable ? 'clear' : 'pending' };
}

// The pretrade review store is retired, so redemption timing is derived from
// the ledger's own maturity facts. Fees and arrival dates stay explicitly
// unverified; the bank's actual execution remains authoritative.
function redemptionFor(holding, date) {
  const termDays = Number(holding.term_days);
  const startDate = isoDate(holding.confirm_date)
    ? holding.confirm_date
    : isoDate(holding.purchase_date)
      ? holding.purchase_date
      : null;
  const maturity = isoDate(holding.maturity_date)
    ? holding.maturity_date
    : (Number.isFinite(termDays) && termDays > 0 && startDate
      ? shift(startDate, termDays)
      : null);
  if (maturity) {
    if (date < maturity) {
      return Object.freeze({ state: 'locked', redeemable_now: false,
        earliest_redeem_date: maturity, funds_available_date: null,
        arrival_unverified: true, reason: 'holding_locked_until_maturity' });
    }
    return Object.freeze({ state: 'open', redeemable_now: true,
      earliest_redeem_date: null, funds_available_date: null,
      arrival_unverified: true, reason: null });
  }
  if (!Number.isFinite(termDays) || termDays <= 0) {
    return Object.freeze({ state: 'open', redeemable_now: true,
      earliest_redeem_date: null, funds_available_date: null,
      arrival_unverified: true, reason: null });
  }
  return Object.freeze({ state: 'unknown', redeemable_now: false,
    earliest_redeem_date: null, funds_available_date: null,
    arrival_unverified: true, reason: 'maturity_date_unverified' });
}

function buildHoldingMonitoring({ holdings, context, date, policy = DEFAULT_POLICY }) {
  if (!isoDate(date)) throw new Error('持仓监控业务日无效');
  if (!Array.isArray(holdings) || holdings.length > 20000) throw new Error('持仓监控输入无效');
  const hardFailure = context?.blockers?.some(code => ['batch_version_or_status', 'batch_invalid', 'duplicate_identity', 'source_identity_or_calendar'].includes(code));
  const currentContext = context?.date === date && context.contract_hash === CONTRACT_HASH;
  const products = new Map();
  for (const row of context?.rows ?? []) {
    const code = row.mapping?.product_code;
    if (!code) continue;
    const yieldState = currentContext && (!hardFailure || row.monitoring_verified === true)
      ? row.holding_yield_state ?? 'pending' : 'pending';
    products.set(code, products.has(code) ? null : { current: row, yieldState });
  }
  const seen = new Set();
  const rows = holdings.map(holding => {
    if (!holding.lot_id || seen.has(holding.lot_id) || !Number.isFinite(holding.amount) || holding.amount <= 0) throw new Error('持仓批次重复或金额无效');
    seen.add(holding.lot_id);
    const { current = null, yieldState = 'pending' } = products.get(holding.product_code) ?? {};
    const redemption = redemptionFor(holding, date);
    const observation = holdingObservation(current, yieldState, date, policy);
    const exitConditions = holdingExitConditions(current, yieldState, date, policy);
    const riskReasons = [];
    const drawdown = current?.metrics?.drawdown;
    if (Number.isFinite(drawdown?.pct) ? drawdown.pct >= policy.screening.drawdown_watch_pct
      : ['watch', 'reject'].includes(drawdown?.band)) riskReasons.push('drawdown_risk');
    // A missing/stale NAV is evidence that needs review, not a yield failure:
    // never turn it into a redemption, but do not show the holding as verified.
    if (current?.nav_fresh === false) riskReasons.push('nav_evidence_unverified');
    // A failed refresh keeps the latest public evidence, but the holding must be
    // re-verified before it can be shown as an unchanged hold.
    if (current?.monitoring_verified === false) riskReasons.push('monitor_evidence_unverified');
    if (current?.term?.days > policy.screening.max_term_days || ['periodic', 'rolling', 'conflict'].includes(current?.term?.kind)) riskReasons.push('term_risk_review');
    if (current?.detail?.equity_upper_pct > policy.screening.equity_review_pct) riskReasons.push('equity_limit_review');
    let state, action = '观察', plannedAction = 'verify_holding', summary, userAction = false;
    if (exitConditions.status === 'met') {
      userAction = true;
      if (redemption.redeemable_now) {
        state = 'exit_required'; action = '赎回'; plannedAction = 'redeem';
        summary = `近7日总收益率低于${exitConditions.recent_return_threshold_pct}%、近1月年化低于${exitConditions.monthly_yield_threshold_pct}%，且近6月年化>近3月年化>近1月年化，三项同时满足。已到可赎窗口，生成退出决策提案。费用与到账日按银行确认。`;
      } else if (redemption.state === 'locked') {
        state = 'exit_at_open'; plannedAction = 'exit_at_maturity';
        summary = `三项退出条件同时满足，锁定中；最早${redemption.earliest_redeem_date}重新核验退出窗口，当前保留到期退出意图。`;
      } else {
        state = 'exit_rules_pending'; plannedAction = 'exit_when_verified';
        summary = '三项退出条件同时满足，赎回规则或当前窗口待核；补齐窗口证据后生成退出决策。';
      }
    } else if (yieldState === 'below') {
      state = exitConditions.status === 'pending' ? 'evidence_pending' : 'hold';
      plannedAction = 'verify_holding';
      summary = exitConditions.status === 'pending'
        ? `近1月年化低于${policy.screening.min_monthly_yield}%，三项退出条件的7日或6/3/1月证据待核；暂不生成赎回或切换决策，暂停新增和加仓。`
        : `近1月年化低于${policy.screening.min_monthly_yield}%，尚未同时满足三项退出条件；继续观察，暂停新增和加仓。`;
    } else if (yieldState === 'pending') {
      state = 'evidence_pending';
      userAction = !current;
      summary = '当前同份额近期收益缺失、过期或身份待核，续持判断待核；禁止新买或加仓，不将缺失当作收益不达标。';
    } else if (riskReasons.length) {
      state = 'risk_review'; userAction = true;
      summary = '回撤、期限、资产或公开证据需单独复核。';
    } else if (exitConditions.checks.monthly_yield === 'met') {
      state = exitConditions.status === 'pending' ? 'evidence_pending' : 'hold';
      const threshold = exitConditions.monthly_yield_threshold_pct;
      summary = exitConditions.status === 'pending'
        ? `近1月年化低于${threshold}%，7日或6/3/1月退出证据待核。`
        : `近1月年化低于${threshold}%，三项退出条件未同时满足，继续观察。`;
    } else {
      state = 'hold'; plannedAction = 'review_holding';
      summary = '近期收益达到续持门槛；公开售罄或未入选候选不单独触发退出。是否自愿替换仍需比较扣费和空档后的净收益。';
      if (observation.state === 'watch') summary = '达到续持底线，但收益走弱，进入观察；提前复核同桶替代品，换仓仍需覆盖费用和空档，不据此生成退出意图。';
    }
    const expiry = current?.performance_date && isoDate(current.performance_date) ? shift(current.performance_date, policy.screening.max_data_age_days + 1) : date;
    const nextVerify = [expiry, redemption.state === 'locked' ? redemption.earliest_redeem_date : null]
      .filter(value => value && value > date).sort()[0] ?? date;
    const body = { lot_id: holding.lot_id, holding_id: holding.id ?? null, product_code: holding.product_code,
      product_name: holding.product_name ?? holding.product_code, amount: holding.amount,
      confirm_date: holding.confirm_date ?? holding.purchase_date ?? null,
      execution_version: CONTRACT.execution_version, review_version: CONTRACT.holding_review_version,
      contract_hash: CONTRACT_HASH, business_date: date, source_fingerprint: context?.fingerprint ?? null,
      identity: current?.identity ?? null, mapping_id: current?.mapping?.id ?? null, evidence_hash: current?.evidence_hash ?? null,
      run_id: current?.run_id ?? null, yield_state: yieldState, yield_1m: current?.performance?.['1m'] ?? null,
      performance_date: current?.performance_date ?? null, screening_status: current?.screening_status ?? 'pending',
      hints: current?.hints ?? [], risk_reasons: riskReasons, observation, exit_conditions: exitConditions, state, action, planned_action: plannedAction,
      redemption, check_id: null, next_verify_date: nextVerify, summary,
      requires_user_action: userAction,
      message_key: fingerprint({ type: exitConditions.status === 'met' ? 'holding_exit' : 'holding_review', lot_id: holding.lot_id,
        contract_hash: CONTRACT_HASH }) };
    return { ...body, fingerprint: fingerprint(body) };
  });
  const priorities = { exit_required: 0, exit_at_open: 1, exit_rules_pending: 2, risk_review: 3, evidence_pending: 4, hold: 5 };
  rows.sort((a, b) => priorities[a.state] - priorities[b.state] ||
    Number(b.observation.state === 'watch') - Number(a.observation.state === 'watch') || a.lot_id.localeCompare(b.lot_id));
  return freeze({ version: CONTRACT.holding_review_version, date, rows,
    counts: Object.fromEntries(Object.keys(priorities).map(key => [key, rows.filter(row => row.state === key).length])) });
}

module.exports = { buildHoldingMonitoring };
