'use strict';

const { CONTRACT } = require('./contract');
const { decimal, fresh } = require('../r2-screening/policy');
const { daysBetween } = require('../r2-screening/calendar');

// All three conditions use verified evidence for this share. Missing evidence
// is never a zero return; one known false condition rules out the conjunction.
function holdingExitConditions(current, yieldState, date) {
  const policy = CONTRACT.exit_policy;
  const verified = current && yieldState !== 'pending' && fresh(current.performance_date, date) &&
    current.monitoring_verified !== false;
  const windows = Object.fromEntries(policy.declining_windows.map(key => [key, current?.performance?.[key] ?? null]));
  const monthly = verified ? decimal(windows['1m']) : null;
  const monthlyCheck = monthly === null ? 'pending' : monthly < decimal(policy.monthly_yield_threshold_pct) ? 'met' : 'not_met';
  const values = policy.declining_windows.map(key => decimal(windows[key]));
  const trendVerified = verified && current.holding_exit_performance_verified === true && values.every(value => value !== null);
  const trendCheck = !trendVerified ? 'pending' : values[0] > values[1] && values[1] > values[2] ? 'met' : 'not_met';
  const recent = current?.metrics?.observation?.recent;
  const recentVerified = verified && current.nav_fresh === true && recent?.status === 'available' &&
    current.metrics.observation.basis === 'cumulative_change_over_start_unit' &&
    recent.days === policy.recent_days && daysBetween(recent.start_date, recent.end_date) === policy.recent_days &&
    fresh(recent.end_date, date) && typeof recent.return_pct === 'number' && Number.isFinite(recent.return_pct);
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
