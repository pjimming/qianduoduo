'use strict';

const { buildHoldingAmountsByDate, shiftDate } = require('../../../lib/metrics');
const {
  datesBetween,
  parseCoveredYieldDates,
  weekendDisclosureBase,
} = require('../../../lib/product-income-coverage');

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

function estimateWeek(dates, trades, valuations, code, today, yieldLagDays) {
  const unavailable = (status) => ({ status, annualized_pct: null });
  const dailyHoldings = buildHoldingAmountsByDate(
    dates.map((date) => ({ date })),
    tradesForProduct(trades, code),
  );
  const principals = dates.map((date) => dailyHoldings.get(date));
  if (principals.some((amount) => !(amount > 0))) {
    return unavailable('short-holding');
  }

  const window = new Set(dates);
  const factDates = new Set(valuations.map((item) => item.yield_date));
  const covered = new Set();
  let pnlCents = 0;
  for (const item of valuations) {
    const { yield_date: yieldDate, covered_yield_dates: declaredDates } = item;
    const inWindow = window.has(yieldDate);
    // Separately recorded days supersede an inferred Monday cover.
    const explicit = declaredDates.length > 0 &&
      parseCoveredYieldDates(item.notes, yieldDate).length > 0;
    const coveredDates = explicit
      ? declaredDates
      : declaredDates.filter((date) => date === yieldDate || !factDates.has(date));
    if (coveredDates.some((date) => window.has(date) !== inWindow)) {
      return unavailable('cross-boundary');
    }
    if (inWindow) {
      covered.add(yieldDate);
      for (const date of coveredDates) covered.add(date);
      pnlCents += Math.round(item.daily_pnl * 100);
    }
  }

  const missing = dates.filter((date) => !covered.has(date));
  if (missing.length) {
    const overdue = missing.some(
      (date) => today > shiftDate(weekendDisclosureBase(date), yieldLagDays),
    );
    return unavailable(overdue ? 'missing' : 'waiting');
  }

  const principalDaysCents = principals.reduce(
    (total, amount) => total + Math.round(amount * 100),
    0,
  );
  return { status: 'ready', annualized_pct: (pnlCents / principalDaysCents) * 365 * 100 };
}

function buildHoldingPerformance(holdings, trades, valuations, disclosurePolicy, today) {
  const endDate = disclosurePolicy.reporting_date;
  const startDate = shiftDate(endDate, -6);
  const dates = datesBetween(startDate, endDate);
  const factsByCode = new Map();
  for (const { product_code: code } of holdings) {
    if (code) factsByCode.set(code, []);
  }
  // A real weekend fact just before the window can also resolve default Monday coverage.
  const factStartDate = shiftDate(startDate, -2);
  for (const item of valuations) {
    if (item.yield_date >= factStartDate && item.yield_date <= today) {
      factsByCode.get(item.product_code)?.push(item);
    }
  }
  const lagByCode = new Map(
    disclosurePolicy.products.map((item) => [item.product_code, item.yield_lag_days]),
  );
  return {
    start_date: startDate,
    end_date: endDate,
    weekly_by_code: Object.fromEntries(
      [...factsByCode].map(([code, facts]) => [
        code,
        estimateWeek(
          dates,
          trades,
          facts,
          code,
          today,
          lagByCode.get(code) ?? disclosurePolicy.default_yield_lag_days,
        ),
      ]),
    ),
  };
}

module.exports = { buildHoldingPerformance };
