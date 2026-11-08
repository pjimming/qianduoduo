'use strict';

const { CONTRACT, fingerprint, freeze } = require('./contract');
const { reviewPretrade } = require('./pretrade');
const { isoDate, daysBetween } = require('../r2-screening/calendar');
const { roundHalfAwayFromZero } = require('../../../lib/yield-policy');
const { calculateSwitch } = require('../../../lib/holdings-review');

function buildBuyForecast({ row, check, amountCents, date }) {
  const review = reviewPretrade({ row, check, amountCents, date });
  const timing = check?.facts?.terms?.timing;
  const fees = check?.facts?.fees;
  const reference = row?.reference?.value_pct;
  const missing = reason => freeze({ status: 'unavailable', reason, value: null });
  if (!review.executable || typeof reference !== 'number' || !Number.isFinite(reference) || reference <= -100) return missing('pretrade_or_reference_unavailable');
  if (!isoDate(timing?.expected_confirm_on) || !isoDate(timing?.expected_redeem_on) || !isoDate(timing?.expected_arrival_on)) return missing('forecast_dates_unavailable');
  const holdingDays = daysBetween(timing.expected_confirm_on, timing.expected_redeem_on);
  const totalDays = daysBetween(date, timing.expected_arrival_on);
  if (holdingDays <= 0 || totalDays < holdingDays || holdingDays < row.term.days) return missing('forecast_dates_conflict');
  const scenario = calculateSwitch({ amount: amountCents / 100, currentYieldPct: 0, newYieldPct: reference,
    horizonDays: totalDays, switchWaitDays: totalDays - holdingDays,
    purchaseFeeBps: fees.purchase_bps, redemptionFeeBps: fees.redemption_bps });
  const netCents = roundHalfAwayFromZero(scenario.new_net * 100, 0);
  const netFactor = 1 + netCents / amountCents;
  const annualized = (netFactor ** (365 / totalDays) - 1) * 100;
  if (!Number.isFinite(netCents) || !Number.isFinite(annualized) || netFactor <= 0) return missing('forecast_not_finite');
  const body = { status: 'available', reason: 'frozen_reference_scenario', value: netCents,
    metric: 'net_pnl_cents', reference_yield_pct: reference, reference_yield_policy_version: CONTRACT.yield_policy_version,
    principal_cents: amountCents, start_date: date, confirm_date: timing.expected_confirm_on,
    redemption_date: timing.expected_redeem_on, end_date: timing.expected_arrival_on,
    holding_days: holdingDays, total_days: totalDays, idle_days: totalDays - holdingDays,
    purchase_fee_bps: fees.purchase_bps, redemption_fee_bps: fees.redemption_bps,
    fee_model: 'principal_bps_linear', scenario_engine: 'holdings-review.calculateSwitch',
    expected_net_pnl_cents: netCents, expected_net_annualized_pct: roundHalfAwayFromZero(annualized),
    reinvestment_assumed: false, classification: 'scenario_not_promise' };
  return freeze({ ...body, hash: fingerprint(body) });
}

module.exports = { buildBuyForecast };
