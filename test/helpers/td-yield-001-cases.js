'use strict';

const HORIZON_ORDER = Object.freeze(['return_1m', 'return_3m', 'return_6m', 'return_1y']);
const HORIZON_LABELS = Object.freeze({
  return_1m: '1m',
  return_3m: '3m',
  return_6m: '6m',
  return_1y: '1y',
});

const BUCKET_WEIGHTS = Object.freeze({
  cash: Object.freeze({
    return_1m: 0.7,
    return_3m: 0.3,
  }),
  short: Object.freeze({
    return_1m: 0.2,
    return_3m: 0.5,
    return_6m: 0.3,
  }),
  medium: Object.freeze({
    return_3m: 0.5,
    return_6m: 0.3,
    return_1y: 0.2,
  }),
  long: Object.freeze({
    return_3m: 0.2,
    return_6m: 0.4,
    return_1y: 0.4,
  }),
});

const TERM_BOUNDARY_CASES = Object.freeze([
  { term_days: null, expected_bucket: 'unknown' },
  { term_days: -1, expected_bucket: 'unknown' },
  { term_days: 1.5, expected_bucket: 'unknown' },
  { term_days: 0, expected_bucket: 'cash' },
  { term_days: 1, expected_bucket: 'short' },
  { term_days: 30, expected_bucket: 'short' },
  { term_days: 31, expected_bucket: 'medium' },
  { term_days: 100, expected_bucket: 'medium' },
  { term_days: 101, expected_bucket: 'long' },
]);

const REFERENCE_YIELD_CASES = Object.freeze([
  {
    name: 'cash complete history',
    bucket: 'cash',
    returns: { return_1m: 2.2, return_3m: 3.3 },
    expected: {
      status: 'available',
      reason: 'complete_history',
      value_pct: 2.53,
      available_horizons: ['1m', '3m'],
      missing_horizons: [],
      weight_sum: 1,
    },
  },
  {
    name: 'cash missing 1M',
    bucket: 'cash',
    returns: { return_3m: 3 },
    expected: {
      status: 'available',
      reason: 'partial_history',
      value_pct: 3,
      available_horizons: ['3m'],
      missing_horizons: ['1m'],
      weight_sum: 0.3,
    },
  },
  {
    name: 'zero yield is a valid cash result',
    bucket: 'cash',
    returns: { return_1m: 0, return_3m: 0 },
    expected: {
      status: 'available',
      reason: 'complete_history',
      value_pct: 0,
      available_horizons: ['1m', '3m'],
      missing_horizons: [],
      weight_sum: 1,
    },
  },
  {
    name: 'short complete history',
    bucket: 'short',
    returns: { return_1m: 2, return_3m: 3, return_6m: 4 },
    expected: {
      status: 'available',
      reason: 'complete_history',
      value_pct: 3.1,
      available_horizons: ['1m', '3m', '6m'],
      missing_horizons: [],
      weight_sum: 1,
    },
  },
  {
    name: 'short missing 1M',
    bucket: 'short',
    returns: { return_3m: 3, return_6m: 4 },
    expected: {
      status: 'available',
      reason: 'partial_history',
      value_pct: 3.375,
      available_horizons: ['3m', '6m'],
      missing_horizons: ['1m'],
      weight_sum: 0.8,
    },
  },
  {
    name: 'medium complete history',
    bucket: 'medium',
    returns: { return_3m: 2, return_6m: 3, return_1y: 4 },
    expected: {
      status: 'available',
      reason: 'complete_history',
      value_pct: 2.7,
      available_horizons: ['3m', '6m', '1y'],
      missing_horizons: [],
      weight_sum: 1,
    },
  },
  {
    name: 'medium missing 6M',
    bucket: 'medium',
    returns: { return_3m: 2, return_1y: 4 },
    expected: {
      status: 'available',
      reason: 'partial_history',
      value_pct: 2.5714,
      available_horizons: ['3m', '1y'],
      missing_horizons: ['6m'],
      weight_sum: 0.7,
    },
  },
  {
    name: 'long complete history',
    bucket: 'long',
    returns: { return_3m: 2, return_6m: 3, return_1y: 4 },
    expected: {
      status: 'available',
      reason: 'complete_history',
      value_pct: 3.2,
      available_horizons: ['3m', '6m', '1y'],
      missing_horizons: [],
      weight_sum: 1,
    },
  },
  {
    name: 'long missing 3M',
    bucket: 'long',
    returns: { return_6m: 3, return_1y: 4 },
    expected: {
      status: 'available',
      reason: 'partial_history',
      value_pct: 3.5,
      available_horizons: ['6m', '1y'],
      missing_horizons: ['3m'],
      weight_sum: 0.8,
    },
  },
  {
    name: 'every designated window missing',
    bucket: 'long',
    returns: {},
    expected: {
      status: 'unavailable',
      reason: 'no_available_horizons',
      value_pct: null,
      available_horizons: [],
      missing_horizons: ['3m', '6m', '1y'],
      weight_sum: 0,
    },
  },
  {
    name: 'invalid numeric values are unavailable',
    bucket: 'long',
    returns: { return_3m: Number.NaN, return_6m: Number.POSITIVE_INFINITY, return_1y: '' },
    expected: {
      status: 'unavailable',
      reason: 'no_available_horizons',
      value_pct: null,
      available_horizons: [],
      missing_horizons: ['3m', '6m', '1y'],
      weight_sum: 0,
    },
  },
  {
    name: 'unknown term is not scored',
    bucket: 'unknown',
    returns: { return_1m: 3, return_3m: 4, return_6m: 5, return_1y: 6 },
    expected: {
      status: 'unavailable',
      reason: 'unknown_term',
      value_pct: null,
      available_horizons: [],
      missing_horizons: [],
      weight_sum: 0,
    },
  },
]);

const ROUNDING_CASES = Object.freeze([
  { value: 1.42875, expected: 1.4288 },
  { value: 3.94125, expected: 3.9413 },
  { value: 3.49875, expected: 3.4988 },
  { value: -1.42875, expected: -1.4288 },
  { value: 0.00004, expected: 0 },
  { value: -0.00004, expected: 0 },
]);

const DIVERGENCE_CASES = Object.freeze([
  { return_1m: null, return_3m: 2, expected_penalty: 0 },
  { return_1m: 2, return_3m: null, expected_penalty: 0 },
  { return_1m: 2, return_3m: 2.5, expected_penalty: 0 },
  { return_1m: 1.99, return_3m: 2.5, expected_penalty: 0.08 },
  { return_1m: 2, return_3m: 2.6, expected_penalty: 0.08 },
]);

const FRONTLOAD_GAP_CASES = Object.freeze([
  { gap_pp: 0.8, expected: { A: 0, B: 0, C: 0 } },
  { gap_pp: 1, expected: { A: 0, B: 0, C: 0 } },
  { gap_pp: 1.2, expected: { A: 0.03, B: 0, C: 0 } },
  { gap_pp: 1.5, expected: { A: 0.075, B: 0, C: 0 } },
  { gap_pp: 2, expected: { A: 0.15, B: 0.075, C: 0 } },
  { gap_pp: 2.7, expected: { A: 0.25, B: 0.18, C: 0 } },
  { gap_pp: 10, expected: { A: 0.25, B: 0.25, C: 0 } },
]);

const SCORE_CASES = Object.freeze([
  {
    name: 'short score with divergence penalty',
    bucket: 'short',
    returns: { return_1m: 1.8, return_3m: 2.4, return_6m: 3 },
    history_months: null,
    expected: {
      reference_yield_pct: 2.46,
      observation_score: 2.38,
      selection_score: { A: 2.38, B: 2.38, C: 2.38 },
    },
  },
  {
    name: 'medium score with history bonus',
    bucket: 'medium',
    returns: { return_1m: 2.8, return_3m: 3, return_6m: 3.5, return_1y: 4.5 },
    history_months: 18,
    expected: {
      reference_yield_pct: 3.45,
      observation_score: 3.45,
      selection_score: { A: 3.465, B: 3.465, C: 3.465 },
    },
  },
  {
    name: 'long score separates A B and C',
    bucket: 'long',
    returns: { return_1m: 1, return_3m: 2, return_6m: 3, return_1y: 5 },
    history_months: 24,
    expected: {
      reference_yield_pct: 3.6,
      observation_score: 3.52,
      selection_score: { A: 3.4, B: 3.475, C: 3.55 },
    },
  },
  {
    name: 'cash has no scoring fields',
    bucket: 'cash',
    returns: { return_1m: 2, return_3m: 4 },
    history_months: 24,
    expected: {
      reference_yield_pct: 2.6,
      observation_score: null,
      selection_score: { A: null, B: null, C: null },
    },
  },
]);

const CASH_EXCLUSION_CONTRACT = Object.freeze({
  display_reference_yield: true,
  display_weighted_yield: true,
  observation_score: false,
  selection_score: false,
  research_ranking: false,
  automation_ranking: false,
  allocation_budget: false,
  watchlist: false,
  new_position_candidate: false,
  holding_review_candidate: false,
  liquidity_credit: false,
  new_proposal: false,
  existing_holding_diagnostic: true,
});

const SCORING_CONTRACT = Object.freeze({
  yield_scale: 'percentage_point',
  score_unit: 'score_point',
  divergence_threshold_pp: 0.5,
  divergence_penalty_points: 0.08,
  history_bonus_points: Object.freeze({
    at_least_18_months: 0.015,
    at_least_24_months: 0.03,
  }),
  deduction_order: Object.freeze([
    'bucket_reference_base',
    'one_month_divergence',
    'front_load_scheme',
    'history_bonus',
    'final_round',
  ]),
});

const REFERENCE_RESULT_CONTRACT = Object.freeze({
  status_values: Object.freeze(['available', 'unavailable']),
  reason_values: Object.freeze([
    'complete_history',
    'partial_history',
    'no_available_horizons',
    'unknown_term',
  ]),
  api_fields: Object.freeze({
    numeric: 'reference_yield_pct',
    status: 'reference_yield_status',
    reason: 'reference_yield_reason',
  }),
  api_numeric_field_when_unavailable: null,
  zero_is_valid: true,
  rounding: Object.freeze({
    digits: 4,
    mode: 'half_away_from_zero',
  }),
});

const WEIGHTED_YIELD_CONTRACT = Object.freeze({
  mode: 'alias_of_reference_yield',
  retained_for_api_compatibility: true,
  used_for_new_decisions: false,
});

const AB_C_SCHEMES = Object.freeze({
  A: Object.freeze({
    short: Object.freeze({ threshold_pp: 1, slope: 0.15, cap: 0.25 }),
    medium: Object.freeze({ threshold_pp: 1, slope: 0.15, cap: 0.25 }),
    long: Object.freeze({ threshold_pp: 1, slope: 0.15, cap: 0.25 }),
  }),
  B: Object.freeze({
    short: Object.freeze({ threshold_pp: 1, slope: 0.15, cap: 0.25 }),
    medium: Object.freeze({ threshold_pp: 1, slope: 0.15, cap: 0.25 }),
    long: Object.freeze({ threshold_pp: 1.5, slope: 0.15, cap: 0.25 }),
  }),
  C: Object.freeze({
    short: Object.freeze({ threshold_pp: 1, slope: 0.15, cap: 0.25 }),
    medium: Object.freeze({ threshold_pp: 1, slope: 0.15, cap: 0.25 }),
    long: null,
  }),
});

const COMPARISON_CONTRACT = Object.freeze({
  same_snapshot_and_candidate_universe: true,
  schemes: Object.freeze(['A', 'B', 'C']),
  ranking_uses_exposed_rounding: true,
  tie_breakers: Object.freeze(['selection_score_desc', 'return_3m_desc', 'return_6m_desc', 'code_asc']),
  metrics: Object.freeze([
    'bucket_yield_distribution',
    'score_distribution',
    'within_bucket_rank_change',
    'top3_overlap',
    'candidate_set_change',
    'high_score_concentration',
    'boundary_stability',
    'missing_window_status',
  ]),
});

module.exports = {
  AB_C_SCHEMES,
  BUCKET_WEIGHTS,
  CASH_EXCLUSION_CONTRACT,
  COMPARISON_CONTRACT,
  DIVERGENCE_CASES,
  FRONTLOAD_GAP_CASES,
  HORIZON_LABELS,
  HORIZON_ORDER,
  REFERENCE_RESULT_CONTRACT,
  REFERENCE_YIELD_CASES,
  ROUNDING_CASES,
  SCORE_CASES,
  SCORING_CONTRACT,
  TERM_BOUNDARY_CASES,
  WEIGHTED_YIELD_CONTRACT,
};
