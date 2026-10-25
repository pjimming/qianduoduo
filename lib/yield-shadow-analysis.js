'use strict';

const { calculateSwitch } = require('./holdings-review');

const ANALYSIS_VERSION = 'td-yield-001-backtest-v1';
const SCHEMES = Object.freeze(['A', 'B', 'C']);
const BUCKETS = Object.freeze(['short', 'medium', 'long']);
const DIAGNOSTIC_THRESHOLDS = Object.freeze({
  score_outlier_iqr_multiplier: 3,
  large_score_shift_points: 2,
  high_top5_excess_share: 0.5,
  boundary_band_days: 4,
  boundary_min_sample_per_side: 5,
  cross_snapshot_reference_materiality_pp: 1,
  reference_change_tolerance_pp: 0.00005,
});
const DIAGNOSTIC_WRITE_POLICY = Object.freeze({
  formal_scoring_written: false,
  allocation_written: false,
  proposal_written: false,
  database_written: false,
});

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  const rounded =
    Math.floor(Math.abs(value) * factor + 0.5 + Number.EPSILON) / factor;
  return rounded === 0 ? 0 : Math.sign(value) * rounded;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
}

function scoreFor(row, scheme) {
  return scheme === 'old' ? row.old_selection_score : row[`selection_score_${scheme}`];
}

function rankFor(row, scheme) {
  return row.ranking?.[scheme]?.rank ?? null;
}

function top3For(row, scheme) {
  return row.ranking?.[scheme]?.top3 === true;
}

function bucketFor(row, scheme) {
  return scheme === 'old' ? row.old_bucket : row.new_bucket;
}

function scoreDistribution(rows, scheme) {
  const values = rows
    .map((row) => scoreFor(row, scheme))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return {
    count: values.length,
    min: values[0] ?? null,
    p10: percentile(values, 0.1),
    q1: percentile(values, 0.25),
    median: median(values),
    q3: percentile(values, 0.75),
    p90: percentile(values, 0.9),
    max: values.at(-1) ?? null,
  };
}

function spearman(rows, scheme) {
  const pairs = rows
    .map((row) => [rankFor(row, 'old'), rankFor(row, scheme)])
    .filter(([oldRank, newRank]) =>
      Number.isFinite(oldRank) && Number.isFinite(newRank),
    );
  if (pairs.length < 2) return null;
  const squaredDistance = pairs.reduce(
    (sum, [oldRank, newRank]) => sum + (newRank - oldRank) ** 2,
    0,
  );
  const n = pairs.length;
  return round(1 - (6 * squaredDistance) / (n * (n * n - 1)), 6);
}

function valueEquals(a, b, tolerance = DIAGNOSTIC_THRESHOLDS.reference_change_tolerance_pp) {
  if (a === null || a === undefined || b === null || b === undefined) {
    return a === b;
  }
  return Math.abs(Number(a) - Number(b)) <= tolerance;
}

function normalizedWeightSum(row) {
  return Object.values(row.new_normalized_weights || {}).reduce(
    (sum, value) => sum + Number(value || 0),
    0,
  );
}

function invariantChecks(report) {
  const failures = {
    non_finite_output: [],
    weighted_alias_mismatch: [],
    unavailable_with_numeric_value: [],
    available_without_numeric_value: [],
    normalized_weight_sum_mismatch: [],
    cash_score_leak: [],
    cash_ranking_leak: [],
    ranking_candidate_without_score: [],
    rank_sequence_mismatch: [],
  };
  for (const row of report.rows) {
    const numericFields = [
      row.new_reference_yield_pct,
      row.new_observation_score,
      row.selection_score_A,
      row.selection_score_B,
      row.selection_score_C,
    ];
    if (
      numericFields.some(
        (value) => value !== null && !Number.isFinite(value),
      )
    ) {
      failures.non_finite_output.push(row.code);
    }
    if (!valueEquals(row.new_weighted_yield_pct, row.new_reference_yield_pct)) {
      failures.weighted_alias_mismatch.push(row.code);
    }
    if (
      row.new_reference_yield_status === 'unavailable' &&
      row.new_reference_yield_pct !== null
    ) {
      failures.unavailable_with_numeric_value.push(row.code);
    }
    if (
      row.new_reference_yield_status === 'available' &&
      !Number.isFinite(row.new_reference_yield_pct)
    ) {
      failures.available_without_numeric_value.push(row.code);
    }
    if (
      row.new_reference_yield_status === 'available' &&
      Math.abs(normalizedWeightSum(row) - 1) > 1e-9
    ) {
      failures.normalized_weight_sum_mismatch.push(row.code);
    }
    if (
      row.new_bucket === 'cash' &&
      [
        row.new_observation_score,
        row.selection_score_A,
        row.selection_score_B,
        row.selection_score_C,
      ].some((value) => value !== null)
    ) {
      failures.cash_score_leak.push(row.code);
    }
    if (row.new_bucket === 'cash' && row.new_ranking_candidate) {
      failures.cash_ranking_leak.push(row.code);
    }
    if (
      row.new_ranking_candidate &&
      SCHEMES.some(
        (scheme) => !Number.isFinite(scoreFor(row, scheme)),
      )
    ) {
      failures.ranking_candidate_without_score.push(row.code);
    }
  }
  for (const scheme of ['old', ...SCHEMES]) {
    for (const bucket of BUCKETS) {
      const ranks = report.rows
        .filter((row) => bucketFor(row, scheme) === bucket)
        .filter((row) =>
          scheme === 'old'
            ? row.old_ranking_candidate
            : row.new_ranking_candidate,
        )
        .map((row) => rankFor(row, scheme))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const expected = Array.from(
        { length: ranks.length },
        (_, index) => index + 1,
      );
      if (JSON.stringify(ranks) !== JSON.stringify(expected)) {
        failures.rank_sequence_mismatch.push({ scheme, bucket, ranks });
      }
    }
  }
  const counts = Object.fromEntries(
    Object.entries(failures).map(([key, values]) => [key, values.length]),
  );
  return {
    passed: Object.values(counts).every((count) => count === 0),
    counts,
    failures,
  };
}

function missingWindows(report) {
  const allPatterns = new Map();
  const candidatePatterns = new Map();
  const add = (map, row) => {
    const key = [
      row.new_bucket,
      row.new_reference_yield_status,
      row.new_reference_yield_reason,
      row.new_available_horizons.join('+') || 'none',
    ].join('|');
    map.set(key, (map.get(key) || 0) + 1);
  };
  for (const row of report.rows) {
    add(allPatterns, row);
    if (row.new_ranking_candidate) add(candidatePatterns, row);
  }
  return {
    status_counts: {
      available: report.rows.filter(
        (row) => row.new_reference_yield_status === 'available',
      ).length,
      unavailable: report.rows.filter(
        (row) => row.new_reference_yield_status === 'unavailable',
      ).length,
    },
    reason_counts: Object.fromEntries(
      [...new Set(report.rows.map((row) => row.new_reference_yield_reason))].map(
        (reason) => [
          reason,
          report.rows.filter(
            (row) => row.new_reference_yield_reason === reason,
          ).length,
        ],
      ),
    ),
    all_patterns: Object.fromEntries(
      [...allPatterns.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
    candidate_patterns: Object.fromEntries(
      [...candidatePatterns.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

function rowContext(row) {
  return {
    code: row.code,
    name: row.name,
    term_days: row.term_days,
    bucket: row.new_bucket,
    evidence_tier: row.evidence_tier,
    return_1m: row.return_1m,
    return_3m: row.return_3m,
    return_6m: row.return_6m,
    return_1y: row.return_1y,
    available_horizons: row.new_available_horizons,
    normalized_weights: row.new_normalized_weights,
    old_reference_yield_pct: row.old_reference_yield_pct,
    new_reference_yield_pct: row.new_reference_yield_pct,
    old_selection_score: row.old_selection_score,
    selection_score_A: row.selection_score_A,
    selection_score_B: row.selection_score_B,
    selection_score_C: row.selection_score_C,
    divergence_penalty_points: row.divergence_penalty_points,
    frontload_penalties_points: {
      A: row.frontload_penalty_A,
      B: row.frontload_penalty_B,
      C: row.frontload_penalty_C,
    },
    history_bonus_points: row.history_bonus_points,
    rank_old: row.ranking.old.rank,
    ranks: {
      A: row.ranking.A.rank,
      B: row.ranking.B.rank,
      C: row.ranking.C.rank,
    },
  };
}

function scoreDiagnostics(report, bucket, scoreScheme = 'A') {
  if (!SCHEMES.includes(scoreScheme)) {
    throw new Error(`不支持的评分方案：${scoreScheme}`);
  }
  const rows = report.rows.filter(
    (row) => row.new_bucket === bucket && row.new_ranking_candidate,
  );
  const scores = rows
    .map((row) => scoreFor(row, scoreScheme))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const q1 = percentile(scores, 0.25);
  const q3 = percentile(scores, 0.75);
  const iqr = q3 === null || q1 === null ? null : q3 - q1;
  const outlierThreshold =
    q3 === null || iqr === null
      ? null
      : q3 + iqr * DIAGNOSTIC_THRESHOLDS.score_outlier_iqr_multiplier;
  const outliers =
    outlierThreshold === null
      ? []
      : rows
          .filter((row) => scoreFor(row, scoreScheme) > outlierThreshold)
          .sort(
            (a, b) =>
              scoreFor(b, scoreScheme) - scoreFor(a, scoreScheme),
          )
          .map((row) => rowContext(row));
  const medianScore = median(scores);
  const excess =
    medianScore === null
      ? []
      : rows
          .map((row) =>
            Math.max(0, scoreFor(row, scoreScheme) - medianScore),
          )
          .sort((a, b) => b - a);
  const totalExcess = excess.reduce((sum, value) => sum + value, 0);
  const top5Count = Math.max(1, Math.ceil(rows.length * 0.05));
  const top5ExcessShare =
    totalExcess > 0
      ? round(
          excess
            .slice(0, top5Count)
            .reduce((sum, value) => sum + value, 0) / totalExcess,
          6,
        )
      : null;
  return {
    bucket,
    score_scheme: scoreScheme,
    candidate_count: rows.length,
    distributions: Object.fromEntries(
      ['old', ...SCHEMES].map((scheme) => [
        scheme,
        scoreDistribution(rows, scheme),
      ]),
    ),
    spearman_vs_old: Object.fromEntries(
      SCHEMES.map((scheme) => [scheme, spearman(rows, scheme)]),
    ),
    outlier_threshold: outlierThreshold,
    outliers,
    top5_excess_count: top5Count,
    top5_excess_share: top5ExcessShare,
    high_concentration:
      top5ExcessShare !== null &&
      top5ExcessShare > DIAGNOSTIC_THRESHOLDS.high_top5_excess_share,
  };
}

function top3Changes(report, bucket, scheme) {
  const oldTop = report.summary.buckets[bucket].top3.old;
  const newTop = report.summary.buckets[bucket].top3[scheme];
  const oldCodes = new Set(oldTop.map((item) => item.code));
  const newCodes = new Set(newTop.map((item) => item.code));
  const rowByCode = new Map(
    report.rows
      .filter((row) => row.new_bucket === bucket)
      .map((row) => [row.code, row]),
  );
  const enrich = (item) => {
    const row = rowByCode.get(item.code);
    return {
      ...item,
      context: row
        ? {
            ...rowContext(row),
            score_delta_A: row.selection_score_delta_A,
            score_delta_B: row.selection_score_delta_B,
            score_delta_C: row.selection_score_delta_C,
          }
        : null,
    };
  };
  return {
    old: oldTop,
    [scheme]: newTop,
    entered: newTop
      .filter((item) => !oldCodes.has(item.code))
      .map(enrich),
    exited: oldTop
      .filter((item) => !newCodes.has(item.code))
      .map(enrich),
  };
}

function rankDiagnostics(report, bucket) {
  const rows = report.rows.filter((row) => row.new_bucket === bucket);
  const result = {};
  for (const scheme of SCHEMES) {
    const comparable = rows.filter(
      (row) =>
        Number.isFinite(rankFor(row, 'old')) &&
        Number.isFinite(rankFor(row, scheme)),
    );
    const changes = comparable
      .map((row) => ({
        code: row.code,
        name: row.name,
        delta: rankFor(row, 'old') - rankFor(row, scheme),
        old_rank: rankFor(row, 'old'),
        new_rank: rankFor(row, scheme),
      }))
      .filter((item) => item.delta !== 0)
      .sort(
        (a, b) =>
          Math.abs(b.delta) - Math.abs(a.delta) ||
          a.code.localeCompare(b.code),
      );
    result[scheme] = {
      comparable_count: comparable.length,
      changed_count: changes.length,
      changed_ratio:
        comparable.length > 0 ? round(changes.length / comparable.length, 6) : null,
      mean_absolute_change:
        changes.length > 0
          ? round(
              changes.reduce((sum, item) => sum + Math.abs(item.delta), 0) /
                changes.length,
              4,
            )
          : 0,
      max_absolute_change:
        changes.length > 0
          ? Math.max(...changes.map((item) => Math.abs(item.delta)))
          : 0,
      largest_movers: changes.slice(0, 10),
      top3_changes: top3Changes(report, bucket, scheme),
    };
  }
  return result;
}

function boundaryDiagnostics(report, scoreScheme = 'A') {
  if (!SCHEMES.includes(scoreScheme)) {
    throw new Error(`不支持的评分方案：${scoreScheme}`);
  }
  const exactTerms = [0, 1, 30, 31, 100, 101];
  const exact = Object.fromEntries(
    exactTerms.map((term) => [
      String(term),
      {
        all_products: report.rows.filter((row) => row.term_days === term).length,
        ranking_candidates: report.rows.filter(
          (row) => row.term_days === term && row.new_ranking_candidate,
        ).length,
      },
    ]),
  );
  const band = DIAGNOSTIC_THRESHOLDS.boundary_band_days;
  const bands = [
    { boundary: 30, lower: [30 - band, 30], upper: [31, 31 + band] },
    { boundary: 100, lower: [100 - band, 100], upper: [101, 101 + band] },
  ].map((item) => {
    const lowerRows = report.rows.filter(
      (row) =>
        row.term_days >= item.lower[0] &&
        row.term_days <= item.lower[1] &&
        row.new_ranking_candidate,
    );
    const upperRows = report.rows.filter(
      (row) =>
        row.term_days >= item.upper[0] &&
        row.term_days <= item.upper[1] &&
        row.new_ranking_candidate,
    );
    return {
      boundary: item.boundary,
      lower_range: item.lower,
      upper_range: item.upper,
      lower_count: lowerRows.length,
      upper_count: upperRows.length,
      lower_reference_median: median(
        lowerRows.map((row) => row.new_reference_yield_pct).filter(Number.isFinite),
      ),
      upper_reference_median: median(
        upperRows.map((row) => row.new_reference_yield_pct).filter(Number.isFinite),
      ),
      lower_score_median: median(
        lowerRows
          .map((row) => scoreFor(row, scoreScheme))
          .filter(Number.isFinite),
      ),
      upper_score_median: median(
        upperRows
          .map((row) => scoreFor(row, scoreScheme))
          .filter(Number.isFinite),
      ),
      empirical_sample_sufficient:
        lowerRows.length >= DIAGNOSTIC_THRESHOLDS.boundary_min_sample_per_side &&
        upperRows.length >= DIAGNOSTIC_THRESHOLDS.boundary_min_sample_per_side,
    };
  });
  return {
    score_scheme: scoreScheme,
    exact_term_counts: exact,
    bands,
    bucket_transition_count: report.summary.bucket_transition_count,
  };
}

function analyzeSnapshot(report, metadata = {}) {
  const scoreScheme = metadata.scoreScheme || metadata.score_scheme || 'A';
  if (!SCHEMES.includes(scoreScheme)) {
    throw new Error(`不支持的评分方案：${scoreScheme}`);
  }
  const candidateRows = report.rows.filter((row) => row.new_ranking_candidate);
  return {
    label: metadata.label || report.source?.file_name || 'snapshot',
    source: report.source,
    snapshot_date: report.snapshot_date,
    generated_at: report.generated_at,
    score_scheme: scoreScheme,
    counts: {
      products: report.rows.length,
      old_observation_ready: report.summary.old_observation_ready,
      old_ranking_candidates: report.summary.old_ranking_candidates,
      new_ranking_candidates: report.summary.new_ranking_candidates,
      candidate_removed: report.summary.candidate_changes.removed_count,
      candidate_entered: report.summary.candidate_changes.entered_count,
      bucket_transitions: report.summary.bucket_transition_count,
    },
    bucket_counts: Object.fromEntries(
      ['cash', ...BUCKETS, 'unknown'].map((bucket) => [
        bucket,
        report.rows.filter((row) => row.new_bucket === bucket).length,
      ]),
    ),
    evidence_counts: Object.fromEntries(
      [...new Set(report.rows.map((row) => row.evidence_tier))].map((tier) => [
        tier,
        report.rows.filter((row) => row.evidence_tier === tier).length,
      ]),
    ),
    invariants: invariantChecks(report),
    missing_windows: missingWindows(report),
    buckets: Object.fromEntries(
      BUCKETS.map((bucket) => [
        bucket,
        {
          scores: scoreDiagnostics(report, bucket, scoreScheme),
          ranks: rankDiagnostics(report, bucket),
        },
      ]),
    ),
    large_score_shifts: candidateRows
      .filter(
        (row) =>
          Number.isFinite(row.selection_score_delta_A) &&
          Math.abs(row.selection_score_delta_A) >=
            DIAGNOSTIC_THRESHOLDS.large_score_shift_points,
      )
      .sort(
        (a, b) =>
          Math.abs(b.selection_score_delta_A) -
          Math.abs(a.selection_score_delta_A),
      )
      .map((row) => ({
        ...rowContext(row),
        score_delta_A: row.selection_score_delta_A,
        score_delta_B: row.selection_score_delta_B,
        score_delta_C: row.selection_score_delta_C,
      })),
    boundary: boundaryDiagnostics(report, scoreScheme),
    scheme_summary: report.summary.schemes,
    scheme_pairwise: report.summary.scheme_pairwise,
  };
}

function compareSnapshots(previous, current) {
  const previousByCode = new Map(
    previous.report.rows.map((row) => [row.code, row]),
  );
  const currentByCode = new Map(
    current.report.rows.map((row) => [row.code, row]),
  );
  const previousCodes = new Set(previousByCode.keys());
  const currentCodes = new Set(currentByCode.keys());
  const commonCodes = [...previousCodes]
    .filter((code) => currentCodes.has(code))
    .sort();
  const commonRows = commonCodes.map((code) => ({
    previous: previousByCode.get(code),
    current: currentByCode.get(code),
  }));
  const commonReferenceRows = commonRows.filter(
    ({ previous: a, current: b }) =>
      Number.isFinite(a.new_reference_yield_pct) &&
      Number.isFinite(b.new_reference_yield_pct),
  );
  const referenceDeltas = commonReferenceRows.map(
    ({ previous: a, current: b }) =>
      b.new_reference_yield_pct - a.new_reference_yield_pct,
  );
  const comparableRanks = commonRows.filter(
    ({ previous: a, current: b }) =>
      a.new_bucket === b.new_bucket &&
      Number.isFinite(a.ranking.A.rank) &&
      Number.isFinite(b.ranking.A.rank),
  );
  const sameDataDate = previous.report.snapshot_date === current.report.snapshot_date;
  const maxReferenceDelta =
    referenceDeltas.length > 0
      ? Math.max(...referenceDeltas.map((value) => Math.abs(value)))
      : null;
  return {
    from: previous.label,
    to: current.label,
    from_data_date: previous.report.snapshot_date,
    to_data_date: current.report.snapshot_date,
    same_data_date: sameDataDate,
    common_codes: commonCodes.length,
    added_codes: currentCodes.size - commonCodes.length,
    removed_codes: previousCodes.size - commonCodes.length,
    added_ranking_candidates: [...currentCodes].filter(
      (code) =>
        !previousCodes.has(code) &&
        currentByCode.get(code).new_ranking_candidate,
    ).length,
    removed_ranking_candidates: [...previousCodes].filter(
      (code) =>
        !currentCodes.has(code) &&
        previousByCode.get(code).new_ranking_candidate,
    ).length,
    common_reference_comparable: referenceDeltas.length,
    common_reference_mean_delta:
      referenceDeltas.length > 0
        ? round(
            referenceDeltas.reduce((sum, value) => sum + value, 0) /
              referenceDeltas.length,
          )
        : null,
    common_reference_max_abs_delta:
      maxReferenceDelta === null ? null : round(maxReferenceDelta),
    common_comparable_ranks: comparableRanks.length,
    common_rank_changed: comparableRanks.filter(
      ({ previous: a, current: b }) => a.ranking.A.rank !== b.ranking.A.rank,
    ).length,
    interpretation:
      sameDataDate &&
      maxReferenceDelta !== null &&
      maxReferenceDelta <= DIAGNOSTIC_THRESHOLDS.reference_change_tolerance_pp
        ? 'same_product_data_with_universe_expansion'
        : 'data_refresh_and_universe_change',
  };
}

function projectedCandidateVerdict({
  currentYieldPct,
  newYieldPct,
  amount,
  horizonDays,
  setting,
  candidate,
}) {
  if (!Number.isFinite(currentYieldPct) || !Number.isFinite(newYieldPct)) {
    return {
      verdict: 'watch',
      yieldGapPp: null,
      result: null,
    };
  }
  const yieldGapPp = round(newYieldPct - currentYieldPct);
  const result = calculateSwitch({
    amount,
    currentYieldPct,
    horizonDays,
    redemptionFeeBps: setting?.redemption_fee_bps || 0,
    switchWaitDays: candidate.switch_wait_days || 0,
    newYieldPct,
    purchaseFeeBps: setting?.purchase_fee_bps || 0,
  });
  let verdict = 'watch';
  if (yieldGapPp < 0.15) verdict = 'hold';
  else if (result.new_days <= 0) verdict = 'watch';
  else if (result.difference < candidate.min_gain_amount) verdict = 'watch';
  else if (
    result.break_even_yield_pct !== null &&
    newYieldPct <= result.break_even_yield_pct + 0.05
  ) {
    verdict = 'watch';
  } else if (
    Number.isFinite(candidate.evidence_single_cap_amount) &&
    amount > candidate.evidence_single_cap_amount + 0.01
  ) {
    verdict = 'watch';
  } else {
    verdict = 'replace';
  }
  return { verdict, yieldGapPp, result };
}

function analyzeProductionConsistency(report, dashboard) {
  if (!dashboard?.workspace?.holding_reviews) {
    return {
      status: 'not_checked',
      reason: '正式 Dashboard 未提供持仓复核',
    };
  }
  const shadowByCode = new Map(report.rows.map((row) => [row.code, row]));
  const currentYields = [];
  const candidateYields = [];
  const verdictChanges = [];
  for (const review of dashboard.workspace.holding_reviews) {
    const currentRow = shadowByCode.get(review.product_code);
    const shadowCurrentYield = currentRow?.new_reference_yield_pct ?? null;
    currentYields.push({
      code: review.product_code,
      name: review.product_name,
      bucket: currentRow?.new_bucket || null,
      current_yield_pct: review.current?.yield_pct ?? null,
      shadow_reference_yield_pct: shadowCurrentYield,
      changed: !valueEquals(
        review.current?.yield_pct ?? null,
        shadowCurrentYield,
      ),
    });
    for (const candidate of review.candidates || []) {
      const candidateRow = shadowByCode.get(candidate.code);
      const shadowYield = candidateRow?.new_reference_yield_pct ?? null;
      const projection = projectedCandidateVerdict({
        currentYieldPct: shadowCurrentYield,
        newYieldPct: shadowYield,
        amount: review.amount,
        horizonDays: review.horizon_days,
        setting: review.review_setting,
        candidate,
      });
      const yieldChanged = !valueEquals(candidate.yield_pct, shadowYield);
      candidateYields.push({
        holding_code: review.product_code,
        code: candidate.code,
        name: candidate.name,
        current_yield_pct: candidate.yield_pct,
        shadow_reference_yield_pct: shadowYield,
        changed: yieldChanged,
        old_verdict: candidate.verdict,
        shadow_verdict: projection.verdict,
        old_yield_gap_pp: candidate.yield_gap_pp,
        shadow_yield_gap_pp: projection.yieldGapPp,
      });
      if (projection.verdict !== candidate.verdict) {
        verdictChanges.push({
          holding_code: review.product_code,
          candidate_code: candidate.code,
          candidate_name: candidate.name,
          old_verdict: candidate.verdict,
          shadow_verdict: projection.verdict,
          old_candidate_yield_pct: candidate.yield_pct,
          shadow_candidate_yield_pct: shadowYield,
          old_current_yield_pct: review.current?.yield_pct ?? null,
          shadow_current_yield_pct: shadowCurrentYield,
          old_yield_gap_pp: candidate.yield_gap_pp,
          shadow_yield_gap_pp: projection.yieldGapPp,
        });
      }
    }
  }
  return {
    status: 'projection_only_not_integrated',
    production_snapshot_date: dashboard.meta?.product_snapshot_date || null,
    formal_attribution: dashboard.workspace?.return_attribution
      ? {
          status: dashboard.workspace.return_attribution.status,
          reference_yield_coverage_pct:
            dashboard.workspace.return_attribution.product_evidence
              ?.reference_yield_coverage_pct ?? null,
          product_evidence_count:
            dashboard.workspace.return_attribution.product_evidence?.products
              ?.length ?? 0,
        }
      : null,
    formal_proposals: dashboard.decision_proposals
      ? {
          pending_count: dashboard.decision_proposals.pending?.length ?? 0,
          accepted_count: dashboard.decision_proposals.accepted?.length ?? 0,
          executed_count: dashboard.decision_proposals.executed?.length ?? 0,
        }
      : null,
    current_holdings: currentYields,
    current_yield_changed_count: currentYields.filter((row) => row.changed).length,
    candidates: candidateYields,
    candidate_yield_changed_count: candidateYields.filter((row) => row.changed)
      .length,
    candidate_count: candidateYields.length,
    verdict_changes: verdictChanges,
    verdict_changed_count: verdictChanges.length,
  };
}

function issueId(kind, snapshot, bucket, code) {
  return [kind, snapshot || 'all', bucket || 'all', code || 'all']
    .join(':')
    .replaceAll(/\s+/g, '_');
}

function explanationForShift(row) {
  const windows = row.available_horizons.join('+') || 'none';
  const weights = Object.entries(row.normalized_weights)
    .map(([key, value]) => `${key}=${round(value, 4)}`)
    .join(', ');
  return (
    `旧固定口径 ${row.old_reference_yield_pct ?? '不可计算'}% 改为 ` +
    `${row.bucket} 桶权重后为 ${row.new_reference_yield_pct}%；` +
    `可用窗口 ${windows}，归一化权重 ${weights || '无'}。`
  );
}

function buildAnomalyRegister(snapshotAnalyses, transitions, production) {
  const anomalies = [];
  for (const snapshot of snapshotAnalyses) {
    for (const bucket of BUCKETS) {
      const scores = snapshot.buckets[bucket].scores;
      if (scores.high_concentration) {
        anomalies.push({
          id: issueId('high_score_concentration', snapshot.snapshot_date, bucket),
          kind: 'high_score_concentration',
          severity: 'medium',
          snapshot: snapshot.label,
          bucket,
          summary:
            `${bucket} 桶前 5% 候选贡献了 ${(scores.top5_excess_share * 100).toFixed(1)}% 的中位数以上正超额。`,
          attribution:
            '高分集中于少数高收益窗口产品，必须结合证据档位与单只上限解释，不能视为稳定收益。',
        });
      }
      for (const outlier of scores.outliers) {
        anomalies.push({
          id: issueId('score_outlier', snapshot.snapshot_date, bucket, outlier.code),
          kind: 'score_outlier',
          severity: outlier.evidence_tier === 'full_1y' ? 'medium' : 'high',
          snapshot: snapshot.label,
          bucket,
          code: outlier.code,
          summary:
            `${outlier.name} 新选择评分 ${outlier.selection_score_A}，` +
            `高于 ${bucket} 桶异常阈值 ${round(scores.outlier_threshold)}。`,
          attribution: explanationForShift(outlier),
          evidence_tier: outlier.evidence_tier,
          available_horizons: outlier.available_horizons,
        });
      }
      for (const scheme of SCHEMES) {
        const changes = snapshot.buckets[bucket].ranks[scheme].top3_changes;
        if (!changes.entered.length && !changes.exited.length) continue;
        anomalies.push({
          id: issueId('top3_change', snapshot.snapshot_date, bucket, scheme),
          kind: 'top3_change',
          severity: 'info',
          snapshot: snapshot.label,
          bucket,
          scheme,
          summary:
            `${scheme} 方案前三进入 ${changes.entered.map((item) => item.code).join(', ') || '无'}；` +
            `退出 ${changes.exited.map((item) => item.code).join(', ') || '无'}。`,
          attribution: changes.entered
            .map((entered) =>
              entered.context
                ? `${entered.code}：旧排名 ${entered.context.rank_old}、` +
                  `${scheme} 排名 ${entered.context.ranks[scheme]}；` +
                  explanationForShift(entered.context)
                : `${entered.code}：排名进入前三，但缺少完整行级上下文。`,
            )
            .join('；'),
        });
      }
    }
    for (const shift of snapshot.large_score_shifts) {
      anomalies.push({
        id: issueId(
          'large_score_shift',
          snapshot.snapshot_date,
          shift.bucket,
          shift.code,
        ),
        kind: 'large_score_shift',
        severity: 'medium',
        snapshot: snapshot.label,
        bucket: shift.bucket,
        code: shift.code,
        summary:
          `${shift.name} 的 A 方案选择评分变化 ${shift.score_delta_A >= 0 ? '+' : ''}` +
          `${shift.score_delta_A}，旧排名 ${shift.rank_old}、新排名 ${shift.ranks.A}。`,
        attribution: explanationForShift(shift),
      });
    }
    for (const band of snapshot.boundary.bands) {
      if (band.empirical_sample_sufficient) continue;
      anomalies.push({
        id: issueId(
          'boundary_sample_insufficient',
          snapshot.snapshot_date,
          String(band.boundary),
        ),
        kind: 'boundary_sample_insufficient',
        severity: 'info',
        snapshot: snapshot.label,
        summary:
          `${band.boundary} 天边界两侧 4 天带宽样本为 ` +
          `${band.lower_count}/${band.upper_count}，无法做经验分布稳定性检验。`,
        attribution:
          '当前产品期限集中在 30、90、180 天；边界分类由契约测试验证，但不能用现有快照证明两侧收益分布连续。',
      });
    }
  }
  for (const transition of transitions) {
    anomalies.push({
      id: issueId(
        'snapshot_transition',
        `${transition.from}_to_${transition.to}`,
      ),
      kind: 'snapshot_transition',
      severity:
        transition.common_reference_max_abs_delta !== null &&
        transition.common_reference_max_abs_delta >=
          DIAGNOSTIC_THRESHOLDS.cross_snapshot_reference_materiality_pp
          ? 'medium'
          : 'info',
      summary:
        `${transition.from} → ${transition.to}：新增 ${transition.added_codes}、` +
        `移除 ${transition.removed_codes}、新增排名候选 ${transition.added_ranking_candidates}；` +
        `共同产品参考年化最大变化 ${transition.common_reference_max_abs_delta}pp。`,
      attribution:
        transition.interpretation ===
        'same_product_data_with_universe_expansion'
          ? '两次文件共用同一产品数据日，共同产品参考年化未变；排名变化来自产品全集扩张。'
          : '产品数据日或共同产品收益快照发生变化，同时伴随产品集合增删。',
    });
  }
  if (production.status === 'projection_only_not_integrated') {
    anomalies.push({
      id: issueId('cross_module_projection'),
      kind: 'cross_module_projection',
      severity: 'medium',
      summary:
        `正式持仓复核仍使用旧参考年化：${production.candidate_count} 个候选中 ` +
        `${production.candidate_yield_changed_count} 个口径不同，投影会造成 ` +
        `${production.verdict_changed_count} 个候选结论变化。`,
      attribution:
        '这是阶段 2 尚未接入正式模块的预期状态；阶段 5 必须在产品、持仓复核、归因和提案中统一后再放行。',
      verdict_changes: production.verdict_changes,
    });
  }
  return {
    counts_by_severity: {
      high: anomalies.filter((item) => item.severity === 'high').length,
      medium: anomalies.filter((item) => item.severity === 'medium').length,
      info: anomalies.filter((item) => item.severity === 'info').length,
    },
    counts_by_kind: Object.fromEntries(
      [...new Set(anomalies.map((item) => item.kind))].map((kind) => [
        kind,
        anomalies.filter((item) => item.kind === kind).length,
      ]),
    ),
    items: anomalies,
  };
}

function buildShadowBacktestReport({
  snapshots,
  productionDashboard = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) {
    throw new Error('影子回测至少需要两个产品快照');
  }
  for (const item of snapshots) {
    if (!item?.report?.rows) {
      throw new Error('影子回测快照缺少 report');
    }
  }
  const analyses = snapshots.map((item) =>
    analyzeSnapshot(item.report, {
      label: item.label,
      source: item.report.source,
    }),
  );
  const transitions = [];
  for (let index = 1; index < snapshots.length; index += 1) {
    transitions.push(
      compareSnapshots(snapshots[index - 1], snapshots[index]),
    );
  }
  const current = snapshots.at(-1);
  const production = analyzeProductionConsistency(
    current.report,
    productionDashboard,
  );
  const anomalies = buildAnomalyRegister(analyses, transitions, production);
  return {
    schema_version: 1,
    analysis_version: ANALYSIS_VERSION,
    generated_at: generatedAt,
    diagnostic_thresholds: DIAGNOSTIC_THRESHOLDS,
    write_policy: DIAGNOSTIC_WRITE_POLICY,
    overall_status:
      anomalies.counts_by_severity.high > 0 ? 'review_required' : 'reviewable',
    snapshot_count: snapshots.length,
    snapshots: analyses,
    transitions,
    production_projection: production,
    anomalies,
    conclusion:
      '阶段 3 只完成回测诊断与归因，不选择 A/B/C 最终方案，也不修改正式计算路径。',
  };
}

module.exports = {
  ANALYSIS_VERSION,
  DIAGNOSTIC_THRESHOLDS,
  DIAGNOSTIC_WRITE_POLICY,
  analyzeProductionConsistency,
  analyzeSnapshot,
  buildShadowBacktestReport,
  compareSnapshots,
  projectedCandidateVerdict,
};
