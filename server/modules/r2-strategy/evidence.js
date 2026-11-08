'use strict';

const { CONTRACT, CONTRACT_HASH, fingerprint, freeze } = require('./contract');
const { decimal, fresh } = require('../r2-screening/policy');
const { isoDate } = require('../r2-screening/calendar');
const { calculateReferenceYield } = require('../../../lib/yield-policy');

const identityKey = ({ source, channel, code }) => JSON.stringify([source, channel, code]);
const numeric = value => value === null || value === undefined || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value);

function adaptSnapshot(snapshot, date, mappings = []) {
  if (!isoDate(date)) throw new Error('策略业务日必须为有效日期');
  if (!snapshot) return freeze({ date, available: false, blockers: ['no_published_batch'], rows: [], fingerprint: null });
  const { run } = snapshot;
  const blockers = [];
  if (!['succeeded', 'degraded'].includes(run.status) || run.rule_version !== CONTRACT.selection_policy_version) blockers.push('batch_version_or_status');
  const pool = run.health?.pool;
  if (!pool || pool.requested < 1 || pool.ok !== pool.requested ||
      (pool.included !== undefined && pool.included !== snapshot.rows.length) ||
      run.counts?.total !== snapshot.rows.length) blockers.push('pool_incomplete');
  if (new Set(snapshot.rows.map(identityKey)).size !== snapshot.rows.length) blockers.push('duplicate_identity');
  if (run.error_code || !isoDate(run.business_date) || run.business_date > date) blockers.push('batch_invalid');
  if (run.health?.calendar_gap || run.health?.identity_error) blockers.push('source_identity_or_calendar');
  const proofs = new Map();
  for (const proof of snapshot.evidence) {
    const key = identityKey(proof);
    const list = proofs.get(key) ?? [];
    list.push(proof);
    proofs.set(key, list);
  }
  const active = mappings.filter(row => !row.revoked_at);
  const rows = snapshot.rows.map(row => {
    const data = structuredClone(row.data);
    const identity = { source: row.source, channel: row.channel, code: row.code };
    const evidence = structuredClone(proofs.get(identityKey(row)) ?? []);
    const performance = evidence.find(item => item.kind === 'performance')?.summary;
    const mapped = active.filter(item => item.source === row.source && item.channel === row.channel && item.sales_code === row.code);
    const mapping = mapped.length === 1 ? mapped[0] : null;
    const mappingValid = mapping && active.filter(item => item.product_code === mapping.product_code).length === 1 &&
      (!mapping.registration_code || !data.detail?.registration || mapping.registration_code === data.detail.registration);
    const monthly = decimal(data.performance?.['1m']);
    const performanceVerified = performance && ['R2', 'PR2'].includes(performance.risk) && performance.currency === 'CNY' &&
      performance.public_offering === true && performance.performance_date === data.performance_date && monthly !== null &&
      decimal(performance.performance?.['1m']) === monthly;
    const yieldState = monthly === null || !fresh(data.performance_date, date) ? 'pending'
      : monthly < decimal(CONTRACT.min_monthly_yield) ? 'below' : 'pass';
    const navFresh = fresh(data.metrics?.latest, date) && fresh(data.metrics?.end, date);
    const reasons = [];
    if (!mappingValid) reasons.push(mapping ? 'mapping_conflict' : mapped.length ? 'mapping_ambiguous' : 'mapping_missing');
    if (data.channel !== row.channel || data.code !== row.code) reasons.push('share_identity_conflict');
    if (!performanceVerified) reasons.push('scope_unverified');
    if (mapping?.registration_code && !data.detail?.registration) reasons.push('registration_unverified');
    if (yieldState !== 'pass') reasons.push(yieldState === 'below' ? 'yield_below' : 'yield_unverified');
    if (!navFresh) reasons.push('nav_stale');
    if (!/^[a-f0-9]{64}$/.test(row.nav_hash ?? '')) reasons.push('nav_hash_missing');
    if (data.status !== 'eligible') reasons.push(`screening_${data.status}`);
    if (data.metrics?.issue === 'calendar_gap') reasons.push('calendar_gap');
    if (!['bond', 'deposit', 'enhanced'].includes(data.category)) reasons.push('category_unverified');
    if (!Number.isInteger(data.term?.days) || data.term.days <= 0 || data.term.days > CONTRACT.max_term_days ||
        !['minimum', 'closed'].includes(data.term.kind)) reasons.push('term_not_automatic');
    if (data.quota?.status !== 0) reasons.push('quota_not_open');
    const returns = Object.fromEntries(['1m', '3m', '6m', '1y'].map(window => [`return_${window}`, numeric(data.performance?.[window])]));
    const reference = calculateReferenceYield({ ...returns, term_days: data.term?.days });
    const tier = returns.return_1y !== null && returns.return_6m !== null && returns.return_3m !== null ? 'full_1y'
      : returns.return_6m !== null && returns.return_3m !== null ? 'six_month' : returns.return_3m !== null ? 'three_month'
        : returns.return_1m !== null ? 'one_month' : 'no_data';
    if (['one_month', 'no_data'].includes(tier)) reasons.push('history_not_automatic');
    if (reference.status !== 'available') reasons.push('reference_unavailable');
    const quota = structuredClone(data.quota ?? {});
    // The bank's amount is display text. Parsing and order increments belong to
    // the allocation adapter; a blank value is explicitly a policy assumption.
    quota.policy_assumption = quota.status === 0 && quota.amount === null ? CONTRACT.blank_quota_assumption : null;
    const body = { identity, mapping: mappingValid ? structuredClone(mapping) : null, run_id: run.id,
      name: data.name ?? row.code, issuer: data.issuer ?? '', detail: data.detail ?? null,
      registration: data.detail?.registration ?? null, group: `${data.term?.days}/${data.category}`, rank: data.rank,
      shortlisted: data.shortlisted, screening_status: data.status, performance: data.performance,
      performance_date: data.performance_date, yield_state: yieldState, nav_fresh: navFresh,
      metrics: data.metrics, nav_hash: row.nav_hash, term: data.term, category: data.category,
      quota, min_amount: data.min_amount, restrictions: data.restrictions,
      evidence_tier: tier, reference, evidence, hints: data.hints, blockers: reasons,
      automatic_eligible: blockers.length === 0 && reasons.length === 0,
      // Sale availability and shortlist rank are deliberately absent here.
      holding_yield_state: mappingValid && data.channel === row.channel && data.code === row.code && performanceVerified
        ? yieldState : 'pending' };
    return { ...body, evidence_hash: fingerprint(body) };
  });
  const body = { date, contract_hash: CONTRACT_HASH, run: structuredClone(run), blockers, rows,
    available: blockers.length === 0 };
  return freeze({ ...body, fingerprint: fingerprint(body) });
}

function createStrategyEvidenceAdapter({ screeningRepository }) {
  return { read(date, mappings = []) {
    try { return adaptSnapshot(screeningRepository?.readExecutionSnapshot() ?? null, date, mappings); }
    catch { return freeze({ date, available: false, blockers: ['screening_unavailable'], rows: [], fingerprint: null }); }
  } };
}

module.exports = { identityKey, adaptSnapshot, createStrategyEvidenceAdapter };
