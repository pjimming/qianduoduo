'use strict';

const { isoDate } = require('../server/modules/r2-screening/calendar');

function cents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
      !Number.isSafeInteger(Math.round(value * 100)) ||
      Math.abs(value * 100 - Math.round(value * 100)) > 1e-5) {
    throw new Error('资金金额必须是非负整分');
  }
  return Math.round(value * 100);
}

function verifiedArrival(check, trade) {
  return check?.trade_id === trade.id && check.product_code === trade.product_code &&
    check.status === 'verified' && check.verified === true && isoDate(check.arrival_date) &&
    typeof check.arrival_verified_at === 'string' && check.arrival_verified_at.trim() !== '' &&
    Number.isFinite(Date.parse(check.arrival_verified_at));
}

function tradeSettlementChecks(trades) {
  return Object.fromEntries(trades.filter(trade => trade.status === 'confirmed' &&
    trade.trade_type === 'redeem').map(trade => [trade.id, {
    trade_id: trade.id, product_code: trade.product_code, status: 'verified', verified: true,
    arrival_date: trade.arrival_date, arrival_verified_at: trade.arrival_verified_at,
  }]));
}

// A read-only cash bridge. Realized P&L comes from settlement minus redeemed
// cost, never from daily income (which would count the same earnings twice).
function buildCapitalFunding({ principal, holdings = [], trades = [], date, initialDate = null,
  settlementChecks = tradeSettlementChecks(trades) }) {
  if (!isoDate(date)) throw new Error('资金业务日无效');
  const net = cents(principal);
  let realized = 0, blocked = 0, unverified = 0;
  const seen = new Set();
  const sources = [];
  for (const trade of trades) {
    if (trade.status !== 'confirmed' || trade.trade_type !== 'redeem') continue;
    if (seen.has(trade.id)) throw new Error('资金来源交易重复');
    seen.add(trade.id);
    if (trade.confirm_date > date || (initialDate && trade.confirm_date < initialDate)) continue;
    const cost = cents(trade.amount);
    const check = settlementChecks[trade.id];
    if (!verifiedArrival(check, trade) || check.arrival_date > date) {
      blocked += cost;
      unverified++;
      continue;
    }
    if (trade.settlement_amount === null || trade.settlement_amount === undefined) {
      // Old records without settlement amounts supply no additional earnings.
      unverified++;
      continue;
    }
    const pnl = cents(trade.settlement_amount) - cost;
    realized += pnl;
    sources.push({ trade_id: trade.id, arrival_date: check.arrival_date, realized_pnl_cents: pnl });
  }
  const cost = holdings.reduce((total, row) => total + cents(row.amount), 0);
  const capacity = net + realized;
  if (![capacity, cost, blocked].every(Number.isSafeInteger)) throw new Error('资金合计超出整分范围');
  return {
    as_of: date, net_contributions_cents: net, settled_realized_pnl_cents: realized,
    funding_capacity_cents: capacity, holding_cost_cents: cost,
    reinvested_pnl_cents: Math.min(Math.max(0, realized), Math.max(0, cost - net)),
    outside_holdings_cents: capacity - cost, in_transit_principal_cents: blocked,
    unverified_settlement_count: unverified, sources,
  };
}

module.exports = { buildCapitalFunding, tradeSettlementChecks, verifiedArrival };
