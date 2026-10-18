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

function round(value, digits = 8) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function enrichRecords(records) {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
  let cumulativePnl = 0;
  let nav = 1;
  let peak = 1;

  return sorted.map((record) => {
    const principal = asNumber(record.principal);
    const dailyPnl = asNumber(record.daily_pnl);
    const dailyReturn = principal > 0 ? dailyPnl / principal : 0;
    cumulativePnl += dailyPnl;
    nav *= 1 + dailyReturn;
    peak = Math.max(peak, nav);
    const drawdown = nav / peak - 1;

    return {
      ...record,
      principal: round(principal, 4),
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

function buildWeekly(enrichedRecords, today) {
  if (!enrichedRecords.length) return null;
  const range = weekRange(today);
  const items = enrichedRecords.filter(
    (item) => item.date >= range.start && item.date <= range.end && item.date <= today,
  );
  const elapsedDays = Math.max(
    1,
    Math.min(
      7,
      Math.round((parseYmd(today) - parseYmd(range.start)) / DAY_MS) + 1,
    ),
  );
  const actions = countActions(items);
  const pnl = items.reduce((sum, item) => sum + item.daily_pnl, 0);
  const avgPrincipal = items.length
    ? items.reduce((sum, item) => sum + item.principal, 0) / items.length
    : 0;
  const returnPct = avgPrincipal > 0 ? (pnl / avgPrincipal) * 100 : null;

  return {
    week_start: range.start,
    week_end: range.end,
    record_days: items.length,
    elapsed_days: elapsedDays,
    missing_days: Math.max(0, elapsedDays - items.length),
    pnl: round(pnl, 2),
    avg_principal: round(avgPrincipal, 2),
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

function buildMonthRow(monthKey, items, today, isCurrent) {
  const totalDays = daysInMonth(monthKey);
  const elapsedDays = isCurrent ? Math.min(dayOfMonth(today), totalDays) : totalDays;
  const firstStamp = parseYmd(items[0].date);
  const lastStamp = parseYmd(items.at(-1).date);
  const calendarDays = Math.max(1, Math.round((lastStamp - firstStamp) / DAY_MS) + 1);
  const monthPnl = items.reduce((sum, item) => sum + item.daily_pnl, 0);
  const avgPrincipal =
    items.reduce((sum, item) => sum + item.principal, 0) / items.length;
  const returnPct = avgPrincipal > 0 ? (monthPnl / avgPrincipal) * 100 : null;
  const navReturn = navReturnOf(items);
  const annualizedPct =
    calendarDays >= 2 && 1 + navReturn > 0
      ? ((1 + navReturn) ** (365 / calendarDays) - 1) * 100
      : null;
  const negativeDays = items.filter((item) => item.daily_pnl < 0).length;
  const positiveDays = items.filter((item) => item.daily_pnl > 0).length;
  const actions = countActions(items);
  const sampleSufficient = calendarDays >= 28 && items.length >= 20;
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

  return {
    month: monthKey,
    month_label: `${monthKey.slice(0, 4)}年${Number(monthKey.slice(5, 7))}月`,
    first_date: items[0].date,
    last_date: items.at(-1).date,
    record_days: items.length,
    calendar_days: calendarDays,
    elapsed_days: elapsedDays,
    missing_days: Math.max(0, elapsedDays - items.length),
    record_coverage_pct:
      elapsedDays > 0 ? round(Math.min(100, (items.length / elapsedDays) * 100), 2) : null,
    pnl: round(monthPnl, 2),
    avg_principal: round(avgPrincipal, 2),
    return_pct: returnPct === null ? null : round(returnPct, 6),
    annualized_pct: annualizedPct === null ? null : round(annualizedPct, 6),
    max_drawdown_pct: round(maxDrawdownOf(items) * 100, 6),
    negative_days: negativeDays,
    positive_days: positiveDays,
    negative_day_ratio_pct: round((negativeDays / items.length) * 100, 2),
    best_day: round(Math.max(...items.map((item) => item.daily_pnl)), 2),
    worst_day: round(Math.min(...items.map((item) => item.daily_pnl)), 2),
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
    action_count: actions.total,
    buy_count: actions.buy,
    redeem_count: actions.redeem,
    switch_count: actions.switch,
  };
}

function buildComparison(row, previous) {
  if (!previous) return null;
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

function buildAlerts(records, today, currentMonth) {
  if (!records.length) return [];
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
    Math.round((parseYmd(today) - parseYmd(latest.date)) / DAY_MS),
  );
  if (gapDays >= 2) {
    alerts.push({
      level: 'warn',
      code: 'record-gap',
      text: `已 ${gapDays} 天没有记账，月收益和年化会被低估。`,
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

function buildReview(enrichedRecords, today = todayShanghai()) {
  const thresholds = [...GRADE_THRESHOLDS];
  if (!enrichedRecords.length) {
    return {
      thresholds,
      target_annualized_pct: TARGET_ANNUALIZED,
      target_month_pct: round(TARGET_MONTHLY_PCT, 4),
      daily: null,
      weekly: null,
      alerts: [],
      current_month: null,
      monthly: [],
    };
  }

  const groups = new Map();
  for (const record of enrichedRecords) {
    const monthKey = monthKeyOf(record.date);
    if (!groups.has(monthKey)) groups.set(monthKey, []);
    groups.get(monthKey).push(record);
  }

  const currentMonthKey = monthKeyOf(today);
  const monthRowsAscending = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([monthKey, items]) =>
      buildMonthRow(monthKey, items, today, monthKey === currentMonthKey),
    );
  const monthRows = monthRowsAscending.map((row, index) => ({
    ...row,
    compare: buildComparison(row, monthRowsAscending[index - 1] ?? null),
  }));

  const monthlyByKey = new Map(monthRows.map((item) => [item.month, item]));
  const latest = enrichedRecords.at(-1);
  const latestMonthKey = monthKeyOf(latest.date);
  const dailyMonth = monthlyByKey.get(latestMonthKey);
  const currentMonth = monthlyByKey.get(currentMonthKey) || null;
  return {
    thresholds,
    target_annualized_pct: TARGET_ANNUALIZED,
    target_month_pct: round(TARGET_MONTHLY_PCT, 4),
    daily: {
      date: latest.date,
      principal: round(latest.principal, 2),
      daily_pnl: round(latest.daily_pnl, 2),
      daily_return_pct: round(latest.daily_return * 100, 6),
      action: latest.action || '无操作',
      notes: latest.notes || '',
      month: dailyMonth.month,
      month_pnl: dailyMonth.pnl,
      month_avg_principal: dailyMonth.avg_principal,
      month_return_pct: dailyMonth.return_pct,
      month_grade: dailyMonth.grade_display,
      month_grade_preview: dailyMonth.grade_preview,
      month_record_days: dailyMonth.record_days,
      month_missing_days: dailyMonth.missing_days,
      month_target_progress_pct: dailyMonth.target_progress_pct,
      month_projected_pct: dailyMonth.projected_pct,
      provisional: dailyMonth.provisional,
    },
    weekly: buildWeekly(enrichedRecords, today),
    alerts: buildAlerts(enrichedRecords, today, currentMonth),
    current_month: currentMonth,
    monthly: [...monthRows].reverse(),
  };
}

module.exports = {
  DAY_MS,
  GRADE_THRESHOLDS,
  TARGET_ANNUALIZED,
  buildReview,
  buildWindows,
  enrichRecords,
  gradeMonthReturn,
  parseYmd,
  round,
  summarize,
  todayShanghai,
  windowRecords,
};
