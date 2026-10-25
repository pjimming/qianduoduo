'use strict';

const POLICY_VERSION = 'r2-term-yield-v1';
const DEFAULT_FRONT_LOAD_SCHEME = 'B';
const HORIZON_ORDER = Object.freeze([
  'return_1m',
  'return_3m',
  'return_6m',
  'return_1y',
]);
const HORIZON_LABELS = Object.freeze({
  return_1m: '1m',
  return_3m: '3m',
  return_6m: '6m',
  return_1y: '1y',
});
const BUCKET_WEIGHTS = deepFreeze({
  cash: {
    return_1m: 0.7,
    return_3m: 0.3,
  },
  short: {
    return_1m: 0.2,
    return_3m: 0.5,
    return_6m: 0.3,
  },
  medium: {
    return_3m: 0.5,
    return_6m: 0.3,
    return_1y: 0.2,
  },
  long: {
    return_3m: 0.2,
    return_6m: 0.4,
    return_1y: 0.4,
  },
});
const FRONT_LOAD_SCHEMES = deepFreeze({
  A: {
    short: { thresholdPp: 1, slope: 0.15, cap: 0.25 },
    medium: { thresholdPp: 1, slope: 0.15, cap: 0.25 },
    long: { thresholdPp: 1, slope: 0.15, cap: 0.25 },
  },
  B: {
    short: { thresholdPp: 1, slope: 0.15, cap: 0.25 },
    medium: { thresholdPp: 1, slope: 0.15, cap: 0.25 },
    long: { thresholdPp: 1.5, slope: 0.15, cap: 0.25 },
  },
  C: {
    short: { thresholdPp: 1, slope: 0.15, cap: 0.25 },
    medium: { thresholdPp: 1, slope: 0.15, cap: 0.25 },
    long: null,
  },
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function numberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundHalfAwayFromZero(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  const rounded =
    Math.floor(Math.abs(value) * factor + 0.5 + Number.EPSILON) / factor;
  return rounded === 0 ? 0 : Math.sign(value) * rounded;
}

function bucketForTerm(termDays) {
  const value = numberOrNull(termDays);
  if (!Number.isSafeInteger(value) || value < 0) return 'unknown';
  if (value === 0) return 'cash';
  if (value <= 30) return 'short';
  if (value <= 100) return 'medium';
  return 'long';
}

function normalizeWeightMap(bucket, availableKeys, bucketWeights) {
  const weights = bucketWeights[bucket];
  if (!weights) return {};
  const sum = availableKeys.reduce(
    (total, key) => total + weights[key],
    0,
  );
  if (sum <= 0) return {};
  return Object.fromEntries(
    availableKeys.map((key) => [
      key,
      roundHalfAwayFromZero(weights[key] / sum, 10),
    ]),
  );
}

function calculateReferenceYield(
  product,
  options = {},
) {
  const bucket =
    options.bucket || bucketForTerm(product?.term_days);
  const bucketWeights = options.bucketWeights || BUCKET_WEIGHTS;
  const weights = bucketWeights[bucket];
  if (!weights) {
    return {
      bucket,
      status: 'unavailable',
      reason: 'unknown_term',
      value_pct: null,
      raw_value_pct: null,
      available_horizons: [],
      missing_horizons: [],
      weight_sum: 0,
      defined_weights: {},
      normalized_weights: {},
    };
  }
  const declaredKeys = HORIZON_ORDER.filter(
    (key) => weights[key] !== undefined,
  );
  const availableKeys = declaredKeys.filter(
    (key) => numberOrNull(product?.[key]) !== null,
  );
  const missingHorizons = declaredKeys
    .filter((key) => !availableKeys.includes(key))
    .map((key) => HORIZON_LABELS[key]);
  if (!availableKeys.length) {
    return {
      bucket,
      status: 'unavailable',
      reason: 'no_available_horizons',
      value_pct: null,
      raw_value_pct: null,
      available_horizons: [],
      missing_horizons: missingHorizons,
      weight_sum: 0,
      defined_weights: Object.fromEntries(
        declaredKeys.map((key) => [key, weights[key]]),
      ),
      normalized_weights: {},
    };
  }
  const weightSum = availableKeys.reduce(
    (total, key) => total + weights[key],
    0,
  );
  const rawValue =
    availableKeys.reduce(
      (total, key) =>
        total + numberOrNull(product[key]) * weights[key],
      0,
    ) / weightSum;
  return {
    bucket,
    status: 'available',
    reason: missingHorizons.length ? 'partial_history' : 'complete_history',
    value_pct: roundHalfAwayFromZero(rawValue),
    raw_value_pct: rawValue,
    available_horizons: availableKeys.map((key) => HORIZON_LABELS[key]),
    missing_horizons: missingHorizons,
    weight_sum: roundHalfAwayFromZero(weightSum, 10),
    defined_weights: Object.fromEntries(
      declaredKeys.map((key) => [key, weights[key]]),
    ),
    normalized_weights: normalizeWeightMap(
      bucket,
      availableKeys,
      bucketWeights,
    ),
  };
}

function divergencePenalty(product) {
  const oneMonth = numberOrNull(product?.return_1m);
  const threeMonth = numberOrNull(product?.return_3m);
  if (oneMonth === null || threeMonth === null) return 0;
  return oneMonth < threeMonth - 0.5 ? 0.08 : 0;
}

function frontLoadDeduction(
  bucket,
  product,
  scheme = DEFAULT_FRONT_LOAD_SCHEME,
) {
  const rule = FRONT_LOAD_SCHEMES[scheme]?.[bucket];
  const oneYear = numberOrNull(product?.return_1y);
  const sixMonth = numberOrNull(product?.return_6m);
  if (!rule || oneYear === null || sixMonth === null) return 0;
  const gapPp = oneYear - sixMonth;
  if (gapPp <= rule.thresholdPp) return 0;
  return Math.min(rule.cap, (gapPp - rule.thresholdPp) * rule.slope);
}

function historyBonus(historyMonths) {
  const months = numberOrNull(historyMonths);
  if (months === null) return 0;
  if (months >= 24) return 0.03;
  if (months >= 18) return 0.015;
  return 0;
}

function calculateYieldMetrics(product, options = {}) {
  const reference = calculateReferenceYield(product, options);
  const scoringBucket = ['short', 'medium', 'long'].includes(
    reference.bucket,
  );
  if (reference.status !== 'available' || !scoringBucket) {
    return {
      bucket: reference.bucket,
      reference,
      reference_yield_pct: reference.value_pct,
      reference_yield_status: reference.status,
      reference_yield_reason: reference.reason,
      reference_available_horizons: reference.available_horizons,
      reference_normalized_weights: reference.normalized_weights,
      weighted_yield_pct: reference.value_pct,
      observation_score: null,
      selection_score: null,
      divergence_penalty_points: 0,
      front_load_penalty_points: 0,
      history_bonus_points: 0,
    };
  }
  const divergence = divergencePenalty(product);
  const observationRaw = reference.raw_value_pct - divergence;
  const frontLoad = frontLoadDeduction(
    reference.bucket,
    product,
    options.frontLoadScheme || DEFAULT_FRONT_LOAD_SCHEME,
  );
  const bonus = historyBonus(product.history_months);
  return {
    bucket: reference.bucket,
    reference,
    reference_yield_pct: reference.value_pct,
    reference_yield_status: reference.status,
    reference_yield_reason: reference.reason,
    reference_available_horizons: reference.available_horizons,
    reference_normalized_weights: reference.normalized_weights,
    weighted_yield_pct: reference.value_pct,
    observation_score: roundHalfAwayFromZero(observationRaw),
    selection_score: roundHalfAwayFromZero(
      observationRaw - frontLoad + bonus,
    ),
    divergence_penalty_points: divergence,
    front_load_penalty_points: frontLoad,
    history_bonus_points: bonus,
  };
}

module.exports = {
  BUCKET_WEIGHTS,
  DEFAULT_FRONT_LOAD_SCHEME,
  FRONT_LOAD_SCHEMES,
  HORIZON_LABELS,
  HORIZON_ORDER,
  POLICY_VERSION,
  bucketForTerm,
  calculateReferenceYield,
  calculateYieldMetrics,
  divergencePenalty,
  frontLoadDeduction,
  historyBonus,
  numberOrNull,
  roundHalfAwayFromZero,
};
