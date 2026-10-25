'use strict';

const {
  EVIDENCE_POLICY,
  isProductPoolEligible,
  returnEvidenceTier,
} = require('./products');
const {
  BUCKET_WEIGHTS,
  DEFAULT_FRONT_LOAD_SCHEME,
  FRONT_LOAD_SCHEMES,
  HORIZON_LABELS,
  HORIZON_ORDER,
  POLICY_VERSION,
  bucketForTerm: policyBucketForTerm,
  calculateReferenceYield: policyCalculateReferenceYield,
  divergencePenalty: policyDivergencePenalty,
  frontLoadDeduction: policyFrontLoadDeduction,
  historyBonus: policyHistoryBonus,
  roundHalfAwayFromZero,
} = require('./yield-policy');

const SHADOW_VERSION = 'td-yield-001-shadow-v2';
const SCHEMES = Object.freeze(['A', 'B', 'C']);
const RANKING_BUCKETS = Object.freeze(['short', 'medium', 'long']);
const WRITE_POLICY = Object.freeze({
  formal_scoring_written: false,
  allocation_written: false,
  proposal_written: false,
  database_written: false,
  read_only_product_snapshot: true,
});

function legacyBucketForTerm(termDays) {
  const value = Number(termDays);
  if (!Number.isFinite(value)) return 'unknown';
  if (value <= 1) return 'cash';
  if (value <= 30) return 'short';
  if (value <= 100) return 'medium';
  return 'long';
}

function legacyProductRound4(value) {
  return Number(Number(value).toFixed(4));
}

function legacyReferenceYield(product) {
  const parts = [
    [Number.isFinite(product.return_3m) ? product.return_3m : null, 0.5],
    [Number.isFinite(product.return_6m) ? product.return_6m : null, 0.3],
    [Number.isFinite(product.return_1y) ? product.return_1y : null, 0.2],
  ].filter(([value]) => value !== null);
  if (!parts.length) return null;
  const weight = parts.reduce((sum, [, itemWeight]) => sum + itemWeight, 0);
  return legacyProductRound4(
    parts.reduce(
      (sum, [value, itemWeight]) => sum + value * itemWeight,
      0,
    ) / weight,
  );
}

function legacyWeightedYield(product) {
  if (
    !Number.isFinite(product.return_3m) ||
    !Number.isFinite(product.return_6m) ||
    !Number.isFinite(product.return_1y)
  ) {
    return null;
  }
  return legacyProductRound4(
    product.return_3m * 0.5 +
      product.return_6m * 0.3 +
      product.return_1y * 0.2,
  );
}

function legacyObservationScore(product) {
  const parts = [
    [Number.isFinite(product.return_3m) ? product.return_3m : null, 0.45],
    [Number.isFinite(product.return_6m) ? product.return_6m : null, 0.3],
    [Number.isFinite(product.return_1y) ? product.return_1y : null, 0.25],
  ].filter(([value]) => value !== null);
  if (!parts.length) return null;
  const weight = parts.reduce((sum, [, itemWeight]) => sum + itemWeight, 0);
  let score =
    parts.reduce(
      (sum, [value, itemWeight]) => sum + value * itemWeight,
      0,
    ) / weight;
  if (
    Number.isFinite(product.return_1m) &&
    Number.isFinite(product.return_3m) &&
    product.return_1m < product.return_3m - 0.5
  ) {
    score -= 0.08;
  }
  return legacyProductRound4(score);
}

function legacySelectionScore(product) {
  let score = legacyObservationScore(product);
  if (score === null) return null;
  if (Number.isFinite(product.return_1y) && Number.isFinite(product.return_6m)) {
    const gap = product.return_1y - product.return_6m;
    if (gap > 1) score -= Math.min(0.25, (gap - 1) * 0.15);
  }
  if (Number.isFinite(product.history_months)) {
    if (product.history_months >= 24) score += 0.03;
    else if (product.history_months >= 18) score += 0.015;
  }
  return legacyProductRound4(score);
}

function buildLegacyProductBaseline(product) {
  const bucket = legacyBucketForTerm(product.term_days);
  const evidenceTier = returnEvidenceTier(product);
  const evidenceScoring = EVIDENCE_POLICY[evidenceTier].scoring;
  return {
    bucket,
    evidence_tier: evidenceTier,
    evidence_scoring: evidenceScoring,
    observation_ready: evidenceScoring,
    reference_yield_pct: legacyReferenceYield(product),
    weighted_yield_pct: legacyWeightedYield(product),
    observation_score: legacyObservationScore(product),
    selection_score: legacySelectionScore(product),
  };
}

function bucketForTerm(termDays) {
  return policyBucketForTerm(termDays);
}

function calculateReferenceYield(bucket, returns = {}, options = {}) {
  return policyCalculateReferenceYield(returns, {
    ...options,
    bucket,
  });
}

function divergencePenalty(returns = {}) {
  return policyDivergencePenalty(returns);
}

function frontLoadDeduction(bucket, returns = {}, scheme) {
  return policyFrontLoadDeduction(bucket, returns, scheme);
}

function historyBonus(historyMonths) {
  return policyHistoryBonus(historyMonths);
}

function calculateShadowScore(
  product,
  bucket = bucketForTerm(product.term_days),
  options = {},
) {
  const reference = calculateReferenceYield(bucket, product, options);
  if (
    bucket === 'cash' ||
    bucket === 'unknown' ||
    reference.status !== 'available'
  ) {
    return {
      reference,
      observation_score: null,
      selection_scores: { A: null, B: null, C: null },
      divergence_penalty_points: 0,
      frontload_penalties_points: { A: 0, B: 0, C: 0 },
      history_bonus_points: 0,
    };
  }
  const divergence = divergencePenalty(product);
  const observationRaw = reference.raw_value_pct - divergence;
  const frontload = Object.fromEntries(
    SCHEMES.map((scheme) => [
      scheme,
      frontLoadDeduction(bucket, product, scheme),
    ]),
  );
  const bonus = historyBonus(product.history_months);
  const selectionScores = Object.fromEntries(
    SCHEMES.map((scheme) => [
      scheme,
      roundHalfAwayFromZero(
        observationRaw - frontload[scheme] + bonus,
      ),
    ]),
  );
  return {
    reference,
    observation_score: roundHalfAwayFromZero(observationRaw),
    selection_scores: selectionScores,
    divergence_penalty_points: divergence,
    frontload_penalties_points: frontload,
    history_bonus_points: bonus,
  };
}

function rankRows(rows, scheme) {
  for (const bucket of RANKING_BUCKETS) {
    const scoreKey =
      scheme === 'old' ? 'old_selection_score' : `selection_score_${scheme}`;
    const eligible = rows
      .filter((row) => {
        const bucketKey = scheme === 'old' ? 'old_bucket' : 'new_bucket';
        const candidateKey =
          scheme === 'old' ? 'old_ranking_candidate' : 'new_ranking_candidate';
        return row[candidateKey] && row[bucketKey] === bucket;
      })
      .sort(
        (a, b) =>
          (b[scoreKey] ?? -Infinity) - (a[scoreKey] ?? -Infinity) ||
          (b.return_3m ?? -Infinity) - (a.return_3m ?? -Infinity) ||
          (b.return_6m ?? -Infinity) - (a.return_6m ?? -Infinity) ||
          a.code.localeCompare(b.code),
      );
    eligible.forEach((row, index) => {
      row.ranking[scheme].rank = index + 1;
      row.ranking[scheme].top3 = index < 3;
    });
  }
}

function percentile(sortedValues, ratio) {
  if (!sortedValues.length) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * ratio) - 1),
  );
  return sortedValues[index];
}

function scoreDistribution(rows, getter) {
  const values = rows
    .map(getter)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  return {
    count: values.length,
    min: values[0] ?? null,
    p10: percentile(values, 0.1),
    median: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    max: values.at(-1) ?? null,
  };
}

function topRows(rows, scheme, bucket, limit = 3) {
  return rows
    .filter(
      (row) =>
        row.ranking[scheme].top3 &&
        (scheme === 'old' ? row.old_bucket : row.new_bucket) === bucket,
    )
    .sort((a, b) => a.ranking[scheme].rank - b.ranking[scheme].rank)
    .slice(0, limit)
    .map((row) => ({
      code: row.code,
      name: row.name,
      term_days: row.term_days,
      score:
        scheme === 'old'
          ? row.old_selection_score
          : row[`selection_score_${scheme}`],
      reference_yield_pct:
        scheme === 'old'
          ? row.old_reference_yield_pct
          : row.new_reference_yield_pct,
    }));
}

function differenceStats(rows, getter) {
  const values = rows
    .map(getter)
    .filter((value) => Number.isFinite(value));
  if (!values.length) {
    return {
      count: 0,
      positive: 0,
      negative: 0,
      unchanged: 0,
      min: null,
      median: null,
      max: null,
      max_abs: null,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    positive: values.filter((value) => value > 0.00005).length,
    negative: values.filter((value) => value < -0.00005).length,
    unchanged: values.filter((value) => Math.abs(value) <= 0.00005).length,
    min: sorted[0],
    median: percentile(sorted, 0.5),
    max: sorted.at(-1),
    max_abs: Math.max(...values.map((value) => Math.abs(value))),
  };
}

function buildProductShadowRow(product, oldProduct, options = {}) {
  const newBucket = bucketForTerm(product.term_days);
  const shadowScore = calculateShadowScore(product, newBucket, options);
  const oldBucket = oldProduct.bucket;
  const oldObservationReady = oldProduct.observation_ready === true;
  const oldRankingCandidate =
    oldObservationReady && RANKING_BUCKETS.includes(oldBucket);
  const newRankingCandidate =
    oldProduct.evidence_scoring === true &&
    shadowScore.reference.status === 'available' &&
    RANKING_BUCKETS.includes(newBucket);
  const row = {
    code: product.code,
    name: product.name,
    issuer: product.issuer,
    risk_level: product.risk_level,
    term_days: product.term_days,
    data_date: product.data_date,
    history_months: product.history_months,
    evidence_tier: oldProduct.evidence_tier,
    evidence_scoring: oldProduct.evidence_scoring,
    old_bucket: oldBucket,
    new_bucket: newBucket,
    bucket_changed: oldBucket !== newBucket,
    return_1m: product.return_1m,
    return_3m: product.return_3m,
    return_6m: product.return_6m,
    return_1y: product.return_1y,
    old_reference_yield_pct: oldProduct.reference_yield_pct,
    old_weighted_yield_pct: oldProduct.weighted_yield_pct,
    old_observation_score: oldProduct.observation_score,
    old_selection_score: oldProduct.selection_score,
    old_observation_ready: oldObservationReady,
    old_ranking_candidate: oldRankingCandidate,
    new_reference_yield_status: shadowScore.reference.status,
    new_reference_yield_reason: shadowScore.reference.reason,
    new_reference_yield_pct: shadowScore.reference.value_pct,
    new_weighted_yield_pct: shadowScore.reference.value_pct,
    new_available_horizons: shadowScore.reference.available_horizons,
    new_missing_horizons: shadowScore.reference.missing_horizons,
    new_weight_sum: shadowScore.reference.weight_sum,
    new_defined_weights: shadowScore.reference.defined_weights,
    new_normalized_weights: shadowScore.reference.normalized_weights,
    new_observation_score: shadowScore.observation_score,
    selection_score_A: shadowScore.selection_scores.A,
    selection_score_B: shadowScore.selection_scores.B,
    selection_score_C: shadowScore.selection_scores.C,
    divergence_penalty_points: shadowScore.divergence_penalty_points,
    frontload_penalty_A: shadowScore.frontload_penalties_points.A,
    frontload_penalty_B: shadowScore.frontload_penalties_points.B,
    frontload_penalty_C: shadowScore.frontload_penalties_points.C,
    history_bonus_points: shadowScore.history_bonus_points,
    new_ranking_candidate: newRankingCandidate,
    ranking_candidate_changed: oldRankingCandidate !== newRankingCandidate,
    scoring_candidate_changed: oldObservationReady !== newRankingCandidate,
    ranking: {
      old: { rank: null, top3: false },
      A: { rank: null, top3: false },
      B: { rank: null, top3: false },
      C: { rank: null, top3: false },
    },
  };
  row.reference_delta_pct =
    Number.isFinite(row.old_reference_yield_pct) &&
    Number.isFinite(row.new_reference_yield_pct)
      ? roundHalfAwayFromZero(
          row.new_reference_yield_pct - row.old_reference_yield_pct,
        )
      : null;
  row.observation_score_delta =
    Number.isFinite(row.old_observation_score) &&
    Number.isFinite(row.new_observation_score)
      ? roundHalfAwayFromZero(
          row.new_observation_score - row.old_observation_score,
        )
      : null;
  for (const scheme of SCHEMES) {
    const newScore = row[`selection_score_${scheme}`];
    row[`selection_score_delta_${scheme}`] =
      Number.isFinite(row.old_selection_score) && Number.isFinite(newScore)
        ? roundHalfAwayFromZero(newScore - row.old_selection_score)
        : null;
  }
  return row;
}

function buildSummary(rows) {
  const buckets = {};
  for (const bucket of RANKING_BUCKETS) {
    const rowsInBucket = rows.filter((row) => row.new_bucket === bucket);
    const rankingRowsInBucket = rowsInBucket.filter(
      (row) => row.new_ranking_candidate,
    );
    buckets[bucket] = {
      total: rowsInBucket.length,
      old_ranking_candidates: rowsInBucket.filter(
        (row) => row.old_ranking_candidate,
      ).length,
      new_ranking_candidates: rowsInBucket.filter(
        (row) => row.new_ranking_candidate,
      ).length,
      reference_status: {
        available: rowsInBucket.filter(
          (row) => row.new_reference_yield_status === 'available',
        ).length,
        unavailable: rowsInBucket.filter(
          (row) => row.new_reference_yield_status === 'unavailable',
        ).length,
      },
      reference_distribution: scoreDistribution(
        rowsInBucket,
        (row) => row.new_reference_yield_pct,
      ),
      score_distributions: {
        old: scoreDistribution(
          rankingRowsInBucket,
          (row) => row.old_selection_score,
        ),
        A: scoreDistribution(
          rankingRowsInBucket,
          (row) => row.selection_score_A,
        ),
        B: scoreDistribution(
          rankingRowsInBucket,
          (row) => row.selection_score_B,
        ),
        C: scoreDistribution(
          rankingRowsInBucket,
          (row) => row.selection_score_C,
        ),
      },
      top3: {
        old: topRows(rows, 'old', bucket),
        A: topRows(rows, 'A', bucket),
        B: topRows(rows, 'B', bucket),
        C: topRows(rows, 'C', bucket),
      },
    };
  }
  const removedCandidates = rows
    .filter((row) => row.old_observation_ready && !row.new_ranking_candidate)
    .map((row) => ({
      code: row.code,
      old_bucket: row.old_bucket,
      new_bucket: row.new_bucket,
      reason:
        row.new_bucket === 'cash'
          ? 'cash_excluded'
          : row.new_reference_yield_status !== 'available'
            ? row.new_reference_yield_reason
            : 'not_scoring_eligible',
    }));
  const enteredCandidates = rows
    .filter((row) => !row.old_observation_ready && row.new_ranking_candidate)
    .map((row) => ({
      code: row.code,
      old_bucket: row.old_bucket,
      new_bucket: row.new_bucket,
      reason:
        row.bucket_changed ? 'bucket_reclassified_to_scoring_bucket' : 'newly_eligible',
    }));
  const schemeSummary = {};
  const rankingRows = rows.filter((row) => row.new_ranking_candidate);
  for (const scheme of SCHEMES) {
    const rankChanges = rows.filter(
      (row) =>
        Number.isFinite(row.ranking.old.rank) &&
        Number.isFinite(row.ranking[scheme].rank) &&
        row.old_bucket === row.new_bucket &&
        row.ranking.old.rank !== row.ranking[scheme].rank,
    );
    const comparable = rows.filter(
      (row) =>
        Number.isFinite(row.ranking.old.rank) &&
        Number.isFinite(row.ranking[scheme].rank) &&
        row.old_bucket === row.new_bucket,
    );
    const oldTop3Codes = new Set(
      rows
        .filter((row) => row.ranking.old.top3)
        .map((row) => row.code),
    );
    const newTop3Codes = new Set(
      rows
        .filter((row) => row.ranking[scheme].top3)
        .map((row) => row.code),
    );
    schemeSummary[scheme] = {
      score_delta_vs_old: differenceStats(
        rankingRows,
        (row) => row[`selection_score_delta_${scheme}`],
      ),
      rank_changed: rankChanges.length,
      rank_improved: rankChanges.filter(
        (row) => row.ranking[scheme].rank < row.ranking.old.rank,
      ).length,
      rank_deteriorated: rankChanges.filter(
        (row) => row.ranking[scheme].rank > row.ranking.old.rank,
      ).length,
      comparable_rank_count: comparable.length,
      top3_overlap_with_old: [...oldTop3Codes].filter((code) =>
        newTop3Codes.has(code),
      ).length,
      top3_union_count: new Set([...oldTop3Codes, ...newTop3Codes]).size,
    };
  }
  const schemePairwise = {
    B_minus_A: differenceStats(
      rankingRows,
      (row) =>
        Number.isFinite(row.selection_score_A) &&
        Number.isFinite(row.selection_score_B)
          ? roundHalfAwayFromZero(
              row.selection_score_B - row.selection_score_A,
            )
          : null,
    ),
    C_minus_B: differenceStats(
      rankingRows,
      (row) =>
        Number.isFinite(row.selection_score_B) &&
        Number.isFinite(row.selection_score_C)
          ? roundHalfAwayFromZero(
              row.selection_score_C - row.selection_score_B,
            )
          : null,
    ),
    C_minus_A: differenceStats(
      rankingRows,
      (row) =>
        Number.isFinite(row.selection_score_A) &&
        Number.isFinite(row.selection_score_C)
          ? roundHalfAwayFromZero(
              row.selection_score_C - row.selection_score_A,
            )
          : null,
    ),
  };
  return {
    total_products: rows.length,
    old_observation_ready: rows.filter((row) => row.old_observation_ready)
      .length,
    old_ranking_candidates: rows.filter((row) => row.old_ranking_candidate)
      .length,
    new_ranking_candidates: rows.filter((row) => row.new_ranking_candidate)
      .length,
    bucket_transition_count: rows.filter((row) => row.bucket_changed).length,
    reference_status_counts: {
      available: rows.filter(
        (row) => row.new_reference_yield_status === 'available',
      ).length,
      unavailable: rows.filter(
        (row) => row.new_reference_yield_status === 'unavailable',
      ).length,
    },
    reference_delta_pct: differenceStats(
      rows,
      (row) => row.reference_delta_pct,
    ),
    candidate_changes: {
      removed_count: removedCandidates.length,
      entered_count: enteredCandidates.length,
      removed: removedCandidates.slice(0, 50),
      entered: enteredCandidates.slice(0, 50),
    },
    buckets,
    schemes: schemeSummary,
    scheme_pairwise: schemePairwise,
  };
}

function buildYieldShadowReport({
  products,
  source = null,
  generatedAt = new Date().toISOString(),
  bucketWeights = BUCKET_WEIGHTS,
} = {}) {
  if (!Array.isArray(products)) {
    throw new Error('影子计算需要产品数组');
  }
  const productsByCode = new Map(products.map((product) => [product.code, product]));
  const eligibleProducts = products
    .filter((product) => isProductPoolEligible(product))
    .sort(
      (a, b) =>
        (a.term_days ?? 9999) - (b.term_days ?? 9999) ||
        a.name.localeCompare(b.name, 'zh-CN'),
    );
  const rows = eligibleProducts.map((original) => {
    const legacy = buildLegacyProductBaseline(
      productsByCode.get(original.code),
    );
    return buildProductShadowRow(original, legacy, { bucketWeights });
  });
  rankRows(rows, 'old');
  for (const scheme of SCHEMES) rankRows(rows, scheme);
  for (const row of rows) {
    for (const scheme of SCHEMES) {
      row.ranking[scheme].rank_delta =
        row.old_bucket === row.new_bucket &&
        Number.isFinite(row.ranking.old.rank) &&
        Number.isFinite(row.ranking[scheme].rank)
          ? row.ranking.old.rank - row.ranking[scheme].rank
          : null;
    }
  }
  const snapshotDates = eligibleProducts
    .map((product) => product.data_date)
    .filter(Boolean)
    .sort();
  return {
    schema_version: 1,
    shadow_version: SHADOW_VERSION,
    generated_at: generatedAt,
    snapshot_date: snapshotDates.at(-1) || null,
    source,
    write_policy: WRITE_POLICY,
    rules: {
      yield_policy_version: POLICY_VERSION,
      selected_front_load_scheme: DEFAULT_FRONT_LOAD_SCHEME,
      old: {
        reference_weights: {
          return_3m: 0.5,
          return_6m: 0.3,
          return_1y: 0.2,
        },
        weighted_yield: {
          requires_all_horizons: true,
          weights: {
            return_3m: 0.5,
            return_6m: 0.3,
            return_1y: 0.2,
          },
        },
        observation_weights: {
          return_3m: 0.45,
          return_6m: 0.3,
          return_1y: 0.25,
        },
        divergence_threshold_pp: 0.5,
        divergence_penalty_points: 0.08,
        front_load: {
          threshold_pp: 1,
          slope: 0.15,
          cap: 0.25,
          applies_to: ['short', 'medium', 'long'],
        },
        history_bonus_points: {
          at_least_18_months: 0.015,
          at_least_24_months: 0.03,
        },
      },
      buckets: bucketWeights,
      front_load_schemes: FRONT_LOAD_SCHEMES,
      divergence_threshold_pp: 0.5,
      divergence_penalty_points: 0.08,
      history_bonus_points: {
        at_least_18_months: 0.015,
        at_least_24_months: 0.03,
      },
      rounding: {
        digits: 4,
        mode: 'half_away_from_zero',
      },
      weighted_yield_mode: 'alias_of_reference_yield',
      cash_policy:
        'display_only_no_score_no_rank_no_allocation_no_candidate_no_proposal',
    },
    summary: buildSummary(rows),
    rows,
  };
}

module.exports = {
  BUCKET_WEIGHTS,
  FRONT_LOAD_SCHEMES,
  HORIZON_LABELS,
  HORIZON_ORDER,
  RANKING_BUCKETS,
  SCHEMES,
  SHADOW_VERSION,
  WRITE_POLICY,
  bucketForTerm,
  buildYieldShadowReport,
  calculateReferenceYield,
  calculateShadowScore,
  divergencePenalty,
  frontLoadDeduction,
  historyBonus,
  roundHalfAwayFromZero,
};
