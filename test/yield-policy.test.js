'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BUCKET_WEIGHTS,
  DEFAULT_FRONT_LOAD_SCHEME,
  bucketForTerm,
  calculateReferenceYield,
  calculateYieldMetrics,
  frontLoadDeduction,
  roundHalfAwayFromZero,
} = require('../lib/yield-policy');
const {
  REFERENCE_YIELD_CASES,
  SCORE_CASES,
  TERM_BOUNDARY_CASES,
} = require('./helpers/td-yield-001-cases');

test('production yield policy uses the selected term buckets and weights', () => {
  for (const item of TERM_BOUNDARY_CASES) {
    assert.equal(bucketForTerm(item.term_days), item.expected_bucket);
  }
  assert.deepEqual(BUCKET_WEIGHTS.short, {
    return_1m: 0.2,
    return_3m: 0.5,
    return_6m: 0.3,
  });
  assert.equal(DEFAULT_FRONT_LOAD_SCHEME, 'B');
});

test('production reference results match all frozen complete, partial and unavailable cases', () => {
  for (const item of REFERENCE_YIELD_CASES) {
    const result = calculateReferenceYield(item.returns, {
      bucket: item.bucket,
    });
    assert.deepEqual(
      {
        status: result.status,
        reason: result.reason,
        value_pct: result.value_pct,
        available_horizons: result.available_horizons,
        missing_horizons: result.missing_horizons,
        weight_sum: result.weight_sum,
      },
      item.expected,
      item.name,
    );
  }
});

test('production score metrics match the final short, medium and long cases', () => {
  for (const item of SCORE_CASES) {
    const product = {
      ...item.returns,
      term_days:
        item.bucket === 'cash'
          ? 0
          : item.bucket === 'short'
            ? 7
            : item.bucket === 'medium'
              ? 90
              : 180,
      history_months: item.history_months,
    };
    const result = calculateYieldMetrics(product);
    assert.equal(result.reference_yield_status, 'available');
    assert.equal(result.reference_yield_pct, item.expected.reference_yield_pct);
    assert.equal(result.weighted_yield_pct, result.reference_yield_pct);
    assert.equal(result.observation_score, item.expected.observation_score);
    assert.equal(
      result.selection_score,
      item.expected.selection_score.B,
      item.name,
    );
  }
});

test('cash and unknown buckets never receive scores', () => {
  const cash = calculateYieldMetrics({
    term_days: 0,
    return_1m: 3,
    return_3m: 4,
    history_months: 24,
  });
  assert.equal(cash.reference_yield_pct, 3.3);
  assert.equal(cash.weighted_yield_pct, 3.3);
  assert.equal(cash.observation_score, null);
  assert.equal(cash.selection_score, null);

  const unknown = calculateYieldMetrics({
    term_days: 1.5,
    return_1m: 3,
    return_3m: 4,
  });
  assert.equal(unknown.reference_yield_status, 'unavailable');
  assert.equal(unknown.reference_yield_reason, 'unknown_term');
  assert.equal(unknown.reference_yield_pct, null);
});

test('front-load scheme B uses 1.5pp only for long products', () => {
  const product = { return_6m: 2, return_1y: 3.7 };
  assert.ok(
    Math.abs(frontLoadDeduction('short', product, 'B') - 0.105) < 1e-12,
  );
  assert.ok(
    Math.abs(frontLoadDeduction('medium', product, 'B') - 0.105) < 1e-12,
  );
  assert.ok(
    Math.abs(frontLoadDeduction('long', product, 'B') - 0.03) < 1e-12,
  );
  assert.equal(roundHalfAwayFromZero(1.42875), 1.4288);
});
