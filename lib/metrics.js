'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const TARGET_ANNUALIZED = 3.0;
const GRADE_THRESHOLDS = [0.16, 0.20, 0.25, 0.30];

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

function buildReview(enrichedRecords, today = todayShanghai()) {
  const thresholds = [...GRADE_THRESHOLDS];
  if (!enrichedRecords.length) {
    return {
      thresholds,
      daily: null,
      current_month: null,
      monthly: [],
    };
  }

  const groups = new Map();
  for (const record of enrichedRecords) {
    const monthKey = record.date.slice(0, 7);
    if (!groups.has(monthKey)) groups.set(monthKey, []);
    groups.get(monthKey).push(record);
  }

  const currentMonthKey = today.slice(0, 7);
  const monthRows = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([monthKey, items]) => {
      const monthPnl = items.reduce((sum, item) => sum + item.daily_pnl, 0);
      const avgPrincipal =
        items.reduce((sum, item) => sum + item.principal, 0) / items.length;
      const returnPct = avgPrincipal > 0 ? (monthPnl / avgPrincipal) * 100 : null;
      const negativeDays = items.filter((item) => item.daily_pnl < 0).length;
      const positiveDays = items.filter((item) => item.daily_pnl > 0).length;
      const isCurrent = monthKey === currentMonthKey;
      return {
        month: monthKey,
        month_label: `${monthKey.slice(0, 4)}年${Number(monthKey.slice(5, 7))}月`,
        first_date: items[0].date,
        last_date: items.at(-1).date,
        record_days: items.length,
        pnl: round(monthPnl, 2),
        avg_principal: round(avgPrincipal, 2),
        return_pct: returnPct === null ? null : round(returnPct, 6),
        grade: gradeMonthReturn(returnPct),
        negative_days: negativeDays,
        positive_days: positiveDays,
        is_current: isCurrent,
        provisional: isCurrent,
      };
    });

  const monthlyByKey = new Map(monthRows.map((item) => [item.month, item]));
  const latest = enrichedRecords.at(-1);
  const latestMonthKey = latest.date.slice(0, 7);
  const dailyMonth = monthlyByKey.get(latestMonthKey);
  return {
    thresholds,
    daily: {
      date: latest.date,
      principal: round(latest.principal, 2),
      daily_pnl: round(latest.daily_pnl, 2),
      daily_return_pct: round(latest.daily_return * 100, 6),
      month: dailyMonth.month,
      month_pnl: dailyMonth.pnl,
      month_avg_principal: dailyMonth.avg_principal,
      month_return_pct: dailyMonth.return_pct,
      month_grade: dailyMonth.grade,
      month_record_days: dailyMonth.record_days,
      provisional: dailyMonth.provisional,
    },
    current_month: monthlyByKey.get(currentMonthKey) || null,
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
