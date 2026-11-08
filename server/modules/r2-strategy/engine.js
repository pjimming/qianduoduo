'use strict';

const { CONTRACT, CONTRACT_HASH, fingerprint, freeze } = require('./contract');
const { adaptSnapshot, identityKey } = require('./evidence');
const { reviewPretrade } = require('./pretrade');
const { buildAccountContext } = require('./account');
const { allocateV9 } = require('./allocation');
const { buildHoldingMonitoring } = require('./holdings');
const { bucketForTerm } = require('../../../lib/yield-policy');
const { buildBuyForecast } = require('./forecast');
const { combineHoldingEvidence } = require('./holding-evidence');

// One entry point for HTTP, scheduled worker and CLI. It accepts frozen inputs
// only; it cannot open a database, refresh a source or submit a business write.
function evaluateStrategy({ state, sourceSnapshot, holdingSupplements = [], mappings = [], checks = [], portfolio, date, settings = {} }, options = {}) {
  const evidence = adaptSnapshot(sourceSnapshot, date, mappings);
  const activeMappings = new Set(mappings.filter(row => !row.revoked_at).map(row => row.id));
  const latest = new Map();
  for (const row of checks) {
    if (!activeMappings.has(row.mapping_id)) continue;
    const key = JSON.stringify([row.mapping_id, row.lot_id]);
    const prior = latest.get(key);
    if (!prior || row.version > prior.version) latest.set(key, row);
  }
  const limits = {}, reviews = [], assetsByCode = {};
  for (const row of evidence.rows) {
    if (!row.mapping) continue;
    const check = latest.get(JSON.stringify([row.mapping.id, '']));
    const review = reviewPretrade({ row, check, date });
    reviews.push({ identity: row.identity, ...review });
    if (review.limits) {
      limits[identityKey(row.identity)] = review.limits;
      assetsByCode[row.mapping.product_code] = { ...review.limits, evidence_tier: row.evidence_tier,
        bucket: bucketForTerm(row.term?.days) };
    }
  }
  const settlementChecks = {};
  for (const row of latest.values()) {
    if (row.facts?.kind !== 'trade_settlement' || row.facts.status !== 'verified') continue;
    const fact = row.facts;
    const mapping = mappings.find(item => item.id === row.mapping_id);
    if (row.lot_id !== `trade:${fact.trade_id}` || fact.product_code !== mapping?.product_code) continue;
    settlementChecks[fact.trade_id] = { ...fact, verified: true, evidence_hash: row.evidence_hash };
  }
  const account = buildAccountContext({ ...portfolio, reservations: portfolio.reservations ?? [], date, assetsByCode, settlementChecks });
  const allocation = allocateV9({ context: evidence, account, limits, settings }, options);
  const monitoringEvidence = holdingSupplements.length
    ? combineHoldingEvidence({ context: evidence, supplements: holdingSupplements, mappings, date }) : evidence;
  const monitoring = buildHoldingMonitoring({ holdings: portfolio.holdings ?? [], context: monitoringEvidence, checks: [...latest.values()], date });
  const selected = allocation.rows.filter(row => row.amount_cents > 0);
  const selectedReviews = selected.map(row => {
    const current = evidence.rows.find(item => identityKey(item.identity) === identityKey(row.identity));
    const check = latest.get(JSON.stringify([current.mapping.id, '']));
    return { identity: row.identity, amount_cents: row.amount_cents, ...reviewPretrade({ row: current, check, date, amountCents: row.amount_cents }),
      forecast: buildBuyForecast({ row: current, check, date, amountCents: row.amount_cents }) };
  });
  const active = state?.schema_version === 1 && state?.contract_hash === CONTRACT_HASH && state?.mode === 'v9';
  const mayPropose = active && allocation.full_investment && selected.length > 0 && selectedReviews.every(row => row.executable && row.forecast.status === 'available');
  const input = { payload_version: CONTRACT.payload_version, contract_hash: CONTRACT_HASH, business_date: date,
    activation_seq: state?.activation_seq ?? 0, mode: state?.mode ?? 'legacy',
    source_fingerprint: evidence.fingerprint, monitoring_fingerprint: monitoringEvidence.fingerprint, account_fingerprint: account.fingerprint,
    checks_fingerprint: fingerprint([...latest.values()].sort((a, b) => a.id - b.id)), settings_fingerprint: fingerprint(settings) };
  return freeze({ input, input_fingerprint: fingerprint(input), evidence, monitoringEvidence, account, allocation, monitoring,
    pretrade_reviews: reviews, selected_reviews: selectedReviews, may_generate_buy_proposals: mayPropose,
    // Mandatory-yield exits are independent of full-investment feasibility or
    // replacement availability. The actual write use case still revalidates.
    exit_intents: active ? monitoring.rows.filter(row => row.yield_state === 'below').map(row => ({ lot_id: row.lot_id,
      action: row.action, planned_action: row.planned_action, state: row.state, fingerprint: row.fingerprint })) : [] });
}

function compactStrategyResult(result) {
  const allocation = result.allocation;
  const excludedCounts = {};
  for (const row of allocation.excluded) for (const reason of row.reasons ?? []) excludedCounts[reason] = (excludedCounts[reason] ?? 0) + 1;
  const value = { input: result.input, input_fingerprint: result.input_fingerprint,
    may_generate_buy_proposals: result.may_generate_buy_proposals,
    allocation: { status: allocation.status, principal_cents: allocation.principal_cents,
      committed_cents: allocation.committed_cents, available_cents: allocation.available_cents,
      blocked_cash_cents: allocation.blocked_cash_cents, allocated_cents: allocation.allocated_cents,
      unallocated_cents: allocation.unallocated_cents, full_investment: allocation.full_investment,
      blockers: allocation.blockers, fingerprint: allocation.fingerprint,
      rows: allocation.rows.filter(row => row.amount_cents > 0).map(row => ({ identity: row.identity,
        rank: row.rank, group: row.group, amount_cents: row.amount_cents, evidence_hash: row.evidence_hash, reason: row.reason })),
      excluded_reason_counts: excludedCounts },
    monitoring: { counts: result.monitoring.counts,
      rows: result.monitoring.rows.map(row => ({ lot_id: row.lot_id, product_code: row.product_code,
        identity: row.identity, summary: row.summary, redemption: row.redemption,
        state: row.state, action: row.action, planned_action: row.planned_action, yield_1m: row.yield_1m,
        performance_date: row.performance_date, next_verify_date: row.next_verify_date,
        requires_user_action: row.requires_user_action, message_key: row.message_key, fingerprint: row.fingerprint })) },
    selected_reviews: result.selected_reviews.map(row => ({ identity: row.identity, check_id: row.check_id,
      mapping_id: row.mapping_id, amount_cents: row.amount_cents, executable: row.executable,
      blockers: row.blockers, fingerprint: row.fingerprint, forecast_status: row.forecast.status,
      forecast_reason: row.forecast.reason, expected_net_pnl_cents: row.forecast.expected_net_pnl_cents ?? null,
      expected_net_annualized_pct: row.forecast.expected_net_annualized_pct ?? null })) };
  // Preserve no undocumented truncation. Large accounts are explicitly pending
  // a paginated artifact design instead of silently losing actionable lots.
  if (Buffer.byteLength(JSON.stringify(value)) > CONTRACT.max_snapshot_bytes) throw new Error('派生摘要超过持久化上限，需分页后重算');
  return freeze(value);
}

module.exports = { evaluateStrategy, compactStrategyResult };
