'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const TARGET_ANNUALIZED = 3.0;
const GRADE_THRESHOLDS = [0.16, 0.20, 0.25, 0.30];
const TARGET_MONTHLY_PCT =
  (Math.pow(1 + TARGET_ANNUALIZED / 100, 1 / 12) - 1) * 100;

function parseYmd(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const [year, month, day] = value.split('-').map(Number);
  const stamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(stamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return stamp;
}

function todayShanghai(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function reportingDateShanghai(now = new Date(), lagDays = 1) {
  const today = todayShanghai(now);
  return shiftDate(today, -lagDays);
}

function shiftDate(date, days) {
  const stamp = parseYmd(date);
  return stamp === null ? null : formatStamp(stamp + days * DAY_MS);
}

function round(value, digits = 8) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function tradeEffectiveDate(trade) {
  return trade.confirm_date || trade.trade_date;
}

function buildHoldingAmountsByDate(records, trades = []) {
  const dates = [...new Set(records.map((record) => record.date))].sort();
  const confirmedTrades = trades
    .filter((trade) => trade.status === 'confirmed')
    .sort(
      (a, b) =>
        tradeEffectiveDate(a).localeCompare(tradeEffectiveDate(b)) ||
        String(a.trade_date || '').localeCompare(String(b.trade_date || '')) ||
        Number(a.id) - Number(b.id),
    );
  const holdingAmounts = new Map();
  let amount = 0;
  let tradeIndex = 0;

  for (const date of dates) {
    while (
      tradeIndex < confirmedTrades.length &&
      tradeEffectiveDate(confirmedTrades[tradeIndex]) <= date
    ) {
      const trade = confirmedTrades[tradeIndex];
      if (trade.trade_type === 'buy') {
        amount += asNumber(trade.amount);
      } else if (trade.trade_type === 'redeem') {
        amount -= asNumber(trade.amount);
      } else if (trade.trade_type === 'switch') {
        amount -= asNumber(trade.amount);
        amount += asNumber(trade.settlement_amount ?? trade.amount);
      }
      amount = Math.max(0, amount);
      tradeIndex += 1;
    }
    holdingAmounts.set(date, round(amount, 2));
  }

  return holdingAmounts;
}

function enrichRecords(records, options = {}) {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
  let cumulativePnl = 0;
  let nav = 1;
  let peak = 1;
  const holdingAmountsByDate = options.holdingAmountsByDate || null;

  return sorted.map((record) => {
    const principal = asNumber(record.principal);
    const fallbackHoldingAmount = asNumber(
      record.holding_amount,
      principal,
    );
    const holdingAmount = holdingAmountsByDate?.has(record.date)
      ? asNumber(holdingAmountsByDate.get(record.date))
      : fallbackHoldingAmount;
    const dailyPnl = asNumber(record.daily_pnl);
    const dailyReturn = holdingAmount > 0 ? dailyPnl / holdingAmount : 0;
    cumulativePnl += dailyPnl;
    nav *= 1 + dailyReturn;
    peak = Math.max(peak, nav);
    const drawdown = nav / peak - 1;

    return {
      ...record,
      principal: round(principal, 4),
      holding_amount: round(holdingAmount, 2),
      daily_pnl: round(dailyPnl, 4),
      cumulative_pnl: round(cumulativePnl, 4),
      net_value: round(principal + cumulativePnl, 4),
      daily_return: round(dailyReturn, 10),
      nav_index: round(nav, 10),
      drawdown: round(drawdown, 10),
    };
  });
}

function summarize(enrichedRecords, targetAnnualized = TARGET_ANNUALIZED) {
  if (!enrichedRecords.length) {
    return {
      record_count: 0,
      first_date: null,
      last_date: null,
      calendar_days: 0,
      total_pnl: 0,
      avg_principal: 0,
      latest_principal: 0,
      avg_holding_amount: 0,
      latest_holding_amount: 0,
      latest_net_value: 0,
      latest_daily_pnl: 0,
      latest_daily_return: 0,
      latest_cumulative_pnl: 0,
      period_return: 0,
      period_return_pct: 0,
      annualized_pct: null,
      max_drawdown: 0,
      max_drawdown_pct: 0,
      negative_days: 0,
      negative_day_ratio_pct: 0,
      best_day: 0,
      worst_day: 0,
      sample_sufficient: false,
      target_annualized_pct: targetAnnualized,
      target_gap_pct: null,
      target_status: '等待记录',
      nav_start: 1,
      nav_end: 1,
    };
  }

  const firstStamp = parseYmd(enrichedRecords[0].date);
  const lastStamp = parseYmd(enrichedRecords.at(-1).date);
  const calendarDays = Math.max(1, Math.round((lastStamp - firstStamp) / DAY_MS) + 1);
  const totalPnl = enrichedRecords.reduce((sum, item) => sum + item.daily_pnl, 0);
  const avgPrincipal =
    enrichedRecords.reduce((sum, item) => sum + item.principal, 0) / enrichedRecords.length;
  const avgHoldingAmount =
    enrichedRecords.reduce((sum, item) => sum + item.holding_amount, 0) /
    enrichedRecords.length;

  let nav = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const item of enrichedRecords) {
    nav *= 1 + item.daily_return;
    peak = Math.max(peak, nav);
    maxDrawdown = Math.min(maxDrawdown, nav / peak - 1);
  }

  const periodReturn = nav - 1;
  const annualized =
    calendarDays >= 2 && nav > 0 ? nav ** (365 / calendarDays) - 1 : null;
  const annualizedPct = annualized === null ? null : annualized * 100;
  const targetGapPct = annualizedPct === null ? null : annualizedPct - targetAnnualized;
  const negativeDays = enrichedRecords.filter((item) => item.daily_pnl < 0).length;
  const latest = enrichedRecords.at(-1);
  const sampleSufficient = calendarDays >= 28 && enrichedRecords.length >= 20;

  let targetStatus = '样本不足';
  if (annualizedPct !== null) {
    targetStatus = sampleSufficient
      ? targetGapPct >= 0
        ? '达到目标'
        : '低于目标'
      : '样本不足';
  }

  return {
    record_count: enrichedRecords.length,
    first_date: enrichedRecords[0].date,
    last_date: latest.date,
    calendar_days: calendarDays,
    total_pnl: round(totalPnl, 4),
    avg_principal: round(avgPrincipal, 2),
    latest_principal: round(latest.principal, 2),
    avg_holding_amount: round(avgHoldingAmount, 2),
    latest_holding_amount: round(latest.holding_amount, 2),
    latest_net_value: round(latest.net_value, 2),
    latest_daily_pnl: round(latest.daily_pnl, 2),
    latest_daily_return: round(latest.daily_return, 10),
    latest_cumulative_pnl: round(latest.cumulative_pnl, 2),
    period_return: round(periodReturn, 10),
    period_return_pct: round(periodReturn * 100, 6),
    annualized_pct: annualizedPct === null ? null : round(annualizedPct, 6),
    max_drawdown: round(maxDrawdown, 10),
    max_drawdown_pct: round(maxDrawdown * 100, 6),
    negative_days: negativeDays,
    negative_day_ratio_pct: round((negativeDays / enrichedRecords.length) * 100, 2),
    best_day: round(Math.max(...enrichedRecords.map((item) => item.daily_pnl)), 2),
    worst_day: round(Math.min(...enrichedRecords.map((item) => item.daily_pnl)), 2),
    sample_sufficient: sampleSufficient,
    target_annualized_pct: targetAnnualized,
    target_gap_pct: targetGapPct === null ? null : round(targetGapPct, 6),
    target_status: targetStatus,
    nav_start: 1,
    nav_end: round(nav, 10),
  };
}

function windowRecords(enrichedRecords, days) {
  if (!enrichedRecords.length) return [];
  if (!Number.isFinite(days) || days <= 0) return enrichedRecords;
  const lastStamp = parseYmd(enrichedRecords.at(-1).date);
  const cutoff = lastStamp - (days - 1) * DAY_MS;
  const selected = enrichedRecords.filter((item) => parseYmd(item.date) >= cutoff);
  return selected.length ? selected : enrichedRecords.slice(-1);
}

function buildWindows(enrichedRecords) {
  const windows = {};
  for (const days of [7, 30, 90]) {
    windows[days] = summarize(windowRecords(enrichedRecords, days));
  }
  return windows;
}

function gradeMonthReturn(returnPct) {
  if (!Number.isFinite(returnPct)) return '无记录';
  if (returnPct >= 0.30) return '卓越';
  if (returnPct >= 0.25) return '优秀';
  if (returnPct >= 0.20) return '良好';
  if (returnPct >= 0.16) return '及格';
  return '不及格';
}

function monthKeyOf(date) {
  return date.slice(0, 7);
}

function daysInMonth(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayOfMonth(date) {
  return Number(date.slice(8, 10));
}

function formatStamp(stamp) {
  return new Date(stamp).toISOString().slice(0, 10);
}

function monthLabelOf(monthKey) {
  return `${monthKey.slice(0, 4)}年${Number(monthKey.slice(5, 7))}月`;
}

function monthKeysBetween(start, end, limit = 24) {
  const [startYear, startMonth] = start.split('-').map(Number);
  const [endYear, endMonth] = end.split('-').map(Number);
  const startIndex = startYear * 12 + (startMonth - 1);
  const endIndex = endYear * 12 + (endMonth - 1);
  const firstIndex = Math.max(startIndex, endIndex - limit + 1);
  const keys = [];
  for (let index = firstIndex; index <= endIndex; index += 1) {
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    keys.push(`${year}-${String(month).padStart(2, '0')}`);
  }
  return keys;
}

function dateKey(monthKey, day) {
  return `${monthKey}-${String(day).padStart(2, '0')}`;
}

function missingDatesBetween(startDate, endDate, recordedDates) {
  const recorded = new Set(recordedDates);
  const missing = [];
  const startStamp = parseYmd(startDate);
  const endStamp = parseYmd(endDate);
  if (startStamp === null || endStamp === null || startStamp > endStamp) return missing;
  for (let stamp = startStamp; stamp <= endStamp; stamp += DAY_MS) {
    const date = formatStamp(stamp);
    if (!recorded.has(date)) missing.push(date);
  }
  return missing;
}

function monthDate(monthKey, day) {
  return `${monthKey}-${String(day).padStart(2, '0')}`;
}

function resolveMonthWindow(
  monthKey,
  reportingDate,
  isCurrent,
  accountStartDate,
) {
  const totalDays = daysInMonth(monthKey);
  const monthStartDate = `${monthKey}-01`;
  const monthEndDate = monthDate(monthKey, totalDays);
  const calendarElapsedDays = !isCurrent
    ? totalDays
    : reportingDate < monthStartDate
      ? 0
      : Math.min(
          dayOfMonth(
            reportingDate > monthEndDate ? monthEndDate : reportingDate,
          ),
          totalDays,
        );
  const calendarEndDate =
    calendarElapsedDays > 0
      ? monthDate(monthKey, calendarElapsedDays)
      : null;
  const activeStartDate =
    accountStartDate && accountStartDate > monthStartDate
      ? accountStartDate
      : monthStartDate;
  const activeEndDate = calendarEndDate;
  const active =
    activeEndDate !== null &&
    activeStartDate <= activeEndDate &&
    activeStartDate <= monthEndDate;
  const elapsedDays = active
    ? Math.round((parseYmd(activeEndDate) - parseYmd(activeStartDate)) / DAY_MS) + 1
    : 0;
  const beforeStartDays =
    active && calendarElapsedDays > 0
      ? Math.max(
          0,
          Math.round(
            (parseYmd(activeStartDate) - parseYmd(monthStartDate)) / DAY_MS,
          ),
        )
    : calendarElapsedDays;
  return {
    totalDays,
    calendarElapsedDays,
    calendarEndDate,
    active,
    activeStartDate: active ? activeStartDate : null,
    activeEndDate: active ? activeEndDate : null,
    elapsedDays,
    beforeStartDays,
  };
}

function buildEmptyMonthRow(
  monthKey,
  reportingDate,
  isCurrent,
  accountStartDate = null,
) {
  const window = resolveMonthWindow(
    monthKey,
    reportingDate,
    isCurrent,
    accountStartDate,
  );
  const elapsedDays = window.elapsedDays;
  const targetMtdPct =
    ((1 + TARGET_ANNUALIZED / 100) ** (elapsedDays / 365) - 1) * 100;
  const missingDates = window.active
    ? missingDatesBetween(window.activeStartDate, window.activeEndDate, [])
    : [];
  return {
    month: monthKey,
    month_label: monthLabelOf(monthKey),
    first_date: null,
    last_date: null,
    has_records: false,
    record_days: 0,
    calendar_days: 0,
    account_start_date: accountStartDate,
    active_start_date: window.activeStartDate,
    before_start_days: window.beforeStartDays,
    is_before_start: !window.active,
    elapsed_days: elapsedDays,
    days_remaining: Math.max(0, window.totalDays - window.calendarElapsedDays),
    missing_days: elapsedDays,
    recorded_dates: [],
    missing_dates: missingDates,
    record_coverage_pct: 0,
    pnl: 0,
    avg_principal: 0,
    avg_holding_amount: 0,
    return_pct: null,
    annualized_pct: null,
    max_drawdown_pct: 0,
    negative_days: 0,
    positive_days: 0,
    negative_day_ratio_pct: 0,
    best_day: 0,
    worst_day: 0,
    target_month_pct: round(TARGET_MONTHLY_PCT, 4),
    target_mtd_pct: round(targetMtdPct, 4),
    target_progress_pct: null,
    target_gap_pct: null,
    projected_pct: null,
    grade: null,
    grade_preview: null,
    grade_display: isCurrent ? '待记录' : '未记录',
    grade_range: null,
    sample_sufficient: false,
    final: false,
    is_current: isCurrent,
    provisional: isCurrent,
    action_count: 0,
    buy_count: 0,
    redeem_count: 0,
    switch_count: 0,
    records_needed_for_grade: 20,
    days_needed_for_grade: 28,
    grade_eligible: false,
    score_status: isCurrent ? 'no_records' : 'missing',
  };
}

function weekRange(today) {
  const stamp = parseYmd(today);
  const weekday = new Date(stamp).getUTCDay();
  const offset = (weekday + 6) % 7;
  const start = stamp - offset * DAY_MS;
  return {
    start: formatStamp(start),
    end: formatStamp(start + 6 * DAY_MS),
  };
}

function navReturnOf(items) {
  let nav = 1;
  for (const item of items) {
    nav *= 1 + asNumber(item.daily_return);
  }
  return nav - 1;
}

function maxDrawdownOf(items) {
  let nav = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const item of items) {
    nav *= 1 + asNumber(item.daily_return);
    peak = Math.max(peak, nav);
    maxDrawdown = Math.min(maxDrawdown, nav / peak - 1);
  }
  return maxDrawdown;
}

function negativeStreakOf(items) {
  let streak = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (asNumber(items[index].daily_pnl) < 0) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

function countActions(items) {
  const counts = { total: 0, buy: 0, redeem: 0, switch: 0 };
  for (const item of items) {
    const action = String(item.action || '').trim();
    if (!action || action === '无操作') continue;
    counts.total += 1;
    if (action === '买入') counts.buy += 1;
    if (action === '赎回') counts.redeem += 1;
    if (action === '切换') counts.switch += 1;
  }
  return counts;
}

function buildWeekly(enrichedRecords, reportingDate, accountStartDate = null) {
  if (!enrichedRecords.length) return null;
  const range = weekRange(reportingDate);
  const activeStartDate =
    accountStartDate && accountStartDate > range.start ? accountStartDate : range.start;
  const active =
    activeStartDate <= reportingDate && activeStartDate <= range.end;
  const items = active
    ? enrichedRecords.filter(
        (item) =>
          item.date >= activeStartDate &&
          item.date <= range.end &&
          item.date <= reportingDate,
      )
    : [];
  const elapsedDays = active
    ? Math.min(
        7,
        Math.round(
          (parseYmd(reportingDate) - parseYmd(activeStartDate)) / DAY_MS,
        ) + 1,
      )
    : 0;
  const actions = countActions(items);
  const pnl = items.reduce((sum, item) => sum + item.daily_pnl, 0);
  const avgPrincipal = items.length
    ? items.reduce((sum, item) => sum + item.principal, 0) / items.length
    : 0;
  const avgHoldingAmount = items.length
    ? items.reduce((sum, item) => sum + item.holding_amount, 0) / items.length
    : 0;
  const returnPct =
    avgHoldingAmount > 0 ? (pnl / avgHoldingAmount) * 100 : null;

  return {
    week_start: range.start,
    week_end: range.end,
    account_start_date: accountStartDate,
    active_start_date: active ? activeStartDate : null,
    record_days: items.length,
    elapsed_days: elapsedDays,
    missing_days: Math.max(0, elapsedDays - items.length),
    pnl: round(pnl, 2),
    avg_principal: round(avgPrincipal, 2),
    avg_holding_amount: round(avgHoldingAmount, 2),
    return_pct: returnPct === null ? null : round(returnPct, 6),
    negative_days: items.filter((item) => item.daily_pnl < 0).length,
    positive_days: items.filter((item) => item.daily_pnl > 0).length,
    best_day: items.length ? round(Math.max(...items.map((item) => item.daily_pnl)), 2) : null,
    worst_day: items.length ? round(Math.min(...items.map((item) => item.daily_pnl)), 2) : null,
    action_count: actions.total,
    buy_count: actions.buy,
    redeem_count: actions.redeem,
    switch_count: actions.switch,
    consecutive_negative_days: negativeStreakOf(enrichedRecords),
  };
}

function buildMonthRow(
  monthKey,
  items,
  reportingDate,
  isCurrent,
  accountStartDate = null,
) {
  const window = resolveMonthWindow(
    monthKey,
    reportingDate,
    isCurrent,
    accountStartDate,
  );
  const elapsedDays = window.elapsedDays;
  const activeItems = window.active
    ? items.filter(
        (item) =>
          item.date >= window.activeStartDate && item.date <= window.activeEndDate,
      )
    : [];
  if (!activeItems.length) {
    return buildEmptyMonthRow(
      monthKey,
      reportingDate,
      isCurrent,
      accountStartDate,
    );
  }
  const totalDays = window.totalDays;
  const firstStamp = parseYmd(activeItems[0].date);
  const lastStamp = parseYmd(activeItems.at(-1).date);
  const calendarDays = Math.max(1, Math.round((lastStamp - firstStamp) / DAY_MS) + 1);
  const monthPnl = activeItems.reduce((sum, item) => sum + item.daily_pnl, 0);
  const avgPrincipal =
    activeItems.reduce((sum, item) => sum + item.principal, 0) / activeItems.length;
  const avgHoldingAmount =
    activeItems.reduce((sum, item) => sum + item.holding_amount, 0) /
    activeItems.length;
  const returnPct =
    avgHoldingAmount > 0 ? (monthPnl / avgHoldingAmount) * 100 : null;
  const navReturn = navReturnOf(activeItems);
  const annualizedPct =
    calendarDays >= 2 && 1 + navReturn > 0
      ? ((1 + navReturn) ** (365 / calendarDays) - 1) * 100
      : null;
  const negativeDays = activeItems.filter((item) => item.daily_pnl < 0).length;
  const positiveDays = activeItems.filter((item) => item.daily_pnl > 0).length;
  const actions = countActions(activeItems);
  const sampleSufficient = elapsedDays >= 28 && activeItems.length >= 20;
  const provisional = isCurrent;
  const final = !provisional && sampleSufficient;
  const previewGrade =
    returnPct === null ? null : gradeMonthReturn(returnPct);
  const grade = final ? previewGrade : null;
  const targetMtdPct =
    ((1 + TARGET_ANNUALIZED / 100) ** (elapsedDays / 365) - 1) * 100;
  const targetProgressPct =
    returnPct === null || targetMtdPct <= 0 ? null : (returnPct / targetMtdPct) * 100;
  const projectedPct =
    provisional && returnPct !== null && elapsedDays > 0
      ? ((1 + returnPct / 100) ** (totalDays / elapsedDays) - 1) * 100
      : returnPct;
  const projectionLow =
    returnPct === null || projectedPct === null
      ? null
      : Math.min(returnPct, projectedPct);
  const projectionHigh =
    returnPct === null || projectedPct === null
      ? null
      : Math.max(returnPct, projectedPct);
  const recordedDates = activeItems.map((item) => item.date);

  return {
    month: monthKey,
    month_label: monthLabelOf(monthKey),
    first_date: activeItems[0].date,
    last_date: activeItems.at(-1).date,
    has_records: true,
    record_days: activeItems.length,
    calendar_days: calendarDays,
    account_start_date: accountStartDate,
    active_start_date: window.activeStartDate,
    before_start_days: window.beforeStartDays,
    is_before_start: false,
    elapsed_days: elapsedDays,
    days_remaining: Math.max(0, totalDays - window.calendarElapsedDays),
    missing_days: Math.max(0, elapsedDays - activeItems.length),
    recorded_dates: recordedDates,
    missing_dates: missingDatesBetween(
      window.activeStartDate,
      window.activeEndDate,
      recordedDates,
    ),
    record_coverage_pct:
      elapsedDays > 0
        ? round(Math.min(100, (activeItems.length / elapsedDays) * 100), 2)
        : null,
    pnl: round(monthPnl, 2),
    avg_principal: round(avgPrincipal, 2),
    avg_holding_amount: round(avgHoldingAmount, 2),
    return_pct: returnPct === null ? null : round(returnPct, 6),
    annualized_pct: annualizedPct === null ? null : round(annualizedPct, 6),
    max_drawdown_pct: round(maxDrawdownOf(activeItems) * 100, 6),
    negative_days: negativeDays,
    positive_days: positiveDays,
    negative_day_ratio_pct: round((negativeDays / activeItems.length) * 100, 2),
    best_day: round(Math.max(...activeItems.map((item) => item.daily_pnl)), 2),
    worst_day: round(Math.min(...activeItems.map((item) => item.daily_pnl)), 2),
    target_month_pct: round(TARGET_MONTHLY_PCT, 4),
    target_mtd_pct: round(targetMtdPct, 4),
    target_progress_pct:
      targetProgressPct === null ? null : round(targetProgressPct, 2),
    target_gap_pct:
      annualizedPct === null ? null : round(annualizedPct - TARGET_ANNUALIZED, 6),
    projected_pct: projectedPct === null ? null : round(projectedPct, 6),
    grade,
    grade_preview: previewGrade,
    grade_display: grade || (provisional ? '进行中' : '样本不足'),
    grade_range:
      provisional && projectionLow !== null && projectionHigh !== null
        ? {
            low: gradeMonthReturn(projectionLow),
            high: gradeMonthReturn(projectionHigh),
          }
        : null,
    sample_sufficient: sampleSufficient,
    final,
    is_current: isCurrent,
    provisional,
    records_needed_for_grade: Math.max(0, 20 - activeItems.length),
    days_needed_for_grade: Math.max(0, 28 - elapsedDays),
    grade_eligible: final,
    score_status: final
      ? 'scored'
      : provisional
        ? 'in_progress'
        : 'insufficient',
    action_count: actions.total,
    buy_count: actions.buy,
    redeem_count: actions.redeem,
    switch_count: actions.switch,
  };
}

function buildComparison(row, previous) {
  if (!previous || !previous.has_records) return null;
  const delta = (current, before) =>
    current === null || before === null || current === undefined || before === undefined
      ? null
      : round(current - before, 6);
  return {
    prev_month: previous.month,
    prev_month_label: previous.month_label,
    pnl_delta: round(row.pnl - previous.pnl, 2),
    return_delta_pp: delta(row.return_pct, previous.return_pct),
    drawdown_delta_pp: delta(row.max_drawdown_pct, previous.max_drawdown_pct),
    negative_ratio_delta_pp: delta(
      row.negative_day_ratio_pct,
      previous.negative_day_ratio_pct,
    ),
    action_delta: row.action_count - previous.action_count,
  };
}

function buildAlerts(records, reportingDate, currentMonth) {
  if (!records.length) {
    if (!currentMonth || currentMonth.elapsed_days === 0) return [];
    return [
      {
        level: 'warn',
        code: 'no-month-records',
        text: currentMonth?.is_before_start
          ? '本金账户尚未进入本月，暂无收益记录需要补记。'
          : `截至 ${reportingDate}，本月还没有收益记录；先补最近已披露的收益。`,
      },
    ];
  }
  const alerts = [];
  const latest = records.at(-1);
  const streak = negativeStreakOf(records);
  if (streak >= 3) {
    alerts.push({
      level: 'warn',
      code: 'negative-streak',
      text: `连续 ${streak} 天负收益，按周检查节奏复核，不用单日赎回。`,
    });
  }
  if (asNumber(latest.daily_return) <= -0.001) {
    alerts.push({
      level: 'warn',
      code: 'single-day-drop',
      text: `最新单日跌幅 ${Math.abs(latest.daily_return * 100).toFixed(2)}%，超过 0.10% 观察阈值。`,
    });
  }
  const gapDays = Math.max(
    0,
    Math.round((parseYmd(reportingDate) - parseYmd(latest.date)) / DAY_MS),
  );
  if (gapDays >= 2) {
    alerts.push({
      level: 'warn',
      code: 'record-gap',
      text: `截至 ${reportingDate} 已 ${gapDays} 天没有记账，月收益和年化会被低估。`,
    });
  }
  if (currentMonth && currentMonth.missing_days >= 3) {
    alerts.push({
      level: 'info',
      code: 'missing-days',
      text: `本月缺记 ${currentMonth.missing_days} 天，记录完整度 ${currentMonth.record_coverage_pct ?? 0}%。`,
    });
  }
  if (
    currentMonth &&
    currentMonth.elapsed_days > 0 &&
    currentMonth.record_days === 0
  ) {
    alerts.push({
      level: 'warn',
      code: 'current-month-empty',
      text: `${currentMonth.month_label}还没有任何收益记录，先补最近已披露的收益，再回看月度评分。`,
    });
  }
  if (
    currentMonth &&
    currentMonth.elapsed_days >= 7 &&
    currentMonth.target_progress_pct !== null &&
    currentMonth.target_progress_pct < 80
  ) {
    alerts.push({
      level: 'info',
      code: 'target-behind',
      text: `本月目标进度 ${currentMonth.target_progress_pct}%，落后于按天折算的 3% 目标。`,
    });
  }
  return alerts.slice(0, 4);
}

function buildReview(
  enrichedRecords,
  today = todayShanghai(),
  {
    initialDate = null,
    reportingDate = today,
    reportingLagDays = 1,
  } = {},
) {
  const thresholds = [...GRADE_THRESHOLDS];
  const accountStart =
    typeof initialDate === 'string' && parseYmd(initialDate) !== null ? initialDate : null;
  const eligibleRecords = accountStart
    ? enrichedRecords.filter((record) => record.date >= accountStart)
    : enrichedRecords;

  const groups = new Map();
  for (const record of eligibleRecords) {
    const monthKey = monthKeyOf(record.date);
    if (!groups.has(monthKey)) groups.set(monthKey, []);
    groups.get(monthKey).push(record);
  }

  const currentMonthKey = monthKeyOf(today);
  const firstMonthKey = accountStart
    ? monthKeyOf(accountStart)
    : eligibleRecords.length
      ? monthKeyOf(eligibleRecords[0].date)
      : currentMonthKey;
  const monthKeys = monthKeysBetween(firstMonthKey, currentMonthKey, 24);
  const monthRowsAscending = monthKeys.map((monthKey) => {
    const items = groups.get(monthKey);
    return items && items.length
      ? buildMonthRow(
          monthKey,
          items,
          reportingDate,
          monthKey === currentMonthKey,
          accountStart,
        )
      : buildEmptyMonthRow(
          monthKey,
          reportingDate,
          monthKey === currentMonthKey,
          accountStart,
        );
  });
  const monthRows = monthRowsAscending.map((row, index) => ({
    ...row,
    compare: buildComparison(row, monthRowsAscending[index - 1] ?? null),
  }));

  const monthlyByKey = new Map(monthRows.map((item) => [item.month, item]));
  const currentMonth = monthlyByKey.get(currentMonthKey) || null;
  const latest = eligibleRecords.at(-1) || null;
  const latestMonthKey = latest ? monthKeyOf(latest.date) : null;
  const dailyMonth = latestMonthKey ? monthlyByKey.get(latestMonthKey) || null : null;
  return {
    thresholds,
    target_annualized_pct: TARGET_ANNUALIZED,
    target_month_pct: round(TARGET_MONTHLY_PCT, 4),
    account_start_date: accountStart,
    reporting_date: reportingDate,
    reporting_lag_days: reportingLagDays,
    daily:
      latest && dailyMonth
        ? {
            date: latest.date,
            principal: round(latest.principal, 2),
            holding_amount: round(latest.holding_amount, 2),
            daily_pnl: round(latest.daily_pnl, 2),
            daily_return_pct: round(latest.daily_return * 100, 6),
            action: latest.action || '无操作',
            notes: latest.notes || '',
            month: dailyMonth.month,
            month_pnl: dailyMonth.pnl,
            month_avg_principal: dailyMonth.avg_principal,
            month_avg_holding_amount: dailyMonth.avg_holding_amount,
            month_return_pct: dailyMonth.return_pct,
            month_grade: dailyMonth.grade_display,
            month_grade_preview: dailyMonth.grade_preview,
            month_record_days: dailyMonth.record_days,
            month_missing_days: dailyMonth.missing_days,
            month_target_progress_pct: dailyMonth.target_progress_pct,
            month_projected_pct: dailyMonth.projected_pct,
            provisional: dailyMonth.provisional,
          }
        : null,
    weekly: buildWeekly(eligibleRecords, reportingDate, accountStart),
    alerts: buildAlerts(eligibleRecords, reportingDate, currentMonth),
    current_month: currentMonth,
    monthly: [...monthRows].reverse(),
  };
}

module.exports = {
  buildHoldingAmountsByDate,
  DAY_MS,
  GRADE_THRESHOLDS,
  TARGET_ANNUALIZED,
  buildReview,
  buildWindows,
  enrichRecords,
  gradeMonthReturn,
  parseYmd,
  reportingDateShanghai,
  round,
  shiftDate,
  summarize,
  todayShanghai,
  windowRecords,
};
