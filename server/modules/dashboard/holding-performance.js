'use strict';

const { buildHoldingAmountsByDate, shiftDate } = require('../../../lib/metrics');
const { parseCoveredYieldDates } = require('../../../lib/product-income-coverage');

function tradesForProduct(trades, code) {
  return trades.flatMap((trade) => {
    const source = trade.product_code === code;
    if (trade.trade_type !== 'switch') return source ? [trade] : [];

    const target = (trade.target_product_code || trade.product_code) === code;
    if (source && target) return [trade];
    if (source) return [{ ...trade, trade_type: 'redeem' }];
    if (target) {
      return [{
        ...trade,
        trade_type: 'buy',
        amount: trade.settlement_amount ?? trade.amount,
      }];
    }
    return [];
  });
}


function estimateRecentRecords(trades, valuations, code) {
  const facts = valuations
    .sort((left, right) => right.yield_date.localeCompare(left.yield_date))
    .slice(0, 7);
  if (!facts.length) {
    return { status: 'missing', annualized_pct: null, record_count: 0 };
  }

  const factDates = new Set(valuations.map((item) => item.yield_date));
  const covered = new Set();
  let pnlCents = 0;
  for (const item of facts) {
    const { yield_date: yieldDate, covered_yield_dates: declaredDates } = item;
    const explicit = parseCoveredYieldDates(item.notes, yieldDate).length > 0;
    covered.add(yieldDate);
    for (const date of declaredDates) {
      // Separate facts supersede inferred coverage even outside the selected sample.
      if (explicit || !factDates.has(date)) covered.add(date);
    }
    pnlCents += Math.round(item.daily_pnl * 100);
  }

  const dailyHoldings = buildHoldingAmountsByDate(
    [...covered].map((date) => ({ date })),
    tradesForProduct(trades, code),
  );
  const principalDaysCents = [...dailyHoldings.values()].reduce(
    (total, amount) => total + Math.round(amount * 100),
    0,
  );
  const sample = {
    record_count: facts.length,
    start_date: dailyHoldings.keys().next().value,
    end_date: facts[0].yield_date,
  };
  if (!principalDaysCents) {
    return { ...sample, status: 'missing', annualized_pct: null };
  }
  return {
    ...sample,
    status: 'ready',
    annualized_pct: (pnlCents / principalDaysCents) * 365 * 100,
  };
}

function buildHoldingPerformance(holdings, trades, valuations, disclosurePolicy, today) {
  const factsByCode = new Map();
  for (const { product_code: code } of holdings) {
    if (code) factsByCode.set(code, []);
  }
  for (const item of valuations) {
    if (item.yield_date <= today) factsByCode.get(item.product_code)?.push(item);
  }

  // Keep the legacy report dates for API consumers. Each estimate carries its own sample dates.
  const endDate = disclosurePolicy.reporting_date;
  return {
    start_date: shiftDate(endDate, -6),
    end_date: endDate,
    weekly_by_code: Object.fromEntries(
      [...factsByCode].map(([code, facts]) => [code, estimateRecentRecords(trades, facts, code)]),
    ),
  };
}

module.exports = { buildHoldingPerformance };
