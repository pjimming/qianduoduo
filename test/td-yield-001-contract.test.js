'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('./helpers/td-yield-001-cases');

function bucketForTerm(termDays) {
  if (!Number.isSafeInteger(termDays) || termDays < 0) return 'unknown';
  if (termDays === 0) return 'cash';
  if (termDays <= 30) return 'short';
  if (termDays <= 100) return 'medium';
  return 'long';
}

function roundHalfAwayFromZero(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  const rounded =
    Math.floor(Math.abs(value) * factor + 0.5 + Number.EPSILON) / factor;
  if (rounded === 0) return 0;
  return Math.sign(value) * rounded;
}

function referenceYieldByContract(bucket, returns) {
  const weights = BUCKET_WEIGHTS[bucket];
  if (!weights) {
    return {
      status: 'unavailable',
      reason: 'unknown_term',
      value_pct: null,
      available_horizons: [],
      missing_horizons: [],
      weight_sum: 0,
    };
  }
  const available = HORIZON_ORDER
    .filter((key) => weights[key] !== undefined)
    .map((key) => ({
      key,
      value: Number.isFinite(returns[key]) ? returns[key] : null,
      weight: weights[key],
    }));
  const present = available.filter((item) => item.value !== null);
  const weightSum = present.reduce((sum, item) => sum + item.weight, 0);
  const availableHorizons = present.map((item) => HORIZON_LABELS[item.key]);
  const missingHorizons = available
    .filter((item) => item.value === null)
    .map((item) => HORIZON_LABELS[item.key]);
  if (!present.length) {
    return {
      status: 'unavailable',
      reason: 'no_available_horizons',
      value_pct: null,
      available_horizons: [],
      missing_horizons: missingHorizons,
      weight_sum: 0,
    };
  }
  const raw =
    present.reduce((sum, item) => sum + item.value * item.weight, 0) /
    weightSum;
  return {
    status: 'available',
    reason: missingHorizons.length ? 'partial_history' : 'complete_history',
    value_pct: roundHalfAwayFromZero(raw),
    available_horizons: availableHorizons,
    missing_horizons: missingHorizons,
    weight_sum: weightSum,
  };
}

function divergencePenalty(returns) {
  if (
    !Number.isFinite(returns.return_1m) ||
    !Number.isFinite(returns.return_3m)
  ) {
    return 0;
  }
  return returns.return_1m < returns.return_3m - 0.5 ? 0.08 : 0;
}

function frontLoadDeduction(bucket, gapPp, scheme) {
  const rule = AB_C_SCHEMES[scheme][bucket];
  if (!rule || !Number.isFinite(gapPp) || gapPp <= rule.threshold_pp) {
    return 0;
  }
  return Math.min(rule.cap, (gapPp - rule.threshold_pp) * rule.slope);
}

function scoreByContract({
  bucket,
  returns,
  historyMonths,
  scheme,
}) {
  if (bucket === 'cash' || bucket === 'unknown') {
    return { observation_score: null, selection_score: null };
  }
  const reference = referenceYieldByContract(bucket, returns);
  if (reference.status !== 'available') {
    return { observation_score: null, selection_score: null };
  }
  const base = Number(
    (
      (Object.entries(BUCKET_WEIGHTS[bucket])
        .filter(([key]) => Number.isFinite(returns[key]))
        .reduce(
          (sum, [key, weight]) => sum + returns[key] * weight,
          0,
        ) /
        Object.entries(BUCKET_WEIGHTS[bucket])
          .filter(([key]) => Number.isFinite(returns[key]))
          .reduce((sum, [, weight]) => sum + weight, 0))
    ).toFixed(10),
  );
  const observation = base - divergencePenalty(returns);
  const gapPp =
    Number.isFinite(returns.return_1y) && Number.isFinite(returns.return_6m)
      ? returns.return_1y - returns.return_6m
      : null;
  let selection = observation - frontLoadDeduction(bucket, gapPp, scheme);
  if (Number.isFinite(historyMonths)) {
    if (historyMonths >= 24) selection += 0.03;
    else if (historyMonths >= 18) selection += 0.015;
  }
  return {
    observation_score: roundHalfAwayFromZero(observation),
    selection_score: roundHalfAwayFromZero(selection),
  };
}

test('term boundaries freeze cash at zero days and use integer-day buckets', () => {
  for (const item of TERM_BOUNDARY_CASES) {
    assert.equal(
      bucketForTerm(item.term_days),
      item.expected_bucket,
      `term_days=${item.term_days}`,
    );
  }
});

test('each bucket has the frozen window set and weights sum to one', () => {
  assert.deepEqual(Object.keys(BUCKET_WEIGHTS), [
    'cash',
    'short',
    'medium',
    'long',
  ]);
  for (const [bucket, weights] of Object.entries(BUCKET_WEIGHTS)) {
    const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(total - 1) < 1e-12, `${bucket} weights must sum to 1`);
  }
  assert.deepEqual(BUCKET_WEIGHTS.cash, {
    return_1m: 0.7,
    return_3m: 0.3,
  });
  assert.deepEqual(BUCKET_WEIGHTS.short, {
    return_1m: 0.2,
    return_3m: 0.5,
    return_6m: 0.3,
  });
  assert.deepEqual(BUCKET_WEIGHTS.medium, {
    return_3m: 0.5,
    return_6m: 0.3,
    return_1y: 0.2,
  });
  assert.deepEqual(BUCKET_WEIGHTS.long, {
    return_3m: 0.2,
    return_6m: 0.4,
    return_1y: 0.4,
  });
});

test('reference yield cases cover complete, partial and explicit unavailable states', () => {
  for (const item of REFERENCE_YIELD_CASES) {
    assert.deepEqual(
      referenceYieldByContract(item.bucket, item.returns),
      item.expected,
      item.name,
    );
  }
});

test('reference result contract keeps zero valid and null explicit when unavailable', () => {
  assert.deepEqual(REFERENCE_RESULT_CONTRACT.status_values, [
    'available',
    'unavailable',
  ]);
  assert.deepEqual(REFERENCE_RESULT_CONTRACT.api_fields, {
    numeric: 'reference_yield_pct',
    status: 'reference_yield_status',
    reason: 'reference_yield_reason',
  });
  assert.equal(REFERENCE_RESULT_CONTRACT.api_numeric_field_when_unavailable, null);
  assert.equal(REFERENCE_RESULT_CONTRACT.zero_is_valid, true);
  assert.deepEqual(REFERENCE_RESULT_CONTRACT.rounding, {
    digits: 4,
    mode: 'half_away_from_zero',
  });
  const zero = REFERENCE_YIELD_CASES.find(
    (item) => item.name === 'zero yield is a valid cash result',
  );
  assert.equal(zero.expected.status, 'available');
  assert.equal(zero.expected.value_pct, 0);
});

test('four-decimal rounding is stable for positive, negative and real tie cases', () => {
  for (const item of ROUNDING_CASES) {
    assert.equal(roundHalfAwayFromZero(item.value), item.expected);
  }
});

test('one-month divergence penalty preserves strict thresholds and missing semantics', () => {
  for (const item of DIVERGENCE_CASES) {
    assert.equal(divergencePenalty(item), item.expected_penalty);
  }
});

test('long-bucket A B C schemes use fixed thresholds and scoring-point deductions', () => {
  for (const item of FRONTLOAD_GAP_CASES) {
    for (const scheme of ['A', 'B', 'C']) {
      assert.ok(
        Math.abs(
          frontLoadDeduction('long', item.gap_pp, scheme) -
            item.expected[scheme],
        ) < 1e-12,
        `${scheme} gap=${item.gap_pp}`,
      );
    }
  }
  assert.ok(Math.abs(frontLoadDeduction('short', 2, 'B') - 0.15) < 1e-12);
  assert.ok(Math.abs(frontLoadDeduction('medium', 1.2, 'C') - 0.03) < 1e-12);
  assert.equal(frontLoadDeduction('long', 1.2, 'C'), 0);
});

test('score cases verify calculation order, single final rounding and cash exclusion', () => {
  for (const item of SCORE_CASES) {
    for (const scheme of ['A', 'B', 'C']) {
      const actual = scoreByContract({
        bucket: item.bucket,
        returns: item.returns,
        historyMonths: item.history_months,
        scheme,
      });
      assert.equal(
        actual.observation_score,
        item.expected.observation_score,
        `${item.name} ${scheme} observation`,
      );
      assert.equal(
        actual.selection_score,
        item.expected.selection_score[scheme],
        `${item.name} ${scheme} selection`,
      );
    }
    assert.equal(
      referenceYieldByContract(item.bucket, item.returns).value_pct,
      item.expected.reference_yield_pct,
      `${item.name} reference`,
    );
  }
});

test('scoring units and calculation order are fixed before A B C comparison', () => {
  assert.equal(SCORING_CONTRACT.yield_scale, 'percentage_point');
  assert.equal(SCORING_CONTRACT.score_unit, 'score_point');
  assert.equal(SCORING_CONTRACT.divergence_threshold_pp, 0.5);
  assert.equal(SCORING_CONTRACT.divergence_penalty_points, 0.08);
  assert.deepEqual(SCORING_CONTRACT.deduction_order, [
    'bucket_reference_base',
    'one_month_divergence',
    'front_load_scheme',
    'history_bonus',
    'final_round',
  ]);
});

test('cash exclusion contract blocks ranking, allocation, candidates and proposals', () => {
  assert.equal(CASH_EXCLUSION_CONTRACT.display_reference_yield, true);
  assert.equal(CASH_EXCLUSION_CONTRACT.display_weighted_yield, true);
  for (const key of [
    'observation_score',
    'selection_score',
    'research_ranking',
    'automation_ranking',
    'allocation_budget',
    'watchlist',
    'new_position_candidate',
    'holding_review_candidate',
    'liquidity_credit',
    'new_proposal',
  ]) {
    assert.equal(CASH_EXCLUSION_CONTRACT[key], false, key);
  }
  assert.equal(CASH_EXCLUSION_CONTRACT.existing_holding_diagnostic, true);
});

test('A B C comparison contract uses one snapshot, one universe and frozen metrics', () => {
  assert.equal(COMPARISON_CONTRACT.same_snapshot_and_candidate_universe, true);
  assert.deepEqual(COMPARISON_CONTRACT.schemes, ['A', 'B', 'C']);
  assert.equal(COMPARISON_CONTRACT.ranking_uses_exposed_rounding, true);
  assert.deepEqual(COMPARISON_CONTRACT.tie_breakers, [
    'selection_score_desc',
    'return_3m_desc',
    'return_6m_desc',
    'code_asc',
  ]);
  assert.ok(COMPARISON_CONTRACT.metrics.includes('candidate_set_change'));
  assert.ok(COMPARISON_CONTRACT.metrics.includes('high_score_concentration'));
});

test('weighted yield stays as a compatibility alias rather than a second decision formula', () => {
  assert.deepEqual(WEIGHTED_YIELD_CONTRACT, {
    mode: 'alias_of_reference_yield',
    retained_for_api_compatibility: true,
    used_for_new_decisions: false,
  });
});
