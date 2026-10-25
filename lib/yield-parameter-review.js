'use strict';

const crypto = require('node:crypto');
const {
  BUCKET_WEIGHTS,
  buildYieldShadowReport,
} = require('./yield-shadow');
const { spearmanForRanks } = require('./rank-correlation');
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
const STAGE6_COHORT_GATE = Object.freeze({
  min_presence_ratio: 0.9,
  min_reportable_ratio: 0.8,
  min_ranking_candidates_per_bucket: 10,
});

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  const rounded =
    Math.floor(Math.abs(value) * factor + 0.5 + Number.EPSILON) / factor;
  return rounded === 0 ? 0 : Math.sign(value) * rounded;
}

function parseIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const [year, month, day] = value.split('-').map(Number);
  const stamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(stamp);
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? stamp
    : null;
}

function daysBetween(left, right) {
  const leftStamp = parseIsoDate(left);
  const rightStamp = parseIsoDate(right);
  return leftStamp === null || rightStamp === null
    ? null
    : Math.round((rightStamp - leftStamp) / 86400000);
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
  return spearmanForRanks(
    Object.fromEntries(
      rows.map((row) => [row.code, row.ranking.old.rank]),
    ),
    Object.fromEntries(
      rows.map((row) => [row.code, row.ranking[scheme].rank]),
    ),
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
  reviewContext = 'stage4',
  cohort = null,
  observationSpec = null,
} = {}) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) {
    throw new Error('参数审查至少需要两个产品快照');
  }
  if (!['stage4', 'stage6'].includes(reviewContext)) {
    throw new Error(`不支持的参数复核上下文：${reviewContext}`);
  }
  const isStage6 = reviewContext === 'stage6';
  let cohortMetadata = null;
  if (isStage6) {
    if (
      !observationSpec ||
      !cohort ||
      !Array.isArray(cohort.codes) ||
      !cohort.codes.length ||
      cohort.code_count !== cohort.codes.length
    ) {
      throw new Error('阶段 6 参数复核必须提供冻结 cohort');
    }
    if (
      observationSpec.cohort_hash !== cohort.code_hash ||
      observationSpec.cohort_version !== cohort.cohort_version ||
      observationSpec.baseline_data_date !== cohort.baseline_data_date
    ) {
      throw new Error('阶段 6 冻结规格与 cohort 不一致');
    }
    const cohortCodes = new Set(cohort.codes);
    if (cohortCodes.size !== cohort.codes.length) {
      throw new Error('阶段 6 冻结 cohort 包含重复代码');
    }
    const computedHash = crypto
      .createHash('sha256')
      .update(cohort.codes.join('\n'))
      .digest('hex');
    if (cohort.code_hash !== computedHash) {
      throw new Error('阶段 6 冻结 cohort 哈希不匹配');
    }
    cohortMetadata = {
      observation_version: observationSpec.observation_version,
      spec_frozen_at: observationSpec.frozen_at,
      spec_sha256: crypto
        .createHash('sha256')
        .update(JSON.stringify(observationSpec))
        .digest('hex'),
      policy_version: observationSpec.policy_version,
      selection_version: observationSpec.selection_version,
      official_front_load_scheme:
        observationSpec.official_front_load_scheme,
      cohort_version: cohort.cohort_version,
      code_count: cohort.code_count,
      code_hash: cohort.code_hash,
      baseline_data_date: cohort.baseline_data_date,
    };
    snapshots = snapshots.map((snapshot) => {
      const sourceProducts = snapshot.products;
      if (!Array.isArray(sourceProducts)) {
        throw new Error(`${snapshot.label} 缺少产品快照`);
      }
      const sourceByCode = new Map(
        sourceProducts.map((product) => [product.code, product]),
      );
      const products = cohort.codes
        .map((code) => sourceByCode.get(code))
        .filter(Boolean);
      const presenceRatio = products.length / cohort.code_count;
      if (presenceRatio < STAGE6_COHORT_GATE.min_presence_ratio) {
        throw new Error(
          `${snapshot.label} 的固定 cohort 覆盖率 ${(
            presenceRatio * 100
          ).toFixed(1)}% 低于 ${
            STAGE6_COHORT_GATE.min_presence_ratio * 100
          }%`,
        );
      }
      const coverageReport = buildYieldShadowReport({
        products,
        generatedAt,
        source: snapshot.source || null,
      });
      const rankingRows = coverageReport.rows.filter(
        (row) => row.new_ranking_candidate,
      );
      const reportableRatio = rankingRows.length / cohort.code_count;
      if (reportableRatio < STAGE6_COHORT_GATE.min_reportable_ratio) {
        throw new Error(
          `${snapshot.label} 的可评分覆盖率 ${(
            reportableRatio * 100
          ).toFixed(1)}% 低于 ${
            STAGE6_COHORT_GATE.min_reportable_ratio * 100
          }%`,
        );
      }
      const bucketCounts = Object.fromEntries(
        ['short', 'medium', 'long'].map((bucket) => [
          bucket,
          rankingRows.filter((row) => row.new_bucket === bucket).length,
        ]),
      );
      const thinBucket = Object.entries(bucketCounts).find(
        ([, count]) =>
          count <
          STAGE6_COHORT_GATE.min_ranking_candidates_per_bucket,
      );
      if (thinBucket) {
        throw new Error(
          `${snapshot.label} 的 ${thinBucket[0]} 排名候选仅 ${thinBucket[1]} 个`,
        );
      }
      return {
        ...snapshot,
        products,
        report_date:
          products
            .map((product) => product.data_date)
            .filter(Boolean)
            .sort()
            .at(-1) || snapshot.report_date || null,
        cohort_quality: {
          presence_ratio: presenceRatio,
          reportable_ratio: reportableRatio,
          missing_count: cohort.code_count - products.length,
          extra_count: sourceProducts.length - products.length,
          bucket_candidate_counts: bucketCounts,
        },
      };
    });
    const seenDates = new Set();
    let previousDate = observationSpec.baseline_data_date;
    for (const snapshot of snapshots) {
      const snapshotDate = snapshot.report_date;
      const gapDays = daysBetween(previousDate, snapshotDate);
      if (
        gapDays === null ||
        gapDays < observationSpec.thresholds.min_data_date_gap_days ||
        gapDays > observationSpec.thresholds.max_data_date_gap_days ||
        seenDates.has(snapshotDate)
      ) {
        throw new Error(
          `${snapshot.label} 的产品数据日 ${snapshotDate} 不满足规格后独立周样本间隔要求`,
        );
      }
      seenDates.add(snapshotDate);
      previousDate = snapshotDate;
    }
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
  const snapshotCount = snapshots.length;
  const selectedShortAggregate =
    weightEvaluations[SELECTED_SHORT_VARIANT].aggregate;
  const aLongAggregate = longSchemeEvaluations.A.aggregate;
  const bLongAggregate = longSchemeEvaluations.B.aggregate;
  const bTop3SameCount =
    bLongAggregate.top3_same_as_A_snapshot_count;
  const shortRationale = isStage6
    ? `${snapshotCount} 份规格后快照中，short 20/50/30 的最高评分为 ` +
      `${selectedShortAggregate.max_score_across_snapshots}，与旧排序的平均 ` +
      `Spearman 为 ${selectedShortAggregate.average_spearman_vs_old}。`
    : '50% 的 1M 权重造成 short 排名被单月尖峰主导。将 1M 保留为 20%，以 3M 50% 为主锚点，并用 6M 30% 提高稳定性。';
  const longRationale = isStage6
    ? `${snapshotCount} 份规格后快照中，B 与 A 的前三名有 ` +
      `${bTop3SameCount}/${snapshotCount} 份相同；B 平均 long 排名变化 ` +
      `${bLongAggregate.average_rank_changed}，A 为 ${aLongAggregate.average_rank_changed}。`
    : 'A/B/C 在三份快照中前三名相同。B 相对 A 降低平均 long 排名扰动，且相对 C 的改动更小并保留前视惩罚。';
  const residualRisks = isStage6
    ? [
        '4 个独立样本只开放参数复核入口，8 个样本仍为优先完成目标；少于 4 个不得得出结论。',
        '排名稳定性、Top N 重合度和下一快照披露 1M 年化都只是横截面或前向代理，不是用户实际持有收益。',
        '本复核不会修改正式权重、评分、目标或提案；任何调参或回退都必须由用户基于独立证据单独决定。',
      ]
    : [
        '只有单一可用窗口的产品仍可能凭该窗口取得高排名，尽管证据档位上限会限制其分配金额。',
        '当前快照没有 31 天或 101 天的排名候选，真实边界分布稳定性仍未得到经验证明。',
        '选定参数尚未获得生产授权，必须先完成阶段 5 兼容改造和单独发布审批。',
      ];
  return {
    schema_version: 1,
    review_version: REVIEW_VERSION,
    review_context: {
      id: reviewContext,
      snapshot_count: snapshotCount,
      cohort: cohortMetadata,
    },
    generated_at: generatedAt,
    policy: REVIEW_POLICY,
    write_policy: REVIEW_WRITE_POLICY,
    snapshots: snapshots.map((snapshot) => ({
      label: snapshot.label,
      source: snapshot.source || null,
      snapshot_date: snapshot.report_date || null,
      product_count: snapshot.products.length,
      cohort_quality: snapshot.cohort_quality || null,
    })),
    short_weight_options: weightEvaluations,
    long_frontload_options: longSchemeEvaluations,
    selected_parameters: {
      selection_status: isStage6
        ? 'current_policy_under_review'
        : 'selected_for_next_stage',
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
        outcome: isStage6 ? 'decision_required' : 'adjusted_down',
        rationale: shortRationale,
      },
      long_frontload: {
        selected: SELECTED_LONG_SCHEME,
        outcome: isStage6 ? 'decision_required' : 'select_B',
        rationale: longRationale,
      },
      medium_weights: {
        outcome: isStage6
          ? 'current_policy_pending_user_decision'
          : 'retain',
        rationale: isStage6
          ? 'medium 当前正式权重为 50/30/20；本轮只记录样本外证据，不预选继续或调整。'
          : 'medium 与旧排序的排名相关性接近 1，且没有观察到不可接受的高分集中。',
      },
      long_weights: {
        outcome: isStage6
          ? 'current_policy_pending_user_decision'
          : 'retain',
        rationale: isStage6
          ? 'long 当前正式权重为 20/40/40；单一窗口风险仍由证据档位上限和观察指标单独表达。'
          : 'long 与旧排序仍保持高相关。单一窗口产品继续受证据档位上限约束，并通过监控处理，而不是据此再改权重。',
      },
      cash_weights: {
        outcome: isStage6
          ? 'display_only_current_policy'
          : 'retain_display_only',
        rationale: isStage6
          ? 'cash 只展示，永不参与样本外排名、分配、候选或提案评分。'
          : 'cash 永不参与排名、分配、候选或提案评分，仅保留展示。',
      },
    },
    production_projection: {
      selected: productionProjection,
      original_candidate: originalProjection,
    },
    residual_risks: residualRisks,
    conclusion: isStage6
      ? `已完成 ${snapshotCount} 份规格后快照的参数复核；结果只提供继续、调参或回退的证据，不自动修改正式权重。`
      : '选定 short 20/50/30 和 long 前视扣分 B，保留 medium、long 与 cash 权重；完成阶段 5 前不得修改正式计算路径。',
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
