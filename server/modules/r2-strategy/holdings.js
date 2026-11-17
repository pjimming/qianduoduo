'use strict';

const { CONTRACT, CONTRACT_HASH, fingerprint, freeze } = require('./contract');
const { isoDate, shift } = require('../r2-screening/calendar');
const { decimal, fresh } = require('../r2-screening/policy');

// A review parameter, not an execution contract or a forecast. A warning never
// changes mandatory exits, candidate eligibility or the switch break-even test.
function holdingObservation(current, yieldState, date) {
  const metrics = current?.metrics?.observation ?? null;
  const recentReturnThreshold = Number(CONTRACT.min_monthly_yield) * 7 / 365;
  const result = { version: 2, state: 'pending', threshold_pct: 2.5,
    recent_return_threshold_pct: recentReturnThreshold, reasons: [], metrics };
  if (yieldState !== 'pass' || !current || !fresh(current.performance_date, date) ||
      current.nav_fresh !== true || current.monitoring_verified === false) return result;
  const monthly = decimal(current.performance?.['1m']);
  if (monthly === null) return result;
  if (monthly >= decimal('2.5')) return { ...result, state: 'clear' };
  const recent = metrics?.recent, trend = metrics?.trend;
  const recentUsable = recent?.status === 'available' && fresh(recent.end_date, date) && recent.days === 7 &&
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

function buildHoldingMonitoring({ holdings, context, date }) {
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
    const observation = holdingObservation(current, yieldState, date);
    const riskReasons = [];
    if (['watch', 'reject'].includes(current?.metrics?.drawdown?.band)) riskReasons.push('drawdown_risk');
    // A missing/stale NAV is evidence that needs review, not a yield failure:
    // never turn it into a redemption, but do not show the holding as verified.
    if (current?.nav_fresh === false) riskReasons.push('nav_evidence_unverified');
    // A failed refresh keeps the latest public evidence, but the holding must be
    // re-verified before it can be shown as an unchanged hold.
    if (current?.monitoring_verified === false) riskReasons.push('monitor_evidence_unverified');
    if (current?.term?.days > CONTRACT.max_term_days || ['periodic', 'rolling', 'conflict'].includes(current?.term?.kind)) riskReasons.push('term_risk_review');
    if (current?.detail?.equity_upper_pct > 5) riskReasons.push('equity_limit_review');
    let state, action = '观察', plannedAction = 'verify_holding', summary, userAction = false;
    if (yieldState === 'below') {
      userAction = true;
      if (redemption.redeemable_now) {
        state = 'exit_required'; action = '赎回'; plannedAction = 'redeem';
        summary = '有效近1月年化低于2.15%，不符合续持；按账本到期日已可赎回，准备退出。赎回费用与到账日仍需银行确认。无替代品时仍保留退出结论。';
      } else if (redemption.state === 'locked') {
        state = 'exit_at_open'; plannedAction = 'exit_at_maturity';
        summary = `续持不达标，锁定中；最早${redemption.earliest_redeem_date}重新核验退出窗口，当前不能提前赎回。`;
      } else {
        state = 'exit_rules_pending'; plannedAction = 'exit_when_verified';
        summary = '续持不达标，赎回规则或当前窗口待核；补齐证据后准备退出，不自动续作。';
      }
    } else if (yieldState === 'pending') {
      state = 'evidence_pending';
      userAction = !current;
      summary = '当前同份额近期收益缺失、过期或身份待核，续持判断待核；禁止新买或加仓，不将缺失当作收益不达标。';
    } else if (riskReasons.length) {
      state = 'risk_review'; userAction = true;
      summary = '近期收益达到续持门槛，但回撤、期限或资产条件需单独复核；未形成已成交赎回事实。';
    } else {
      state = 'hold'; plannedAction = 'review_holding';
      summary = '近期收益达到续持门槛；公开售罄或未进前三不单独触发退出。是否自愿替换仍需比较扣费和空档后的净收益。';
      if (observation.state === 'watch') summary = '达到续持底线，但收益走弱，进入观察；提前复核同桶替代品，换仓仍需覆盖费用和空档，不据此生成退出意图。';
    }
    const expiry = current?.performance_date && isoDate(current.performance_date) ? shift(current.performance_date, 7) : date;
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
      hints: current?.hints ?? [], risk_reasons: riskReasons, observation, state, action, planned_action: plannedAction,
      redemption, check_id: null, next_verify_date: nextVerify, summary,
      requires_user_action: userAction,
      message_key: fingerprint({ type: yieldState === 'below' ? 'holding_exit' : 'holding_review', lot_id: holding.lot_id,
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
