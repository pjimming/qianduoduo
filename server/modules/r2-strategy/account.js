'use strict';

const { bucketForTerm } = require('../../../lib/yield-policy');
const { CONTRACT_HASH, fingerprint, freeze } = require('./contract');
const { isoDate } = require('../r2-screening/calendar');

function moneyCents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100)) ||
      Math.abs(value * 100 - Math.round(value * 100)) > 1e-5) throw new Error('账户金额必须是非负整分');
  return Math.round(value * 100);
}
const legKey = code => `buy:${code}`;

function verifiedArrival(settlement, trade) {
  return settlement?.trade_id === trade.id && settlement.product_code === trade.product_code &&
    settlement.status === 'verified' && settlement.verified === true &&
    isoDate(settlement.arrival_date) &&
    typeof settlement.arrival_verified_at === 'string' &&
    settlement.arrival_verified_at.trim() !== '' &&
    Number.isFinite(Date.parse(settlement.arrival_verified_at));
}

// Convert actual lots, pending trades and accepted intentions into a single
// post-commitment portfolio. This is a read-only projection: no trades, lots or
// reservation balances are modified, and in-transit proceeds remain blocked.
function buildAccountContext({ principal, holdings = [], trades = [], reservations = [], decisions = [],
  assetsByCode = {}, settlementChecks = {}, date }) {
  if (!isoDate(date)) throw new Error('账户业务日无效');
  const principalCents = moneyCents(principal);
  const blockers = [];
  const actual = [];
  const seenLots = new Set(), seenTrades = new Set(), seenReservations = new Set();
  const decisionMap = new Map(decisions.map(row => [row.id, row]));
  function asset(code, termDays) {
    const info = assetsByCode[code];
    if (!info?.product_key || !info.family_key || !info.evidence_tier) blockers.push(`asset_unverified:${code}`);
    return { product_code: code, product_key: info?.product_key ?? `unverified:${code}`,
      family_key: info?.family_key ?? `unverified:${code}`, evidence_tier: info?.evidence_tier ?? 'no_data',
      bucket: info?.bucket ?? bucketForTerm(termDays), liquidity_eligible: info?.liquidity_eligible === true,
      available_on: info?.available_on ?? null, family_basis: info?.family_basis ?? 'unverified',
      classification_basis: info?.classification_basis ?? null };
  }
  for (const lot of holdings) {
    if (!lot.lot_id || seenLots.has(lot.lot_id)) throw new Error('账户持仓批次重复或缺失');
    seenLots.add(lot.lot_id);
    const amount = moneyCents(lot.amount);
    if (amount) actual.push({ key: `lot:${lot.lot_id}`, lot_id: lot.lot_id, amount_cents: amount,
      ...asset(lot.product_code, lot.term_days), source: 'confirmed_holding' });
  }
  const projected = actual.map(row => ({ ...row }));
  const commitments = new Map();
  const pendingTradeIds = [];
  let blockedCash = 0;
  function commitment(key, values) {
    let item = commitments.get(key);
    if (!item) { item = { ...values, pending_cents: 0, reserved_cents: 0, pending_ids: [], reservation_ids: [] }; commitments.set(key, item); }
    if (item.product_code !== values.product_code || item.funding_code !== values.funding_code || item.funding_lot_id !== values.funding_lot_id) {
      blockers.push('commitment_identity_conflict');
    }
    return item;
  }
  for (const trade of trades) {
    if (seenTrades.has(trade.id)) throw new Error('账户交易编号重复');
    seenTrades.add(trade.id);
    if (trade.status === 'cancelled') continue;
    const amount = moneyCents(trade.amount);
    if (trade.status === 'confirmed' && trade.trade_type === 'redeem') {
      const check = settlementChecks[trade.id];
      const matched = verifiedArrival(check, trade);
      if (!matched || check.arrival_date > date) {
        blockedCash += amount;
        if (!matched) blockers.push(`settlement_unverified:${trade.id}`);
      }
    }
    if (trade.status !== 'pending' || !['buy', 'switch'].includes(trade.trade_type)) continue;
    pendingTradeIds.push(trade.id);
    const code = trade.trade_type === 'switch' ? trade.target_product_code : trade.product_code;
    const decision = decisionMap.get(trade.decision_id);
    if (!code || !decision) blockers.push('pending_trade_binding_unverified');
    const sourceCode = trade.trade_type === 'switch' ? trade.product_code : decision?.action === '切换'
      ? decision.review_meta?.expected_legs?.find(leg => leg.side === 'redeem')?.product_code ?? '' : '';
    if (decision?.action === '切换' && !sourceCode) blockers.push('switch_funding_unverified');
    const lot = sourceCode ? decision?.review_meta?.holding_lot_id ?? decision?.review_meta?.execution_snapshot?.lot_id ?? '' : '';
    const key = trade.decision_id ? `${trade.decision_id}/${legKey(code)}` : `trade:${trade.id}`;
    const item = commitment(key, { key, decision_id: trade.decision_id, product_code: code, funding_code: sourceCode,
      funding_lot_id: lot, term_days: trade.trade_type === 'switch' ? trade.target_term_days : trade.term_days });
    item.pending_cents += amount; item.pending_ids.push(trade.id);
  }
  for (const reserve of reservations) {
    if (seenReservations.has(reserve.id)) throw new Error('账户资金预留重复');
    seenReservations.add(reserve.id);
    if (reserve.state !== 'active') continue;
    const amount = reserve.amount_cents - reserve.executed_cents - reserve.released_cents;
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('账户资金预留不守恒');
    const decision = decisionMap.get(reserve.decision_id);
    const legs = decision?.review_meta?.expected_legs ?? [];
    const buy = legs.find(row => row.side === 'buy' && legKey(row.product_code) === reserve.leg_key);
    const redeem = legs.find(row => row.side === 'redeem');
    if (!decision || !buy) { blockers.push('reservation_binding_unverified'); continue; }
    const sourceCode = decision.action === '切换' ? redeem?.product_code ?? '' : '';
    if (decision.action === '切换' && !sourceCode) blockers.push('switch_funding_unverified');
    const lot = sourceCode ? decision.review_meta?.holding_lot_id ?? decision.review_meta?.execution_snapshot?.lot_id ?? '' : '';
    const key = `${reserve.decision_id}/${reserve.leg_key}`;
    const item = commitment(key, { key, decision_id: reserve.decision_id, product_code: buy.product_code,
      funding_code: sourceCode, funding_lot_id: lot, term_days: buy.term_days ?? null });
    item.reserved_cents += amount; item.reservation_ids.push(reserve.id);
    // A completed trade must have reconciled its reservation in the same
    // write use case. The reader refuses to double-count a stale balance.
    const executed = trades.filter(trade => trade.status === 'confirmed' && trade.decision_id === reserve.decision_id &&
      ((trade.trade_type === 'buy' && trade.product_code === buy.product_code) ||
       (trade.trade_type === 'switch' && trade.target_product_code === buy.product_code)))
      .reduce((sum, trade) => sum + moneyCents(trade.amount), 0);
    if (executed !== reserve.executed_cents) blockers.push('reservation_reconciliation_needed');
  }
  const reconciled = [];
  for (const item of [...commitments.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    // Pending screenshots and accepted reservations are two representations
    // of the same not-yet-confirmed money. Count the greater amount once.
    const amount = Math.max(item.pending_cents, item.reserved_cents);
    let fundingRemaining = amount;
    let transferred = 0;
    if (item.funding_code) {
      const lots = projected.filter(row => row.product_code === item.funding_code && (!item.funding_lot_id || row.lot_id === item.funding_lot_id));
      for (const lot of lots) {
        const take = Math.min(lot.amount_cents, fundingRemaining);
        lot.amount_cents -= take; fundingRemaining -= take; transferred += take;
      }
      // If a split switch has already redeemed its source, only verified
      // arrived principal linked to the SAME decision may fund the remainder.
      const arrived = trades.filter(trade => trade.status === 'confirmed' && trade.trade_type === 'redeem' &&
        trade.decision_id === item.decision_id && trade.product_code === item.funding_code &&
        verifiedArrival(settlementChecks[trade.id], trade) &&
        settlementChecks[trade.id].arrival_date <= date)
        .reduce((total, trade) => total + moneyCents(trade.amount), 0);
      const alreadyBought = trades.filter(trade => trade.status === 'confirmed' && trade.trade_type === 'buy' &&
        trade.decision_id === item.decision_id && trade.product_code === item.product_code)
        .reduce((total, trade) => total + moneyCents(trade.amount), 0);
      if (fundingRemaining > Math.max(0, arrived - alreadyBought)) blockers.push('switch_funding_unavailable');
    }
    projected.push({ key: `commitment:${item.key}`, amount_cents: amount, ...asset(item.product_code, item.term_days),
      source: item.funding_code ? 'switch_commitment' : 'buy_commitment', decision_id: item.decision_id,
      pending_trade_ids: item.pending_ids, reservation_ids: item.reservation_ids });
    reconciled.push({ key: item.key, amount_cents: amount, pending_cents: item.pending_cents,
      reserved_cents: item.reserved_cents, transferred_from_holding_cents: transferred });
  }
  const exposures = projected.filter(row => row.amount_cents > 0);
  const committed = exposures.reduce((total, row) => total + row.amount_cents, 0);
  if (!Number.isSafeInteger(committed + blockedCash) || committed + blockedCash > principalCents) blockers.push('account_overcommitted');
  const result = { date, contract_hash: CONTRACT_HASH, principal_cents: principalCents, exposures,
    blocked_cash_cents: blockedCash, committed_cents: committed, available_cents: Math.max(0, principalCents - committed - blockedCash),
    actual_holdings: actual, commitments: reconciled, pending_trade_ids: pendingTradeIds,
    blockers: [...new Set(blockers)], verified: blockers.length === 0 };
  return freeze({ ...result, fingerprint: fingerprint(result) });
}

module.exports = { moneyCents, legKey, buildAccountContext };
