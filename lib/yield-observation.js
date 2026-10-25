'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadProductsFromCsv } = require('./products');
const { spearmanForRanks } = require('./rank-correlation');
const { buildYieldShadowReport } = require('./yield-shadow');
const { analyzeSnapshot } = require('./yield-shadow-analysis');

const OBSERVATION_VERSION = 'td-yield-002-out-of-sample-v1';
const SPEC_VERSION = 1;
const COHORT_VERSION = 'td-yield-002-cohort-v1';
const POLICY_VERSION = 'r2-term-yield-v1';
const SELECTION_VERSION = 'r2-dynamic-v4';
const OFFICIAL_SCHEME = 'B';
const OBSERVATION_LOCK_STALE_MS = 5 * 60 * 1000;
const OBSERVATION_LOCK_WAIT_MS = 2000;
const BUCKETS = Object.freeze(['short', 'medium', 'long']);
const OBSERVATION_FILES = Object.freeze({
  spec: 'td-yield-002-observation-spec.json',
  cohort: 'td-yield-002-cohort-v1.json',
  ledger: 'td-yield-002-weekly-ledger.jsonl',
});
const OBSERVATION_THRESHOLDS = Object.freeze({
  min_independent_samples: 4,
  preferred_independent_samples: 8,
  min_data_date_gap_days: 5,
  max_data_date_gap_days: 10,
  min_cohort_presence_ratio: 0.9,
  min_reportable_cohort_ratio: 0.8,
  min_ranking_candidates_per_bucket: 10,
  short_top5_concentration: 0.5,
  window_samples: 4,
  sustained_event_count: 2,
  min_top3_overlap_count: 2,
  min_short_spearman: 0.75,
  min_short_top10_overlap_ratio: 0.6,
  max_unavailable_ratio: 0.15,
  max_unavailable_increase_pp: 0.05,
  min_boundary_per_side: 5,
  boundary_material_score_gap_pp: 2,
  spotlight_code: '667828A',
});

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  const rounded =
    Math.floor(Math.abs(value) * factor + 0.5 + Number.EPSILON) / factor;
  return rounded === 0 ? 0 : Math.sign(value) * rounded;
}

function median(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2
    ? finite[middle]
    : (finite[middle - 1] + finite[middle]) / 2;
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length
    ? finite.reduce((sum, value) => sum + value, 0) / finite.length
    : null;
}

function parseDate(value) {
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

function daysBetween(from, to) {
  const left = parseDate(from);
  const right = parseDate(to);
  if (left === null || right === null) return null;
  return Math.round((right - left) / (24 * 60 * 60 * 1000));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function snapshotDateForProducts(products) {
  return (
    [...new Set(products.map((product) => product.data_date).filter(Boolean))]
      .sort()
      .at(-1) || null
  );
}

function dataDateCounts(products) {
  const counts = new Map();
  for (const product of products) {
    const key = product.data_date || 'missing';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function fileDate(filePath) {
  return /(\d{4}-\d{2}-\d{2})/.exec(path.basename(filePath))?.[1] || null;
}

function buildCohortDefinition(products, metadata = {}) {
  if (!Array.isArray(products) || !products.length) {
    throw new Error('固定 cohort 需要非空产品快照');
  }
  const codes = [...new Set(products.map((product) => product.code))]
    .filter(Boolean)
    .sort();
  const codeHash = sha256(codes.join('\n'));
  return {
    schema_version: 1,
    cohort_version: COHORT_VERSION,
    frozen_at: metadata.frozenAt || new Date().toISOString(),
    baseline_data_date:
      metadata.baselineDataDate || snapshotDateForProducts(products),
    baseline_source: metadata.source || null,
    code_count: codes.length,
    code_hash: codeHash,
    codes,
  };
}

function buildObservationSpec({
  cohort,
  baselineSource = null,
  frozenAt = new Date().toISOString(),
} = {}) {
  if (!cohort?.codes?.length) {
    throw new Error('观察规格需要固定 cohort');
  }
  return {
    schema_version: SPEC_VERSION,
    observation_version: OBSERVATION_VERSION,
    frozen_at: frozenAt,
    policy_version: POLICY_VERSION,
    selection_version: SELECTION_VERSION,
    official_front_load_scheme: OFFICIAL_SCHEME,
    baseline_data_date: cohort.baseline_data_date,
    baseline_source: baselineSource || cohort.baseline_source,
    cohort_version: cohort.cohort_version,
    cohort_hash: cohort.code_hash,
    thresholds: OBSERVATION_THRESHOLDS,
    metrics: [
      'short_top5_excess_share',
      'single_window_top5_codes',
      'top3_by_bucket',
      'top10_by_bucket',
      'unavailable_ratio',
      'rank_spearman',
      'rank_churn_ratio',
      'boundary_31_101',
      'spotlight_667828A',
      'forward_disclosed_return_proxy',
    ],
    economic_outcome_policy: {
      proxy_only: true,
      proxy_field: 'forward_disclosed_return_proxy',
      requirement_before_parameter_change:
        '需要独立已实现收益证据；单凭下一快照的披露年化变化不能替代真实持有收益。',
    },
    write_policy: {
      changes_formal_weights: false,
      changes_formal_scores: false,
      changes_allocations: false,
      changes_proposals: false,
    },
  };
}

function validateSpecAndCohort(spec, cohort) {
  if (
    !spec ||
    spec.schema_version !== SPEC_VERSION ||
    spec.observation_version !== OBSERVATION_VERSION
  ) {
    throw new Error('观察规格版本无效');
  }
  if (spec.policy_version !== POLICY_VERSION) {
    throw new Error('观察规格的收益策略版本已变化，必须新建观察版本');
  }
  if (spec.selection_version !== SELECTION_VERSION) {
    throw new Error('观察规格的产品选择版本已变化，必须新建观察版本');
  }
  if (spec.official_front_load_scheme !== OFFICIAL_SCHEME) {
    throw new Error('观察规格的前视扣分方案已变化，必须新建观察版本');
  }
  if (!parseDate(spec.baseline_data_date)) {
    throw new Error('观察规格的基线数据日无效');
  }
  if (!cohort || cohort.cohort_version !== spec.cohort_version) {
    throw new Error('观察 cohort 版本不匹配');
  }
  if (cohort.baseline_data_date !== spec.baseline_data_date) {
    throw new Error('观察 cohort 与冻结规格的基线数据日不一致');
  }
  if (!Array.isArray(cohort.codes) || !cohort.codes.length) {
    throw new Error('观察 cohort 为空');
  }
  if (
    cohort.codes.some(
      (code) => typeof code !== 'string' || !code.trim(),
    )
  ) {
    throw new Error('观察 cohort 包含无效产品代码');
  }
  if (new Set(cohort.codes).size !== cohort.codes.length) {
    throw new Error('观察 cohort 包含重复产品代码');
  }
  if (cohort.code_count !== cohort.codes.length) {
    throw new Error('观察 cohort 产品数量与代码清单不一致');
  }
  const computedHash = sha256(cohort.codes.join('\n'));
  if (cohort.code_hash !== computedHash) {
    throw new Error('观察 cohort 代码清单哈希不匹配');
  }
  if (spec.cohort_hash !== computedHash) {
    throw new Error('观察 cohort 与冻结规格哈希不匹配');
  }
}

function rankMapFor(report, bucket, scheme = OFFICIAL_SCHEME) {
  return Object.fromEntries(
    report.rows
      .filter(
        (row) =>
          row.new_bucket === bucket &&
          row.new_ranking_candidate &&
          Number.isFinite(row.ranking?.[scheme]?.rank),
      )
      .map((row) => [row.code, row.ranking[scheme].rank]),
  );
}

function topRows(report, bucket, scheme, count) {
  return report.rows
    .filter(
      (row) =>
        row.new_bucket === bucket &&
        row.new_ranking_candidate &&
        Number.isFinite(row.ranking?.[scheme]?.rank),
    )
    .sort((left, right) => left.ranking[scheme].rank - right.ranking[scheme].rank)
    .slice(0, count)
    .map((row) => ({
      code: row.code,
      rank: row.ranking[scheme].rank,
      score: row[`selection_score_${scheme}`] ?? null,
      reference_yield_pct: row.new_reference_yield_pct,
      evidence_tier: row.evidence_tier,
      available_horizons: row.new_available_horizons,
    }));
}

function topCodes(rows) {
  return rows.map((row) => row.code);
}

function overlapCount(leftCodes, rightCodes) {
  const right = new Set(rightCodes);
  return leftCodes.filter((code) => right.has(code)).length;
}

function overlapRatio(leftCodes, rightCodes) {
  const denominator = Math.max(leftCodes.length, rightCodes.length);
  return denominator ? round(overlapCount(leftCodes, rightCodes) / denominator) : null;
}

function rankChurn(leftRanks, rightRanks) {
  const common = Object.keys(leftRanks).filter((code) =>
    Number.isFinite(rightRanks[code]),
  );
  if (!common.length) {
    return {
      common_count: 0,
      changed_count: 0,
      changed_ratio: null,
      spearman: null,
    };
  }
  const changed = common.filter(
    (code) => leftRanks[code] !== rightRanks[code],
  );
  return {
    common_count: common.length,
    changed_count: changed.length,
    changed_ratio: round(changed.length / common.length),
    spearman: spearmanForRanks(leftRanks, rightRanks),
  };
}

function trackedMetricRow(row) {
  return {
    bucket: row.new_bucket,
    evidence_tier: row.evidence_tier,
    return_1m: row.return_1m,
    return_3m: row.return_3m,
    return_6m: row.return_6m,
    return_1y: row.return_1y,
    reference_yield_pct: row.new_reference_yield_pct,
    rank_B: row.ranking?.B?.rank ?? null,
    single_window: ['three_month', 'one_month'].includes(row.evidence_tier),
  };
}

function bucketObservation(report, analysis, bucket) {
  const ranked = report.rows
    .filter(
      (row) =>
        row.new_bucket === bucket &&
        row.new_ranking_candidate &&
        Number.isFinite(row.ranking?.B?.rank),
    )
    .sort((left, right) => left.ranking.B.rank - right.ranking.B.rank);
  const top5Count = Math.max(1, Math.ceil(ranked.length * 0.05));
  const top5Rows = ranked.slice(0, top5Count);
  const scoreDiagnostics = analysis.buckets[bucket]?.scores || {};
  return {
    candidate_count: ranked.length,
    top1: topCodes(topRows(report, bucket, OFFICIAL_SCHEME, 1)),
    top3: topCodes(topRows(report, bucket, OFFICIAL_SCHEME, 3)),
    top10: topCodes(topRows(report, bucket, OFFICIAL_SCHEME, 10)),
    old_top3: topCodes(topRows(report, bucket, 'old', 3)),
    top5_count: top5Count,
    top5_codes: topCodes(
      top5Rows.map((row) => ({ code: row.code })),
    ),
    single_window_top5: top5Rows
      .filter((row) => ['three_month', 'one_month'].includes(row.evidence_tier))
      .map((row) => ({
        code: row.code,
        evidence_tier: row.evidence_tier,
        available_horizons: row.new_available_horizons,
        reference_yield_pct: row.new_reference_yield_pct,
        rank_B: row.ranking.B.rank,
      })),
    top5_excess_share: scoreDiagnostics.top5_excess_share ?? null,
    high_concentration: Boolean(scoreDiagnostics.high_concentration),
    reference_yield_median: median(
      ranked.map((row) => row.new_reference_yield_pct),
    ),
    return_1m_median: median(ranked.map((row) => row.return_1m)),
  };
}

function spotlightObservation(report, rawByCode, code) {
  const row = report.rows.find((item) => item.code === code);
  if (!row) {
    return {
      present: rawByCode.has(code),
      eligible: false,
      bucket: null,
      rank_B: null,
      single_window_top5: false,
    };
  }
  const bucket = row.new_bucket;
  const bucketRanked = report.rows
    .filter(
      (item) =>
        item.new_bucket === bucket &&
        item.new_ranking_candidate &&
        Number.isFinite(item.ranking?.B?.rank),
    )
    .sort(
      (left, right) =>
        left.ranking.B.rank - right.ranking.B.rank,
    );
  const top5Count = Math.max(
    1,
    Math.ceil(bucketRanked.length * 0.05),
  );
  const rankB = Number.isFinite(row.ranking?.B?.rank)
    ? row.ranking.B.rank
    : null;
  return {
    present: true,
    eligible: row.new_ranking_candidate === true,
    bucket,
    evidence_tier: row.evidence_tier,
    available_horizons: row.new_available_horizons,
    return_1m: row.return_1m,
    return_3m: row.return_3m,
    return_6m: row.return_6m,
    return_1y: row.return_1y,
    reference_yield_pct: row.new_reference_yield_pct,
    selection_score_B: row.selection_score_B,
    rank_B: rankB,
    single_window_top5:
      BUCKETS.includes(bucket) &&
      row.new_ranking_candidate === true &&
      rankB !== null &&
      rankB <= top5Count &&
      ['three_month', 'one_month'].includes(row.evidence_tier),
  };
}

function forwardProxy(previousRecord, currentRecord) {
  if (!previousRecord || !currentRecord) return null;
  const currentMetrics = currentRecord.tracked_metrics;
  const finiteReturns = (codes) =>
    codes
      .map((code) => currentMetrics[code]?.return_1m)
      .filter(Number.isFinite);
  return Object.fromEntries(
    BUCKETS.map((bucket) => {
      const previousBucket = previousRecord.metrics.buckets[bucket];
      const oldTop3Returns = finiteReturns(previousBucket.old_top3);
      const officialTop3Returns = finiteReturns(previousBucket.top3);
      return [
        bucket,
        {
          method: 'next_snapshot_disclosed_1m_annualized_proxy',
          actual_holding_return: false,
          old_top3_mean_return_1m: mean(oldTop3Returns),
          official_top3_mean_return_1m: mean(officialTop3Returns),
          current_bucket_return_1m_median:
            currentRecord.metrics.buckets[bucket].return_1m_median,
          old_top3_coverage: oldTop3Returns.length,
          old_top3_total: previousBucket.old_top3.length,
          official_top3_coverage: officialTop3Returns.length,
          official_top3_total: previousBucket.top3.length,
        },
      ];
    }),
  );
}

function compareObservationRecords(previous, current) {
  if (!previous || !current) return null;
  return {
    previous_data_date: previous.data_date,
    current_data_date: current.data_date,
    gap_days: daysBetween(previous.data_date, current.data_date),
    buckets: Object.fromEntries(
      BUCKETS.map((bucket) => {
        const left = previous.metrics.buckets[bucket];
        const right = current.metrics.buckets[bucket];
        return [
          bucket,
          {
            top1_changed:
              JSON.stringify(left.top1) !== JSON.stringify(right.top1),
            top3_overlap_count: overlapCount(left.top3, right.top3),
            top3_overlap_ratio: overlapRatio(left.top3, right.top3),
            top10_overlap_count: overlapCount(left.top10, right.top10),
            top10_overlap_ratio: overlapRatio(left.top10, right.top10),
            rank_churn: rankChurn(
              previous.rank_map_by_bucket[bucket],
              current.rank_map_by_bucket[bucket],
            ),
          },
        ];
      }),
    ),
    forward_disclosed_return_proxy: forwardProxy(previous, current),
  };
}

function disqualificationReason({
  spec,
  dataDate,
  rawPresenceRatio,
  reportableRatio,
  candidateCounts,
  invariants,
}) {
  if (
    rawPresenceRatio < spec.thresholds.min_cohort_presence_ratio
  ) {
    return `cohort 原始覆盖率 ${(rawPresenceRatio * 100).toFixed(1)}% 低于 ${
      spec.thresholds.min_cohort_presence_ratio * 100
    }%`;
  }
  if (reportableRatio < spec.thresholds.min_reportable_cohort_ratio) {
    return `cohort 可评分覆盖率 ${(reportableRatio * 100).toFixed(1)}% 低于 ${
      spec.thresholds.min_reportable_cohort_ratio * 100
    }%`;
  }
  const thinBucket = BUCKETS.find(
    (bucket) =>
      candidateCounts[bucket] <
      spec.thresholds.min_ranking_candidates_per_bucket,
  );
  if (thinBucket) {
    return `${thinBucket} 排名候选仅 ${candidateCounts[thinBucket]} 个`;
  }
  if (!invariants.passed) return '内部不变量失败';
  if (!dataDate) return '缺少产品数据日';
  return null;
}

function evaluateObservationCapture({
  products,
  source,
  spec,
  cohort,
  records = [],
  generatedAt = new Date().toISOString(),
}) {
  validateSpecAndCohort(spec, cohort);
  if (!Array.isArray(products) || !products.length) {
    throw new Error('采集需要非空产品快照');
  }
  const rawByCode = new Map(products.map((product) => [product.code, product]));
  const cohortCodes = new Set(cohort.codes);
  const cohortProducts = [];
  const missingCodes = [];
  for (const code of cohort.codes) {
    if (rawByCode.has(code)) cohortProducts.push(rawByCode.get(code));
    else missingCodes.push(code);
  }
  const extraCodes = products
    .map((product) => product.code)
    .filter((code) => code && !cohortCodes.has(code))
    .sort();
  const dataDate = snapshotDateForProducts(cohortProducts);
  const priorEligible = records
    .filter((record) => record.quality?.eligible)
    .sort((left, right) => left.data_date.localeCompare(right.data_date));
  const previous = priorEligible.at(-1) || null;
  if (priorEligible.some((record) => record.data_date === dataDate)) {
    return {
      status: 'duplicate',
      data_date: dataDate,
      message: `数据日 ${dataDate} 已有独立观察样本`,
    };
  }
  const gapBase = previous?.data_date || spec.baseline_data_date;
  const gapDays = daysBetween(gapBase, dataDate);
  if (!Number.isFinite(gapDays)) {
    return {
      status: 'disqualified',
      data_date: dataDate,
      gap_days: gapDays,
      message: `数据日 ${dataDate} 或基准日 ${gapBase} 无效`,
    };
  }
  if (
    gapDays < 0 ||
    gapDays > spec.thresholds.max_data_date_gap_days
  ) {
    return {
      status: 'cadence_broken',
      data_date: dataDate,
      gap_days: gapDays,
      message:
        `数据日 ${dataDate} 与 ${gapBase} 间隔 ${gapDays} 天，` +
        `超过 ${spec.thresholds.max_data_date_gap_days} 天周观察窗口；` +
        '当前观察链已中断，不得回填或静默跳过，需由用户决定是否新建观察版本和基线',
    };
  }
  if (
    gapDays === 0 ||
    gapDays < spec.thresholds.min_data_date_gap_days
  ) {
    return {
      status: 'not_independent',
      data_date: dataDate,
      gap_days: gapDays,
      message:
        `数据日 ${dataDate} 与 ${gapBase} 间隔 ${gapDays} 天，` +
        `早于 ${spec.thresholds.min_data_date_gap_days} 天的独立周观察窗口`,
    };
  }

  const report = buildYieldShadowReport({
    products: cohortProducts,
    source,
    generatedAt,
  });
  const analysis = analyzeSnapshot(report, {
    label: source?.file_name || dataDate,
    source,
    scoreScheme: OFFICIAL_SCHEME,
  });
  const presenceRatio = cohortProducts.length / cohort.code_count;
  const reportableCount = report.rows.filter(
    (row) => row.new_ranking_candidate,
  ).length;
  const reportableRatio = reportableCount / cohort.code_count;
  const candidateCounts = Object.fromEntries(
    BUCKETS.map((bucket) => [
      bucket,
      report.rows.filter(
        (row) => row.new_bucket === bucket && row.new_ranking_candidate,
      ).length,
    ]),
  );
  const disqualified = disqualificationReason({
    spec,
    dataDate,
    rawPresenceRatio: presenceRatio,
    reportableRatio,
    candidateCounts,
    invariants: analysis.invariants,
  });
  if (disqualified) {
    return {
      status: 'disqualified',
      data_date: dataDate,
      message: disqualified,
      quality: {
        cohort_presence_ratio: round(presenceRatio),
        reportable_cohort_ratio: round(reportableRatio),
        candidate_counts: candidateCounts,
        invariants: analysis.invariants,
      },
    };
  }

  const spotlight = spotlightObservation(
    report,
    rawByCode,
    spec.thresholds.spotlight_code,
  );
  const record = {
    schema_version: 1,
    observation_version: spec.observation_version,
    sample_index: priorEligible.length + 1,
    data_date: dataDate,
    captured_at: generatedAt,
    policy_version: spec.policy_version,
    selection_version: spec.selection_version,
    official_front_load_scheme: spec.official_front_load_scheme,
    source,
    quality: {
      eligible: true,
      gap_days: gapDays,
      previous_data_date: previous?.data_date || spec.baseline_data_date,
      cohort_presence_count: cohortProducts.length,
      cohort_presence_ratio: round(presenceRatio),
      cohort_missing_count: missingCodes.length,
      cohort_missing_codes: missingCodes,
      cohort_extra_count: extraCodes.length,
      cohort_extra_codes_preview: extraCodes.slice(0, 30),
      reportable_count: reportableCount,
      reportable_cohort_ratio: round(reportableRatio),
      candidate_counts: candidateCounts,
      data_date_counts: dataDateCounts(cohortProducts),
      invariants: analysis.invariants,
    },
    metrics: {
      unavailable_count: report.summary.reference_status_counts.unavailable,
      unavailable_ratio: round(
        report.summary.reference_status_counts.unavailable /
          Math.max(report.rows.length, 1),
      ),
      evidence_counts: analysis.evidence_counts,
      buckets: Object.fromEntries(
        BUCKETS.map((bucket) => [
          bucket,
          bucketObservation(report, analysis, bucket),
        ]),
      ),
      boundary: analysis.boundary,
      spotlight_667828A: spotlight,
    },
    rank_map_by_bucket: Object.fromEntries(
      BUCKETS.map((bucket) => [
        bucket,
        rankMapFor(report, bucket, OFFICIAL_SCHEME),
      ]),
    ),
    tracked_metrics: Object.fromEntries(
      report.rows.map((row) => [row.code, trackedMetricRow(row)]),
    ),
  };
  record.comparison = previous
    ? compareObservationRecords(previous, record)
    : null;
  return {
    status: 'accepted',
    data_date: dataDate,
    record,
  };
}

function trigger(severity, key, summary, evidence = {}) {
  return { severity, key, summary, evidence };
}

function validateObservationRecords(records, spec) {
  const eligible = [];
  const issues = [];
  const seenDates = new Set();
  let previousDate = spec.baseline_data_date;
  for (const [index, record] of records.entries()) {
    if (record?.quality?.eligible !== true) {
      issues.push({
        code: 'record_not_eligible',
        index,
        message: '观察台账包含未标记 eligible 的记录',
      });
      continue;
    }
    if (
      record.observation_version !== spec.observation_version ||
      record.policy_version !== spec.policy_version ||
      record.selection_version !== spec.selection_version ||
      record.official_front_load_scheme !==
        spec.official_front_load_scheme
    ) {
      issues.push({
        code: 'record_version_mismatch',
        index,
        message: '观察台账记录的策略版本与冻结规格不一致',
      });
      continue;
    }
    if (record.sample_index !== eligible.length + 1) {
      issues.push({
        code: 'invalid_sample_index',
        index,
        expected: eligible.length + 1,
        value: record.sample_index ?? null,
        message: '观察台账样本序号不连续',
      });
      continue;
    }
    const dataDate = record.data_date;
    if (!parseDate(dataDate)) {
      issues.push({
        code: 'invalid_data_date',
        index,
        value: dataDate ?? null,
        message: '观察台账存在无效产品数据日',
      });
      continue;
    }
    if (seenDates.has(dataDate)) {
      issues.push({
        code: 'duplicate_data_date',
        index,
        value: dataDate,
        message: `观察台账重复记录数据日 ${dataDate}`,
      });
      continue;
    }
    seenDates.add(dataDate);
    const gapDays = daysBetween(previousDate, dataDate);
    if (
      !Number.isFinite(gapDays) ||
      gapDays < spec.thresholds.min_data_date_gap_days ||
      gapDays > spec.thresholds.max_data_date_gap_days
    ) {
      issues.push({
        code: 'invalid_sample_gap',
        index,
        data_date: dataDate,
        previous_data_date: previousDate,
        gap_days: gapDays,
        message:
          `数据日 ${dataDate} 与 ${previousDate} 间隔 ${gapDays} 天，` +
          `不符合 ${spec.thresholds.min_data_date_gap_days}–${spec.thresholds.max_data_date_gap_days} 天要求`,
      });
      continue;
    }
    const quality = record.quality;
    const candidateCounts = quality.candidate_counts || {};
    const thinBuckets = BUCKETS.filter(
      (bucket) =>
        !Number.isFinite(candidateCounts[bucket]) ||
        candidateCounts[bucket] <
          spec.thresholds.min_ranking_candidates_per_bucket,
    );
    if (
      !Number.isFinite(quality.cohort_presence_ratio) ||
      quality.cohort_presence_ratio <
        spec.thresholds.min_cohort_presence_ratio ||
      !Number.isFinite(quality.reportable_cohort_ratio) ||
      quality.reportable_cohort_ratio <
        spec.thresholds.min_reportable_cohort_ratio ||
      thinBuckets.length > 0 ||
      quality.invariants?.passed !== true ||
      quality.gap_days !== gapDays ||
      quality.previous_data_date !== previousDate
    ) {
      issues.push({
        code: 'stored_quality_failed',
        index,
        data_date: dataDate,
        thin_buckets: thinBuckets,
        message:
          '观察台账记录的覆盖率、候选数、间隔或不变量未通过冻结质量闸门',
      });
      continue;
    }
    eligible.push(record);
    previousDate = dataDate;
  }
  return { eligible, issues };
}

function commandArgument(value) {
  return /[\s"]/u.test(value)
    ? `"${value.replaceAll('"', '\\"')}"`
    : value;
}

function reviewObservationLedger(records, spec, cohort) {
  validateSpecAndCohort(spec, cohort);
  const validation = validateObservationRecords(records, spec);
  const eligible = validation.eligible;
  const required = spec.thresholds.min_independent_samples;
  const preferred = spec.thresholds.preferred_independent_samples;
  const initialStatus =
    eligible.length < required ? 'collecting' : 'continue_current_policy';
  const result = {
    observation_version: OBSERVATION_VERSION,
    sample_count: eligible.length,
    ledger_record_count: records.length,
    ledger_issues: validation.issues,
    required_samples: required,
    preferred_samples: preferred,
    ready_for_parameter_review: eligible.length >= required,
    preferred_samples_reached: eligible.length >= preferred,
    status: initialStatus,
    review_status: initialStatus,
    triggers: [],
    data_dates: eligible.map((record) => record.data_date),
    economic_outcome: {
      status: 'proxy_only_pending_realized',
      note:
        '下一快照的披露年化只作为前向代理，不能替代真实持有收益；参数变更仍需要独立经济结果证据。',
    },
    parameter_review_command: 'npm run yield:observe:review',
    formal_weight_change: false,
  };
  if (validation.issues.length) {
    result.ready_for_parameter_review = false;
    result.preferred_samples_reached = false;
    result.status = 'ledger_invalid';
    result.review_status = result.status;
    result.remaining_samples = Math.max(required - eligible.length, 0);
    result.remaining_preferred_samples = Math.max(
      preferred - eligible.length,
      0,
    );
    return result;
  }
  if (eligible.length < required) {
    result.remaining_samples = required - eligible.length;
    result.remaining_preferred_samples = Math.max(
      preferred - eligible.length,
      0,
    );
    return result;
  }

  const recent = eligible.slice(-spec.thresholds.window_samples);
  const recentComparisons = recent
    .map((record) => record.comparison)
    .filter(Boolean);
  const stabilityComparisons = recentComparisons.slice(-3);
  const sustained = spec.thresholds.sustained_event_count;
  const concentrated = recent.filter(
    (record) =>
      Number(record.metrics.buckets.short.top5_excess_share) >
      spec.thresholds.short_top5_concentration,
  ).length;
  if (concentrated >= sustained) {
    result.triggers.push(
      trigger(
        'medium',
        'short_top5_concentration',
        `short 前 5% 超额集中度在最近 ${recent.length} 个样本中有 ${concentrated} 次超过 ${spec.thresholds.short_top5_concentration * 100}%。`,
        { occurrences: concentrated, window: recent.length },
      ),
    );
  }

  const singleWindowCounts = new Map();
  for (const record of recent) {
    const seen = new Set(
      BUCKETS.flatMap((bucket) =>
        record.metrics.buckets[bucket].single_window_top5.map(
          (item) => item.code,
        ),
      ),
    );
    for (const code of seen) {
      singleWindowCounts.set(code, (singleWindowCounts.get(code) || 0) + 1);
    }
  }
  const sustainedSingleWindow = [...singleWindowCounts.entries()]
    .filter(([, count]) => count >= sustained)
    .map(([code, count]) => ({ code, count }));
  if (sustainedSingleWindow.length) {
    result.triggers.push(
      trigger(
        'medium',
        'sustained_single_window_high_score',
        `单一窗口产品持续进入桶内前 5%：${sustainedSingleWindow.map((item) => `${item.code}×${item.count}`).join(', ')}。`,
        sustainedSingleWindow,
      ),
    );
  }

  const shortTop3Unstable = stabilityComparisons.filter(
    (comparison) =>
      comparison.buckets.short.top3_overlap_count <
      spec.thresholds.min_top3_overlap_count,
  ).length;
  const shortTop1Changes = stabilityComparisons.filter(
    (comparison) => comparison.buckets.short.top1_changed,
  ).length;
  if (
    shortTop3Unstable >= sustained ||
    shortTop1Changes >= sustained
  ) {
    result.triggers.push(
      trigger(
        'medium',
        'short_ranking_instability',
        `short 前三稳定性不足：低重合 ${shortTop3Unstable} 次，第一名变化 ${shortTop1Changes} 次。`,
        { comparisons: stabilityComparisons.length },
      ),
    );
  }

  const highChurn = stabilityComparisons.filter((comparison) => {
    const churn = comparison.buckets.short.rank_churn;
    return (
      (Number.isFinite(churn.spearman) &&
        churn.spearman < spec.thresholds.min_short_spearman) ||
      (Number.isFinite(
        comparison.buckets.short.top10_overlap_ratio,
      ) &&
        comparison.buckets.short.top10_overlap_ratio <
          spec.thresholds.min_short_top10_overlap_ratio)
    );
  }).length;
  if (highChurn >= sustained) {
    result.triggers.push(
      trigger(
        'medium',
        'short_rank_churn',
        `short 排名换手偏高：最近 ${stabilityComparisons.length} 次比较中有 ${highChurn} 次触发换手阈值。`,
        { comparisons: stabilityComparisons.length },
      ),
    );
  }

  const baseline = recent[0];
  const latest = recent.at(-1);
  const unavailableIncrease =
    latest.metrics.unavailable_ratio - baseline.metrics.unavailable_ratio;
  if (
    latest.metrics.unavailable_ratio >
      spec.thresholds.max_unavailable_ratio ||
    unavailableIncrease >
      spec.thresholds.max_unavailable_increase_pp
  ) {
    result.triggers.push(
      trigger(
        'high',
        'unavailable_ratio',
        `不可计算比例升至 ${(latest.metrics.unavailable_ratio * 100).toFixed(1)}%，较窗口首样本变化 ${(unavailableIncrease * 100).toFixed(1)}pp。`,
        {
          latest: latest.metrics.unavailable_ratio,
          increase: unavailableIncrease,
        },
      ),
    );
  }

  const boundaryTrigger = BUCKETS.length
    ? latest.metrics.boundary.bands.find(
        (band) =>
          band.empirical_sample_sufficient &&
          Number.isFinite(band.lower_score_median) &&
          Number.isFinite(band.upper_score_median) &&
          Math.abs(band.upper_score_median - band.lower_score_median) >
            spec.thresholds.boundary_material_score_gap_pp,
      )
    : null;
  if (boundaryTrigger) {
    result.triggers.push(
      trigger(
        'medium',
        'boundary_discontinuity',
        `${boundaryTrigger.boundary} 天边界两侧评分中位数差 ${Math.abs(boundaryTrigger.upper_score_median - boundaryTrigger.lower_score_median).toFixed(2)} 分。`,
        boundaryTrigger,
      ),
    );
  }

  const spotlightHits = recent.filter(
    (record) => record.metrics.spotlight_667828A.single_window_top5,
  ).length;
  if (spotlightHits >= sustained) {
    result.triggers.push(
      trigger(
        'medium',
        'spotlight_667828A',
        `${spec.thresholds.spotlight_code} 在最近 ${recent.length} 个样本中有 ${spotlightHits} 次仅凭单一窗口进入前 5%。`,
        { occurrences: spotlightHits },
      ),
    );
  }

  if (eligible.length >= preferred) {
    result.triggers.push(
      trigger(
        'info',
        'preferred_sample_count_reached',
        `已累计 ${eligible.length} 个规格后独立样本，达到优先完成目标；可以完成样本外参数复核并由用户决定继续、调参或回退。`,
        {
          sample_count: eligible.length,
          required_samples: required,
          preferred_samples: preferred,
        },
      ),
    );
  }

  if (result.triggers.length) {
    result.status = 'review_required';
    result.review_status = result.status;
  }
  const reviewFiles = eligible
    .map((record) => record.source?.path || record.source?.file_name)
    .filter(Boolean);
  result.remaining_preferred_samples = Math.max(
    preferred - eligible.length,
    0,
  );
  result.parameter_review_command =
    `npm run yield:parameter-review -- --context stage6 ` +
    `--spec ${commandArgument(
      path.posix.join('data', 'yield-observations', OBSERVATION_FILES.spec),
    )} ` +
    `--cohort ${commandArgument(
      path.posix.join(
        'data',
        'yield-observations',
        OBSERVATION_FILES.cohort,
      ),
    )} ` +
    `--files ${commandArgument(reviewFiles.join(','))}`;
  return result;
}

function observationPaths(root) {
  const dir = path.join(root, 'data', 'yield-observations');
  return {
    dir,
    spec: path.join(dir, OBSERVATION_FILES.spec),
    cohort: path.join(dir, OBSERVATION_FILES.cohort),
    ledger: path.join(dir, OBSERVATION_FILES.ledger),
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readObservationLedger(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`观察台账第 ${index + 1} 行不是有效 JSON`);
      }
    });
}

function appendObservation(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : '';
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  const next = `${existing}${separator}${JSON.stringify(record)}\n`;
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, next, 'utf8');
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function acquireObservationLock(
  paths,
  waitMs = OBSERVATION_LOCK_WAIT_MS,
) {
  const lockPath = `${paths.ledger}.lock`;
  const deadline = Date.now() + waitMs;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            acquired_at: new Date().toISOString(),
          }),
          'utf8',
        );
      } catch (error) {
        fs.closeSync(fd);
        fs.unlinkSync(lockPath);
        throw error;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        fs.closeSync(fd);
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age;
      try {
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (age > OBSERVATION_LOCK_STALE_MS) {
        fs.unlinkSync(lockPath);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          '观察台账正在被其他进程写入；本轮未追加样本，请稍后重试',
        );
      }
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        50,
      );
    }
  }
}

function sourceForFile(filePath, products) {
  const buffer = fs.readFileSync(filePath);
  return {
    kind: 'product_csv',
    path: path.relative(path.resolve(__dirname, '..'), filePath).replaceAll('\\', '/'),
    file_name: path.basename(filePath),
    file_date: fileDate(filePath),
    data_date: snapshotDateForProducts(products),
    data_date_counts: dataDateCounts(products),
    sha256: sha256(buffer),
    row_count: products.length,
  };
}

function initializeObservationStore({
  root,
  inputPath,
  generatedAt = new Date().toISOString(),
}) {
  const paths = observationPaths(root);
  if (fs.existsSync(paths.spec) || fs.existsSync(paths.cohort)) {
    throw new Error('观察规格或 cohort 已存在；为保持样本外纪律，不覆盖已冻结文件');
  }
  const products = loadProductsFromCsv(inputPath);
  const source = sourceForFile(inputPath, products);
  const cohort = buildCohortDefinition(products, {
    frozenAt: generatedAt,
    baselineDataDate: source.data_date,
    source,
  });
  const spec = buildObservationSpec({
    cohort,
    baselineSource: source,
    frozenAt: generatedAt,
  });
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.spec, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  fs.writeFileSync(paths.cohort, `${JSON.stringify(cohort, null, 2)}\n`, 'utf8');
  if (!fs.existsSync(paths.ledger)) fs.writeFileSync(paths.ledger, '', 'utf8');
  return { spec, cohort, paths };
}

function captureObservationFromFile({
  root,
  inputPath,
  generatedAt = new Date().toISOString(),
  dryRun = false,
  lockWaitMs = OBSERVATION_LOCK_WAIT_MS,
}) {
  const paths = observationPaths(root);
  if (!fs.existsSync(paths.spec) || !fs.existsSync(paths.cohort)) {
    return {
      status: 'not_initialized',
      message: '样本外观察规格或 cohort 尚未初始化',
    };
  }
  const releaseLock = dryRun
    ? null
    : acquireObservationLock(paths, lockWaitMs);
  try {
    const spec = readJson(paths.spec);
    const cohort = readJson(paths.cohort);
    validateSpecAndCohort(spec, cohort);
    const records = readObservationLedger(paths.ledger);
    const ledgerValidation = validateObservationRecords(records, spec);
    if (ledgerValidation.issues.length) {
      return {
        status: 'ledger_invalid',
        message: ledgerValidation.issues[0].message,
        review: reviewObservationLedger(records, spec, cohort),
        paths,
      };
    }
    const products = loadProductsFromCsv(inputPath);
    const source = sourceForFile(inputPath, products);
    const evaluation = evaluateObservationCapture({
      products,
      source,
      spec,
      cohort,
      records,
      generatedAt,
    });
    if (evaluation.status === 'accepted' && !dryRun) {
      appendObservation(paths.ledger, evaluation.record);
      records.push(evaluation.record);
    }
    return {
      ...evaluation,
      review: reviewObservationLedger(
        records,
        spec,
        cohort,
      ),
      paths,
    };
  } finally {
    releaseLock?.();
  }
}

module.exports = {
  BUCKETS,
  COHORT_VERSION,
  OBSERVATION_FILES,
  OBSERVATION_THRESHOLDS,
  OBSERVATION_VERSION,
  OFFICIAL_SCHEME,
  POLICY_VERSION,
  SELECTION_VERSION,
  SPEC_VERSION,
  appendObservation,
  acquireObservationLock,
  buildCohortDefinition,
  buildObservationSpec,
  captureObservationFromFile,
  compareObservationRecords,
  evaluateObservationCapture,
  initializeObservationStore,
  observationPaths,
  readJson,
  readObservationLedger,
  reviewObservationLedger,
  sourceForFile,
  validateSpecAndCohort,
};
