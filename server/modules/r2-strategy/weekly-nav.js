'use strict';

const { openPublicBrowser } = require('../r2-screening/product-list');
const { createCfClient, readNav, publicDetail } = require('../r2-screening/source');
const { decimal, fresh } = require('../r2-screening/policy');
const { shift, valuationCalendar } = require('../r2-screening/calendar');
const { CONTRACT } = require('./contract');

function checkWeek(points, date, threshold, calendar = valuationCalendar, maxDataAgeDays = CONTRACT.max_data_age_days) {
  const byDate = new Map();
  const conflicts = new Set();
  for (const point of points) {
    if (point.date > date) continue;
    const prior = byDate.get(point.date);
    if (prior && (decimal(prior.unit) !== decimal(point.unit) ||
      decimal(prior.cumulative) !== decimal(point.cumulative))) conflicts.add(point.date);
    if (!prior) byDate.set(point.date, point);
  }

  const endDate = [...byDate.keys()].sort().at(-1);
  if (!endDate || !fresh(endDate, date, maxDataAgeDays)) return { status: 'pending', reason: 'nav_stale_or_unavailable', end_date: endDate ?? null };
  const startDate = shift(endDate, -7);
  const range = { start_date: startDate, end_date: endDate };
  if (!byDate.has(startDate)) return { ...range, status: 'pending', reason: 'start_nav_missing' };

  let days = 0;
  for (let day = startDate; day <= endDate; day = shift(day, 1)) {
    const open = calendar.isOpen(day);
    const point = byDate.get(day);
    if (open === null) return { ...range, status: 'pending', reason: 'calendar_gap' };
    if (conflicts.has(day)) return { ...range, status: 'pending', reason: 'nav_conflict', affected_date: day };
    if (open && !point) return { ...range, status: 'pending', reason: 'nav_gap', affected_date: day };
    if (point && decimal(point.cumulative, true) === null) {
      return { ...range, status: 'pending', reason: 'cumulative_unavailable', affected_date: day };
    }
    if (point) days++;
  }

  const start = byDate.get(startDate);
  const end = byDate.get(endDate);
  const unit = decimal(start.unit, true);
  if (unit === null) return { ...range, status: 'pending', reason: 'unit_nav_invalid' };
  const delta = decimal(end.cumulative, true) - decimal(start.cumulative, true);
  const returnPct = Number(delta) / Number(unit) * 100;
  return {
    ...range, status: 'calculated', start_unit: start.unit, start_cumulative: start.cumulative,
    end_cumulative: end.cumulative, disclosed_dates: days, return_pct: returnPct,
    below_threshold: delta * decimal('100') < unit * decimal(threshold.toFixed(8)),
  };
}

function pendingShares(workspace, date) {
  const rows = workspace.result?.monitoring?.rows;
  if (workspace.mode !== 'v9' || workspace.stale || !workspace.contract_matches ||
    date !== workspace.business_date || !Array.isArray(rows)) return null;

  const targets = new Map();
  for (const row of rows) {
    const checks = row.exit_conditions?.checks;
    if (checks?.recent_return !== 'pending') continue;
    const target = targets.get(row.product_code) ?? {
      code: row.product_code, identities: new Map(), redeemable_now: false, other_conditions_met: false,
      platform_reason: row.observation?.metrics?.recent?.reason ?? 'exit_week_evidence_pending',
    };
    target.redeemable_now ||= row.redemption?.redeemable_now === true;
    target.other_conditions_met ||= checks.monthly_yield === 'met' && checks.declining_windows === 'met';
    targets.set(row.product_code, target);
  }
  for (const row of rows) {
    const target = targets.get(row.product_code);
    if (target && row.identity?.source === 'cmb' && row.identity.code === row.product_code &&
      /^[a-zA-Z0-9_-]{1,40}$/.test(row.identity.channel) && /^[a-zA-Z0-9_-]{1,80}$/.test(row.identity.code)) {
      target.identities.set(row.identity.channel, row.identity);
    }
  }
  return [...targets.values()].sort((a, b) =>
    Number(b.other_conditions_met) - Number(a.other_conditions_met) ||
    Number(b.redeemable_now) - Number(a.redeemable_now) || a.code.localeCompare(b.code));
}

async function collectWeeklyNav(pending, date, threshold, source = {}) {
  if (pending === null) return { date, status: 'skipped', reason: 'workspace_not_current', products: [] };
  const products = [];
  const comparable = pending.filter(target => target.identities.size === 1);
  const context = ({ code, redeemable_now, other_conditions_met, platform_reason }) =>
    ({ code, redeemable_now, other_conditions_met, platform_reason, platform_recent_check: 'pending' });
  for (const target of pending.filter(item => item.identities.size !== 1)) {
    products.push({ ...context(target), status: 'pending', reason: 'same_cmb_share_unverified' });
  }
  const signal = AbortSignal.timeout(45000);
  let browser;
  let cf;
  let sourceError;
  try {
    if (comparable.length) {
      browser = await (source.openBrowser ?? openPublicBrowser)(signal);
      cf = await (source.createClient ?? createCfClient)(browser.context, signal, {});
    }
  } catch (error) {
    sourceError = error.code || 'public_source_unavailable';
  }
  try {
    for (const target of comparable) {
      const share = target.identities.values().next().value;
      const base = { ...context(target), channel: share.channel, source_url: publicDetail(share, 'prodvalue') };
      try {
        if (!cf || signal.aborted) {
          products.push({ ...base, status: 'pending', reason: sourceError || 'public_source_timeout' });
          continue;
        }
        const { points } = await (source.readNav ?? readNav)(cf, share, signal);
        products.push({ ...base, ...checkWeek(points, date, threshold, valuationCalendar, source.maxDataAgeDays) });
      } catch (error) {
        products.push({ ...base, status: 'pending', reason: error.code || 'public_source_unavailable' });
      }
    }
  } finally {
    await browser?.close();
  }
  return { date, status: 'checked', threshold_pct: threshold, products };
}

// This cache serves the holdings display only. It never becomes a strategy input.
function createWeeklyNavReader({ collect = collectWeeklyNav, now = Date.now } = {}) {
  let cache;
  return function readWeeklyNav(workspace) {
    const date = workspace.business_date;
    const threshold = Number(workspace.effective_contract?.exit_policy?.recent_return_threshold_pct ??
      workspace.contract?.exit_policy?.recent_return_threshold_pct ?? CONTRACT.exit_policy.recent_return_threshold_pct);
    const maxDataAgeDays = workspace.effective_contract?.max_data_age_days ?? CONTRACT.max_data_age_days;
    const targets = pendingShares(workspace, date);
    if (!targets?.length) return collect(targets, date, threshold, { maxDataAgeDays });
    const key = JSON.stringify([date, threshold, maxDataAgeDays, targets.map(target => ({ ...target, identities: [...target.identities.keys()].sort() }))]);
    if (cache?.key === key && cache.expires > now()) return cache.promise;
    const entry = { key, expires: Infinity };
    entry.promise = collect(targets, date, threshold, { maxDataAgeDays }).then(result => {
      entry.expires = now() + (result.products.some(product => product.status === 'pending') ? 30_000 : 300_000);
      return result;
    }, error => {
      entry.expires = 0;
      throw error;
    });
    cache = entry;
    return entry.promise;
  };
}

module.exports = { checkWeek, pendingShares, collectWeeklyNav, createWeeklyNavReader };
