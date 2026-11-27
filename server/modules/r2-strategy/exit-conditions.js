'use strict';

const { DEFAULT_POLICY } = require('./policy-settings');
const { decimal, fresh } = require('../r2-screening/policy');
const { daysBetween } = require('../r2-screening/calendar');

// All three conditions use verified evidence for this share. Missing evidence
// is never a zero return; one known false condition rules out the conjunction.
function holdingExitConditions(current, yieldState, date, settings = DEFAULT_POLICY) {
  const policy = settings.exit;
  const maxAge = settings.screening.max_data_age_days;
  const windowsToCompare = ['6m', '3m', '1m'];
  const recentDays = 7;
  const verified = current && yieldState !== 'pending' && fresh(current.performance_date, date, maxAge) &&
    current.monitoring_verified !== false;
  const windows = Object.fromEntries(windowsToCompare.map(key => [key, current?.performance?.[key] ?? null]));
  const monthly = verified ? decimal(windows['1m']) : null;
  const monthlyCheck = monthly === null ? 'pending' : monthly < decimal(String(policy.monthly_yield_threshold_pct)) ? 'met' : 'not_met';
  const values = windowsToCompare.map(key => decimal(windows[key]));
  const trendVerified = verified && current.holding_exit_performance_verified === true && values.every(value => value !== null);
  const trendCheck = !trendVerified ? 'pending' : values[0] > values[1] && values[1] > values[2] ? 'met' : 'not_met';
  const recent = current?.metrics?.observation?.recent;
  const recentVerified = verified && current.nav_fresh === true && recent?.status === 'available' &&
    current.metrics.observation.basis === 'cumulative_change_over_start_unit' &&
    recent.days === recentDays && daysBetween(recent.start_date, recent.end_date) === recentDays &&
    fresh(recent.end_date, date, maxAge) && typeof recent.return_pct === 'number' && Number.isFinite(recent.return_pct);
  const recentCheck = !recentVerified ? 'pending' : recent.return_pct < Number(policy.recent_return_threshold_pct) ? 'met' : 'not_met';
  const checks = { recent_return: recentCheck, monthly_yield: monthlyCheck, declining_windows: trendCheck };
  const status = Object.values(checks).every(value => value === 'met') ? 'met'
    : Object.values(checks).includes('not_met') ? 'not_met' : 'pending';
  return { version: 1, operator: 'all', status, checks, performance_date: current?.performance_date ?? null,
    recent_return_threshold_pct: Number(policy.recent_return_threshold_pct),
    monthly_yield_threshold_pct: Number(policy.monthly_yield_threshold_pct), performance: windows,
    recent: recentVerified ? { start_date: recent.start_date, end_date: recent.end_date, days: recent.days, return_pct: recent.return_pct } : null };
}

module.exports = { holdingExitConditions };
