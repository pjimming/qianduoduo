'use strict';

const { CONTRACT, CONTRACT_HASH, fingerprint, freeze } = require('./contract');
const { adaptSnapshot, identityKey } = require('./evidence');
const { fresh } = require('../r2-screening/policy');

function monitorContent(batch) {
  return { scope: batch.scope, business_date: batch.business_date, collector_version: batch.collector_version,
    items: batch.items.map(row => ({ identity: row.identity, data: row.data, nav_hash: row.nav_hash,
      issues: row.issues, evidence: row.evidence.map(proof => ({ kind: proof.kind, hash: proof.hash, url: proof.url, summary: proof.summary })) })) };
}

// Only these codes explain why a holding's own yield evidence is not usable.
// Screening/candidate codes (yield_below, quota_not_open, ...) are noise here.
const EVIDENCE_ISSUE_CODES = new Set(['share_identity_conflict', 'scope_unverified', 'yield_unverified',
  'nav_stale', 'nav_hash_missing']);

// Returns a separate holding-only view. Do NOT feed this view into allocation:
// both the context and every row are explicitly ineligible for new purchases.
function combineHoldingEvidence({ context, supplements = [], date }) {
  if (!context || context.date !== date || context.contract_hash !== CONTRACT_HASH || !Array.isArray(context.rows) || !Array.isArray(supplements)) {
    throw new Error('需先按当前业务日冻结公开上下文，再合并监控证据');
  }
  const rows = new Map(context.rows.map(row => [identityKey(row.identity), { ...structuredClone(row), automatic_eligible: false,
    monitoring_verified: false, monitoring_issues: [], published_run_id: row.run_id }]));
  const hashes = [], issues = [];
  for (const batch of supplements) {
    let valid;
    try { valid = batch.scope === 'holding_monitor' && batch.business_date === date && batch.collector_version === 'cmb-public-v1' &&
      Array.isArray(batch.items) && batch.items.length <= 128 && fingerprint(monitorContent(batch)) === batch.content_hash; }
    catch { valid = false; }
    if (!valid) { issues.push('monitor_batch_unverified'); continue; }
    hashes.push(batch.content_hash);
    // The monitor batch is a set of identities, not a screening pool. Pin a
    // complete virtual pool so adaptSnapshot's pool guard reflects this batch
    // instead of the unrelated public screening pool shape.
    const adapted = adaptSnapshot({ run: { id: null, business_date: date, created_at: batch.captured_at,
      status: 'degraded', rule_version: CONTRACT.selection_policy_version,
      counts: { total: batch.items.length },
      health: { ...(batch.health ?? {}), pool: { requested: 1, ok: 1, included: batch.items.length } } },
    rows: batch.items.map(row => ({ ...row.identity, data: row.data, nav_hash: row.nav_hash })),
    evidence: batch.items.flatMap(row => row.evidence.map(proof => ({ ...row.identity, ...proof }))) }, date);
    for (let index = 0; index < adapted.rows.length; index++) {
      const incoming = adapted.rows[index], raw = batch.items[index], key = identityKey(incoming.identity);
      const prior = rows.get(key);
      const identityFailure = raw.issues.some(code => /identity|pool_scope/.test(code)) || incoming.blockers.some(code =>
        ['share_identity_conflict'].includes(code));
      const usable = !identityFailure && incoming.mapping && incoming.holding_yield_state !== 'pending' && fresh(incoming.performance_date, date);
      const newer = !prior?.performance_date || incoming.performance_date >= prior.performance_date;
      const replacePerformance = usable && newer;
      // A failed/older fetch cannot renew an old performance date. Keep recent
      // known evidence for display while exposing the attempted source failure.
      const base = replacePerformance || !prior ? structuredClone(incoming) : structuredClone(prior);
      if (prior && incoming.mapping && !identityFailure) {
        if (incoming.detail) { base.detail = incoming.detail; base.term = incoming.term; base.category = incoming.category;
          base.registration = incoming.registration; }
        if (incoming.nav_fresh && incoming.nav_hash) { base.metrics = incoming.metrics; base.nav_hash = incoming.nav_hash; base.nav_fresh = true; }
      }
      if (identityFailure || !fresh(base.performance_date, date)) base.holding_yield_state = 'pending';
      base.nav_fresh = Boolean(fresh(base.metrics?.latest, date) && fresh(base.metrics?.end, date));
      base.rank = prior?.rank ?? null;
      base.shortlisted = prior?.shortlisted ?? false;
      base.screening_status = prior?.screening_status ?? 'monitor_only';
      base.quota = prior?.quota ?? incoming.quota;
      base.automatic_eligible = false;
      base.monitoring_verified = Boolean(replacePerformance);
      base.monitoring_issues = [...new Set([...raw.issues,
        ...incoming.blockers.filter(code => EVIDENCE_ISSUE_CODES.has(code))])];
      base.monitor_content_hash = batch.content_hash;
      base.monitor_captured_at = batch.captured_at;
      base.monitor_evidence = raw.evidence;
      base.published_run_id = prior?.published_run_id ?? prior?.run_id ?? null;
      base.run_id = prior?.run_id ?? null;
      base.evidence_hash = fingerprint({ ...base, evidence_hash: undefined });
      rows.set(key, base);
    }
  }
  const body = { ...structuredClone(context), scope: 'holding_monitor', available: false,
    published_fingerprint: context.fingerprint, monitor_content_hashes: [...new Set(hashes)].sort(),
    monitoring_issues: [...new Set(issues)], rows: [...rows.values()] };
  return freeze({ ...body, fingerprint: fingerprint({ ...body, fingerprint: undefined }) });
}

module.exports = { monitorContent, combineHoldingEvidence };
