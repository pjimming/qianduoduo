'use strict';

const {
  BUCKET_WEIGHTS,
  buildYieldShadowReport,
} = require('./yield-shadow');
const {
  DIAGNOSTIC_THRESHOLDS,
  analyzeProductionConsistency,
} = require('./yield-shadow-analysis');

const REVIEW_VERSION = 'td-yield-001-parameter-review-v1';
const SHORT_WEIGHT_OPTIONS = Object.freeze({
  original_50_30_20: Object.freeze({
    return_1m: 0.5,
    return_3m: 0.3,
    return_6m: 0.2,
  }),
  balanced_30_50_20: Object.freeze({
    return_1m: 0.3,
    return_3m: 0.5,
    return_6m: 0.2,
  }),
  selected_20_50_30: Object.freeze({
    return_1m: 0.2,
    return_3m: 0.5,
    return_6m: 0.3,
  }),
  low_1m_10_50_40: Object.freeze({
    return_1m: 0.1,
    return_3m: 0.5,
    return_6m: 0.4,
  }),
  no_1m_0_50_50: Object.freeze({
    return_1m: 0,
    return_3m: 0.5,
    return_6m: 0.5,
  }),
});
const SELECTED_SHORT_VARIANT = 'selected_20_50_30';
const SELECTED_LONG_SCHEME = 'B';
const SELECTED_BUCKET_WEIGHTS = Object.freeze({
  cash: BUCKET_WEIGHTS.cash,
  short: SHORT_WEIGHT_OPTIONS[SELECTED_SHORT_VARIANT],
  medium: BUCKET_WEIGHTS.medium,
  long: BUCKET_WEIGHTS.long,
});
const REVIEW_POLICY = Object.freeze({
  short_one_month_min_weight: 0.2,
  short_one_month_max_weight: 0.3,
  short_three_month_min_weight: 0.5,
  long_requires_same_top3_as_A: true,
  long_prefer_lower_average_rank_churn: true,
  formal_path_change_authorized: false,
});
const REVIEW_WRITE_POLICY = Object.freeze({
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

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(sorted.length * ratio) - 1),
    )
  ];
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function spearman(rows, scheme) {
  const pairs = rows
    .map((row) => [row.ranking.old.rank, row.ranking[scheme].rank])
    .filter(([oldRank, newRank]) =>
      Number.isFinite(oldRank) && Number.isFinite(newRank),
    );
  if (pairs.length < 2) return null;
  const distance = pairs.reduce(
    (sum, [oldRank, newRank]) => sum + (newRank - oldRank) ** 2,
    0,
  );
  return round(
    1 - (6 * distance) / (pairs.length * (pairs.length ** 2 - 1)),
    6,
  );
}

function shortMetrics(report, scheme = SELECTED_LONG_SCHEME) {
  const scoreKey = `selection_score_${scheme}`;
  const rows = report.rows.filter(
    (row) => row.new_bucket === 'short' && row.new_ranking_candidate,
  );
  const scores = rows
    .map((row) => row[scoreKey])
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const q1 = percentile(scores, 0.25);
  const q3 = percentile(scores, 0.75);
  const outlierThreshold =
    q1 !== null && q3 !== null
      ? q3 +
        (q3 - q1) * DIAGNOSTIC_THRESHOLDS.score_outlier_iqr_multiplier
      : null;
  const outlierCount =
    outlierThreshold === null
      ? 0
      : rows.filter((row) => row[scoreKey] > outlierThreshold).length;
  const medianScore = median(scores);
  const excess =
    medianScore === null
      ? []
      : rows
          .map((row) => Math.max(0, row[scoreKey] - medianScore))
          .sort((a, b) => b - a);
  const totalExcess = excess.reduce((sum, value) => sum + value, 0);
  const top5Count = Math.max(1, Math.ceil(rows.length * 0.05));
  const top5Share =
    totalExcess > 0
      ? excess
          .slice(0, top5Count)
          .reduce((sum, value) => sum + value, 0) / totalExcess
      : null;
  const rankChanged = rows.filter(
    (row) =>
      Number.isFinite(row.ranking.old.rank) &&
      Number.isFinite(row.ranking[scheme].rank) &&
      row.ranking.old.rank !== row.ranking[scheme].rank,
  ).length;
  const comparable = rows.filter(
    (row) =>
      Number.isFinite(row.ranking.old.rank) &&
      Number.isFinite(row.ranking[scheme].rank),
  ).length;
  const oldTop3 = new Set(
    report.summary.buckets.short.top3.old.map((item) => item.code),
  );
  const newTop3 = report.summary.buckets.short.top3[scheme];
  return {
    snapshot: report.snapshot_date,
    source: report.source?.file_name || null,
    candidate_count: rows.length,
    max_score: scores.at(-1) ?? null,
    median_score: medianScore,
    outlier_count: outlierCount,
    outlier_threshold: outlierThreshold,
    top5_excess_share:
      top5Share === null ? null : round(top5Share, 6),
    spearman_vs_old: spearman(rows, scheme),
    rank_changed: rankChanged,
    comparable_rank_count: comparable,
    rank_changed_ratio:
      comparable > 0 ? round(rankChanged / comparable, 6) : null,
    mean_absolute_score_delta: round(
      mean(
        rows
          .map((row) => row[`selection_score_delta_${scheme}`])
          .filter(Number.isFinite),
      ) === null
        ? null
        : mean(
            rows
              .map((row) => Math.abs(row[`selection_score_delta_${scheme}`]))
              .filter(Number.isFinite),
          ),
    ),
    top3_same_as_old:
      newTop3.length === oldTop3.size &&
      newTop3.every((item) => oldTop3.has(item.code)),
    top3_codes: newTop3.map((item) => item.code),
  };
}

function longSchemeMetrics(report, scheme) {
  const scoreKey = `selection_score_${scheme}`;
  const rows = report.rows.filter(
    (row) => row.new_bucket === 'long' && row.new_ranking_candidate,
  );
  const scores = rows
    .map((row) => row[scoreKey])
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const q1 = percentile(scores, 0.25);
  const q3 = percentile(scores, 0.75);
  const outlierThreshold =
    q1 !== null && q3 !== null
      ? q3 +
        (q3 - q1) * DIAGNOSTIC_THRESHOLDS.score_outlier_iqr_multiplier
      : null;
  const oldTop3 = new Set(
    report.summary.buckets.long.top3.old.map((item) => item.code),
  );
  const top3 = report.summary.buckets.long.top3[scheme];
  const aTop3 = new Set(
    report.summary.buckets.long.top3.A.map((item) => item.code),
  );
  return {
    source: report.source?.file_name || null,
    rank_changed: report.summary.schemes[scheme].rank_changed,
    comparable_rank_count:
      report.summary.schemes[scheme].comparable_rank_count,
    max_score: scores.at(-1) ?? null,
    median_score: median(scores),
    outlier_count:
      outlierThreshold === null
        ? 0
        : rows.filter((row) => row[scoreKey] > outlierThreshold).length,
    top3_same_as_old:
      top3.length === oldTop3.size &&
      top3.every((item) => oldTop3.has(item.code)),
    top3_same_as_A:
      top3.length === aTop3.size &&
      top3.every((item) => aTop3.has(item.code)),
    top3_codes: top3.map((item) => item.code),
  };
}

function aggregateShortMetrics(items) {
  return {
    snapshot_count: items.length,
    max_score_across_snapshots:
      items.length > 0
        ? Math.max(...items.map((item) => item.max_score))
        : null,
    average_top5_excess_share: round(
      mean(items.map((item) => item.top5_excess_share).filter(Number.isFinite)),
      6,
    ),
    average_spearman_vs_old: round(
      mean(items.map((item) => item.spearman_vs_old).filter(Number.isFinite)),
      6,
    ),
    average_rank_changed_ratio: round(
      mean(items.map((item) => item.rank_changed_ratio).filter(Number.isFinite)),
      6,
    ),
    average_mean_absolute_score_delta: round(
      mean(
        items
          .map((item) => item.mean_absolute_score_delta)
          .filter(Number.isFinite),
      ),
      6,
    ),
    top3_preserved_snapshot_count: items.filter(
      (item) => item.top3_same_as_old,
    ).length,
  };
}

function weightOptionsWith(shortWeights) {
  return {
    cash: BUCKET_WEIGHTS.cash,
    short: shortWeights,
    medium: BUCKET_WEIGHTS.medium,
    long: BUCKET_WEIGHTS.long,
  };
}

function buildParameterReviewReport({
  snapshots,
  productionDashboard = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) {
    throw new Error('参数审查至少需要两个产品快照');
  }
  const weightEvaluations = {};
  const reportsByVariant = {};
  for (const [variant, shortWeights] of Object.entries(SHORT_WEIGHT_OPTIONS)) {
    const reports = snapshots.map((snapshot) =>
      buildYieldShadowReport({
        products: snapshot.products,
        generatedAt,
        source: snapshot.source || null,
        bucketWeights: weightOptionsWith(shortWeights),
      }),
    );
    reportsByVariant[variant] = reports;
    const perSnapshot = reports.map((report) =>
      shortMetrics(report, SELECTED_LONG_SCHEME),
    );
    weightEvaluations[variant] = {
      weights: shortWeights,
      per_snapshot: perSnapshot,
      aggregate: aggregateShortMetrics(perSnapshot),
    };
  }
  const selectedReports = reportsByVariant[SELECTED_SHORT_VARIANT];
  const longSchemeEvaluations = Object.fromEntries(
    ['A', 'B', 'C'].map((scheme) => {
      const perSnapshot = selectedReports.map((report) =>
        longSchemeMetrics(report, scheme),
      );
      return [
        scheme,
        {
          per_snapshot: perSnapshot,
          aggregate: {
            average_rank_changed: round(
              mean(perSnapshot.map((item) => item.rank_changed)),
              3,
            ),
            top3_same_as_A_snapshot_count: perSnapshot.filter(
              (item) => item.top3_same_as_A,
            ).length,
            outlier_count: perSnapshot.reduce(
              (sum, item) => sum + item.outlier_count,
              0,
            ),
          },
          pairwise_to_A:
            scheme === 'A'
              ? null
              : {
                  changed_score_count: selectedReports.reduce(
                    (sum, report) =>
                      sum +
                      (report.summary.scheme_pairwise[
                        scheme === 'B' ? 'B_minus_A' : 'C_minus_A'
                      ]?.positive ?? 0),
                    0,
                  ),
                  max_positive_score_delta: Math.max(
                    ...selectedReports.map(
                      (report) =>
                        report.summary.scheme_pairwise[
                          scheme === 'B' ? 'B_minus_A' : 'C_minus_A'
                        ]?.max ?? 0,
                    ),
                  ),
                },
          pairwise_to_B:
            scheme === 'C'
              ? {
                  changed_score_count: selectedReports.reduce(
                    (sum, report) =>
                      sum +
                      (report.summary.scheme_pairwise.C_minus_B?.positive ?? 0),
                    0,
                  ),
                  max_positive_score_delta: Math.max(
                    ...selectedReports.map(
                      (report) =>
                        report.summary.scheme_pairwise.C_minus_B?.max ?? 0,
                    ),
                  ),
                }
              : null,
        },
      ];
    }),
  );
  const latestReport = selectedReports.at(-1);
  const productionProjection = analyzeProductionConsistency(
    latestReport,
    productionDashboard,
  );
  const originalReports = reportsByVariant.original_50_30_20;
  const originalProjection = productionDashboard
    ? analyzeProductionConsistency(originalReports.at(-1), productionDashboard)
    : null;
  return {
    schema_version: 1,
    review_version: REVIEW_VERSION,
    generated_at: generatedAt,
    policy: REVIEW_POLICY,
    write_policy: REVIEW_WRITE_POLICY,
    snapshots: snapshots.map((snapshot) => ({
      label: snapshot.label,
      source: snapshot.source || null,
      snapshot_date: snapshot.report_date || null,
      product_count: snapshot.products.length,
    })),
    short_weight_options: weightEvaluations,
    long_frontload_options: longSchemeEvaluations,
    selected_parameters: {
      buckets: SELECTED_BUCKET_WEIGHTS,
      long_frontload_scheme: SELECTED_LONG_SCHEME,
      weighted_yield_mode: 'alias_of_reference_yield',
      cash_policy:
        'display_only_no_score_no_rank_no_allocation_no_candidate_no_proposal',
    },
    decision: {
      short_weights: {
        original: SHORT_WEIGHT_OPTIONS.original_50_30_20,
        selected: SHORT_WEIGHT_OPTIONS[SELECTED_SHORT_VARIANT],
        outcome: 'adjusted_down',
        rationale:
          '50% 的 1M 权重造成 short 排名被单月尖峰主导。将 1M 保留为 20%，以 3M 50% 为主锚点，并用 6M 30% 提高稳定性。',
      },
      long_frontload: {
        selected: SELECTED_LONG_SCHEME,
        outcome: 'select_B',
        rationale:
          'A/B/C 在三份快照中前三名相同。B 相对 A 降低平均 long 排名扰动，且相对 C 的改动更小并保留前视惩罚。',
      },
      medium_weights: {
        outcome: 'retain',
        rationale:
          'medium 与旧排序的排名相关性接近 1，且没有观察到不可接受的高分集中。',
      },
      long_weights: {
        outcome: 'retain',
        rationale:
          'long 与旧排序仍保持高相关。单一窗口产品继续受证据档位上限约束，并通过监控处理，而不是据此再改权重。',
      },
      cash_weights: {
        outcome: 'retain_display_only',
        rationale:
          'cash 永不参与排名、分配、候选或提案评分，仅保留展示。',
      },
    },
    production_projection: {
      selected: productionProjection,
      original_candidate: originalProjection,
    },
    residual_risks: [
      '只有单一可用窗口的产品仍可能凭该窗口取得高排名，尽管证据档位上限会限制其分配金额。',
      '当前快照没有 31 天或 101 天的排名候选，真实边界分布稳定性仍未得到经验证明。',
      '选定参数尚未获得生产授权，必须先完成阶段 5 兼容改造和单独发布审批。',
    ],
    conclusion:
      '选定 short 20/50/30 和 long 前视扣分 B，保留 medium、long 与 cash 权重；完成阶段 5 前不得修改正式计算路径。',
  };
}

module.exports = {
  REVIEW_POLICY,
  REVIEW_VERSION,
  REVIEW_WRITE_POLICY,
  SELECTED_BUCKET_WEIGHTS,
  SELECTED_LONG_SCHEME,
  SELECTED_SHORT_VARIANT,
  SHORT_WEIGHT_OPTIONS,
  buildParameterReviewReport,
  longSchemeMetrics,
  shortMetrics,
};
