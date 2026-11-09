'use strict';

const { CONTRACT, fingerprint, freeze } = require('./contract');
const { isoDate, daysBetween, shift } = require('../r2-screening/calendar');
const { roundHalfAwayFromZero } = require('../../../lib/yield-policy');
const { calculateSwitch } = require('../../../lib/holdings-review');

function buildBuyForecast({ row, amountCents, date }) {
  const reference = row?.reference?.value_pct;
  const termDays = row?.term?.days;
  const missing = reason => freeze({ status: 'unavailable', reason, value: null });
  if (typeof reference !== 'number' || !Number.isFinite(reference) || reference <= -100) return missing('reference_unavailable');
  if (!Number.isInteger(termDays) || termDays <= 0) return missing('forecast_term_unavailable');
  // Public screening has no structured purchase/redemption timing or fee facts.
  // Use a documented conservative T+1 confirmation and T+2 arrival assumption.
  const confirmDate = shift(date, 1);
  const redemptionDate = shift(confirmDate, termDays);
  const arrivalDate = shift(redemptionDate, 2);
  if (!isoDate(confirmDate) || !isoDate(redemptionDate) || !isoDate(arrivalDate)) return missing('forecast_dates_unavailable');
  const holdingDays = daysBetween(confirmDate, redemptionDate);
  const totalDays = daysBetween(date, arrivalDate);
  if (holdingDays <= 0 || totalDays < holdingDays || holdingDays < termDays) return missing('forecast_dates_conflict');
  const fees = { purchase_bps: 0, redemption_bps: 0 };
  const scenario = calculateSwitch({ amount: amountCents / 100, currentYieldPct: 0, newYieldPct: reference,
    horizonDays: totalDays, switchWaitDays: totalDays - holdingDays,
    purchaseFeeBps: fees.purchase_bps, redemptionFeeBps: fees.redemption_bps });
  const netCents = roundHalfAwayFromZero(scenario.new_net * 100, 0);
  const netFactor = 1 + netCents / amountCents;
  const annualized = (netFactor ** (365 / totalDays) - 1) * 100;
  if (!Number.isFinite(netCents) || !Number.isFinite(annualized) || netFactor <= 0) return missing('forecast_not_finite');
  const body = { status: 'available', reason: 'public_reference_scenario', value: netCents,
    metric: 'net_pnl_cents', reference_yield_pct: reference, reference_yield_policy_version: CONTRACT.yield_policy_version,
    principal_cents: amountCents, start_date: date, confirm_date: confirmDate,
    redemption_date: redemptionDate, end_date: arrivalDate,
    holding_days: holdingDays, total_days: totalDays, idle_days: totalDays - holdingDays,
    purchase_fee_bps: fees.purchase_bps, redemption_fee_bps: fees.redemption_bps,
    fee_model: 'principal_bps_linear', scenario_engine: 'holdings-review.calculateSwitch',
    timing_basis: 'public_t_plus_one_confirm_t_plus_two_arrival', fee_basis: 'public_no_structured_fee_facts',
    expected_net_pnl_cents: netCents, expected_net_annualized_pct: roundHalfAwayFromZero(annualized),
    reinvestment_assumed: false, classification: 'scenario_not_promise' };
  return freeze({ ...body, hash: fingerprint(body) });
}

module.exports = { buildBuyForecast };
