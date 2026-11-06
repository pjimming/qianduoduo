'use strict';

const { isoDate, daysBetween, shift } = require('./calendar');

const RULE_VERSION = 'v9';
const CATEGORIES = ['bond', 'deposit', 'enhanced', 'unknown'];
const STATES = ['eligible', 'watch', 'pending', 'rejected'];
const HINTS = [
  'frequent_zero', 'zero_pending', 'trend_weak', 'trend_pending', 'trend_short',
  'quota_default', 'quota_low', 'term_unknown', 'category_unknown', 'equity_review', 'calendar_gap',
];
const compareKey = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function decimal(value, positive = false) {
  if (typeof value !== 'string' || !/^-?\d{1,12}(?:\.\d{1,12})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const integer = BigInt(whole) * 10n ** 12n +
    (value.startsWith('-') ? -1n : 1n) * BigInt(fraction.padEnd(12, '0'));
  return positive && integer <= 0n ? null : integer;
}

function fresh(date, asOf) {
  const age = isoDate(date) ? daysBetween(date, asOf) : NaN;
  return age >= 0 && age < 7;
}

function yearStart(date) {
  const previous = String(Number(date.slice(0, 4)) - 1) + date.slice(4);
  return isoDate(previous) || previous.slice(0, 8) + '28';
}

function monthEnds(asOf, calendar) {
  return [3, 2, 1, 0].map(offset => {
    const end = new Date(Date.UTC(+asOf.slice(0, 4), +asOf.slice(5, 7) - 1 - offset, 0));
    let date = end.toISOString().slice(0, 10);
    while (calendar.isOpen(date) === false) date = shift(date, -1);
    return calendar.isOpen(date) ? date : null;
  });
}

function percent(numerator, denominator) {
  return Number(numerator) / Number(denominator) * 100;
}

function drawdown(points) {
  let high = points[0];
  let peak = high;
  let trough = high;
  let loss = 0n;
  for (const point of points.slice(1)) {
    if (point.value > high.value) high = point;
    const change = high.value - point.value;
    if (change * peak.value > loss * high.value) {
      peak = high;
      trough = point;
      loss = change;
    }
  }
  if (loss === 0n) return { band: 'pass', pct: 0, recovery: 'none' };
  const repair = points.find(point => point.date > trough.date && point.value >= peak.value);
  return {
    band: loss * 200n > peak.value * 3n ? 'reject' : loss * 100n >= peak.value ? 'watch' : 'pass',
    pct: percent(loss, peak.value), peak_date: peak.date, trough_date: trough.date,
    peak_value: peak.unit, trough_value: trough.unit,
    recovery: repair ? 'repaired' : 'unrepaired', repair_date: repair?.date ?? null,
    repair_days: repair ? daysBetween(trough.date, repair.date) : null,
  };
}

function navMetrics(nav, date, calendar, valuationBasis) {
  const metrics = {
    latest: null, start: null, end: null, count: 0, recent: [], zero_dates: null,
    trend: 'pending', month_ends: [], monthly_returns: [],
    drawdown: { band: 'pending', pct: null, recovery: 'pending' },
    issue: nav?.issue || 'nav_unavailable',
  };
  if (!nav?.points?.length) return metrics;

  const byDate = new Map();
  for (const point of nav.points) {
    const value = decimal(point.unit, true);
    if (!isoDate(point.date) || point.date > date || value === null) return { ...metrics, issue: 'nav_invalid' };
    const prior = byDate.get(point.date);
    if (prior && prior.value !== value) return { ...metrics, issue: 'nav_conflict' };
    if (!prior) byDate.set(point.date, { ...point, value });
  }
  const all = [...byDate.values()].sort((a, b) => compareKey(a.date, b.date));
  metrics.latest = all.at(-1).date;
  const from = yearStart(metrics.latest);
  const relevant = all.filter(point => point.date >= from);
  if (relevant[0].date < calendar.start || metrics.latest > calendar.end) return { ...metrics, issue: 'calendar_gap' };
  const points = relevant.filter(point => calendar.isOpen(point.date));
  metrics.start = points[0]?.date ?? null;
  metrics.end = points.at(-1)?.date ?? null;
  metrics.count = points.length;
  if (!fresh(metrics.latest, date) || !fresh(metrics.end, date)) return { ...metrics, issue: 'nav_stale' };
  if (points.length < 2) return { ...metrics, issue: 'nav_insufficient' };
  metrics.issue = null;
  metrics.drawdown = drawdown(points);
  const recent = points.slice(-7);
  metrics.recent = recent.map(({ date, unit }) => ({ date, unit }));
  if (recent.length === 7) {
    metrics.zero_dates = recent.slice(1).filter((point, i) => point.value === recent[i].value).map(point => point.date);
  }

  const ends = monthEnds(date, calendar);
  const tradingPoints = new Map(points.map(point => [point.date, point]));
  metrics.month_ends = ends.map(end => ({ date: end, unit: tradingPoints.get(end)?.unit ?? null }));
  if (ends.some(end => end === null)) {
    metrics.trend = 'calendar_gap';
  } else if (all[0].date > ends[0]) {
    metrics.trend = 'short';
  } else if (valuationBasis === 'trading_days' && ends.every(end => tradingPoints.has(end))) {
    const values = ends.map(end => tradingPoints.get(end).value);
    metrics.monthly_returns = values.slice(1).map((value, i) => percent(value - values[i], values[i]));
    metrics.trend = values[1] * values[1] > values[2] * values[0] &&
      values[2] * values[2] > values[3] * values[1] ? 'weak' : 'steady';
  }
  return metrics;
}

function evaluateProduct(product, date, calendar) {
  const { detail, quota } = product;
  const term = detail?.term ?? { kind: 'unknown', days: null };
  const category = CATEGORIES.includes(detail?.category) ? detail.category : 'unknown';
  const returns = product.performance ?? {};
  const monthly = decimal(returns['1m']);
  const yieldGate = monthly === null || !fresh(product.performance_date, date) ? 'pending'
    : monthly < decimal('2.15') ? 'reject' : 'pass';
  const metrics = navMetrics(product.nav, date, calendar, detail?.valuation_basis);
  const amount = quota?.amount ?? null;
  const quotaStatus = quota?.status === 0 || quota?.status === 1 ? quota.status : null;
  const quotaGate = quotaStatus === 0 ? 'pass' : quotaStatus === 1 ? 'reject' : 'pending';
  const reasons = [];
  function reason(gate, outcome, code) { reasons.push({ gate, outcome, code }); }
  reason('yield', yieldGate, yieldGate === 'pending' ? 'yield_unverified' : yieldGate === 'reject' ? 'yield_below' : 'yield_pass');
  if (quota || yieldGate === 'pass') reason('quota', quotaGate, quotaGate === 'pass' ? 'quota_open' : quotaGate === 'reject' ? 'sold_out' : 'quota_unverified');
  if (product.detail_issue) reason('detail', 'pending', product.detail_issue);
  if (detail || (yieldGate === 'pass' && quotaGate === 'pass')) {
    if (term.kind === 'periodic') reason('term', 'reject', 'periodic');
    else if (term.kind === 'rolling') reason('term', 'pending', 'rolling');
    else if (term.kind === 'conflict') reason('term', 'pending', 'term_conflict');
    else if (term.days > 190) reason('term', 'reject', 'term_exceeds');
    else if (Number.isInteger(term.days) && term.days >= 0) reason('term', 'pass', 'term_pass');
    else reason('term', 'hint', 'term_unknown');
    if (category === 'unknown') reason('category', 'hint', 'category_unknown');
  }
  if (product.nav || (yieldGate === 'pass' && quotaGate === 'pass' &&
      !reasons.some(r => r.gate === 'term' && ['reject', 'pending'].includes(r.outcome)))) {
    reason('drawdown', metrics.drawdown.band, metrics.issue ?? `drawdown_${metrics.drawdown.band}`);
  }
  const outcomes = new Set(reasons.map(item => item.outcome));
  const status = outcomes.has('reject') ? 'rejected' : outcomes.has('pending') ? 'pending' : outcomes.has('watch') ? 'watch' : 'eligible';
  const hints = [
    [metrics.zero_dates?.length >= 3, 'frequent_zero'],
    [yieldGate === 'pass' && quotaGate === 'pass' && metrics.zero_dates === null, 'zero_pending'],
    [metrics.trend === 'weak', 'trend_weak'], [metrics.trend === 'short', 'trend_short'],
    [metrics.count >= 2 && ['pending', 'calendar_gap'].includes(metrics.trend), 'trend_pending'],
    [quotaStatus === 0 && amount === null, 'quota_default'],
    [quotaStatus === 0 && quota?.low_amount === true, 'quota_low'],
    [status === 'eligible' && term.days === null, 'term_unknown'],
    [status === 'eligible' && category === 'unknown', 'category_unknown'],
    [detail?.equity_upper_pct > 5, 'equity_review'],
    [metrics.issue === 'calendar_gap' || metrics.trend === 'calendar_gap', 'calendar_gap'],
  ].filter(([show]) => show).map(([, hint]) => hint);
  return {
    channel: product.channel, code: product.code, name: product.name, issuer: product.issuer,
    min_amount: product.min_amount ?? null, restrictions: product.restrictions ?? null,
    performance_date: product.performance_date ?? null, performance: returns,
    yield_1m: monthly === null ? null : Number(returns['1m']),
    yield_gate: yieldGate, term, category,
    quota: { status: quotaStatus, status_new: quota?.status_new ?? null, checked_at: quota?.checked_at ?? null,
      amount, amount_checked_at: quota?.amount_checked_at ?? null, amount_state: quota?.amount_state ?? 'not_checked', assumption: quotaStatus === 0 && amount === null },
    status, reasons, hints, metrics, detail: detail ?? null, shortlisted: false, rank: null,
  };
}

function screen(products, date, calendar) {
  const results = products.map(product => evaluateProduct(product, date, calendar));
  const ranked = results.filter(row => row.status === 'eligible' && row.term.days !== null && row.category !== 'unknown');
  ranked.sort((a, b) => {
    const left = decimal(a.performance['1m']);
    const right = decimal(b.performance['1m']);
    return (left > right ? -1 : left < right ? 1 : 0) || compareKey(a.channel, b.channel) || compareKey(a.code, b.code);
  });
  const groups = new Map();
  for (const row of ranked) {
    const key = `${row.term.days}/${row.category}`;
    row.rank = (groups.get(key) ?? 0) + 1;
    groups.set(key, row.rank);
    row.shortlisted = row.rank <= 3;
  }
  const counts = Object.fromEntries(STATES.map(status => [status, results.filter(row => row.status === status).length]));
  return {
    results, counts: {
      ...counts, total: results.length,
      yield_pass: results.filter(row => row.yield_gate === 'pass').length,
      yield_pending: results.filter(row => row.yield_gate === 'pending').length,
      yield_rejected: results.filter(row => row.yield_gate === 'reject').length,
      quota_open: results.filter(row => row.yield_gate === 'pass' && row.quota.status === 0).length,
      shortlisted: results.filter(row => row.shortlisted).length,
      frequent_zero: results.filter(row => row.status === 'eligible' && row.hints.includes('frequent_zero')).length,
    },
  };
}

module.exports = { RULE_VERSION, CATEGORIES, STATES, HINTS, decimal, fresh, yearStart, navMetrics, evaluateProduct, screen };
