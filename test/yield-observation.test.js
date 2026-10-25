'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  OFFICIAL_SCHEME,
  OBSERVATION_VERSION,
  OBSERVATION_THRESHOLDS,
  POLICY_VERSION,
  SELECTION_VERSION,
  buildCohortDefinition,
  buildObservationSpec,
  captureObservationFromFile,
  compareObservationRecords,
  evaluateObservationCapture,
  initializeObservationStore,
  readObservationLedger,
  reviewObservationLedger,
} = require('../lib/yield-observation');
const { productCsv } = require('./fixtures');
const {
  parseArgs,
  reviewFromStore,
} = require('../scripts/yield-observe.cjs');

const BUCKETS = [
  { name: 'short', termDays: 7, return1m: 2, return3m: 2.2, return6m: 2.4 },
  { name: 'medium', termDays: 90, return3m: 2.1, return6m: 2.2, return1y: 2.3 },
  { name: 'long', termDays: 180, return3m: 2, return6m: 2.1, return1y: 2.2 },
];

function product({
  code,
  name,
  termDays,
  dataDate,
  return1m = null,
  return3m = null,
  return6m = null,
  return1y = null,
  historyMonths = 24,
}) {
  return {
    id: code,
    name,
    short_name: name,
    code,
    issuer: '观察测试理财',
    risk_level: 'R2',
    currency_code: '10',
    pub_prv: 'A',
    soc_tag: 'C',
    product_type: '代销理财',
    term_days: termDays,
    score: null,
    min_amount: 1,
    annualized_yield: 9,
    benchmark: `基准-${code}`,
    return_1m: return1m,
    return_3m: return3m,
    return_6m: return6m,
    return_1y: return1y,
    return_since_inception: 2,
    status: '开放中',
    source: 'observation-test',
    data_date: dataDate,
    notes: '',
    capacity: null,
    history_months: historyMonths,
    fee_bps: 10,
    next_open_date: '2026-11-01',
  };
}

function productsForDate(dataDate, { extra = false } = {}) {
  const products = [];
  for (const bucket of BUCKETS) {
    for (let index = 1; index <= 12; index += 1) {
      const suffix = String(index).padStart(2, '0');
      const code = `${bucket.name.toUpperCase()}${suffix}`;
      products.push(
        product({
          code,
          name: `${bucket.name}产品${suffix}`,
          termDays: bucket.termDays,
          dataDate,
          return1m: bucket.return1m + index / 100,
          return3m: bucket.return3m + index / 100,
          return6m: bucket.return6m + index / 100,
          return1y: bucket.return1y ? bucket.return1y + index / 100 : null,
        }),
      );
    }
  }
  products.push(
    product({
      code: OBSERVATION_THRESHOLDS.spotlight_code,
      name: '单一窗口观察产品',
      termDays: 180,
      dataDate,
      return3m: 8,
    }),
  );
  if (extra) {
    products.push(
      product({
        code: 'EXTRA-NOT-IN-COHORT',
        name: '新增产品不应造成换手',
        termDays: 90,
        dataDate,
        return3m: 9,
        return6m: 9,
        return1y: 9,
      }),
    );
  }
  return products;
}

function fixture() {
  const baselineProducts = productsForDate('2026-10-22');
  const cohort = buildCohortDefinition(baselineProducts, {
    frozenAt: '2026-10-25T00:00:00.000Z',
    baselineDataDate: '2026-10-22',
    source: {
      kind: 'product_csv',
      file_name: 'baseline.csv',
      data_date: '2026-10-22',
    },
  });
  const spec = buildObservationSpec({
    cohort,
    frozenAt: '2026-10-25T00:00:00.000Z',
  });
  return { cohort, spec };
}

function source(dataDate, extra = false) {
  return {
    kind: 'product_csv',
    path: `data/universe-${dataDate}.csv`,
    file_name: `universe-${dataDate}.csv`,
    file_date: dataDate,
    data_date: dataDate,
    sha256: `hash-${dataDate}-${extra ? 'extra' : 'base'}`,
    row_count: productsForDate(dataDate, { extra }).length,
  };
}

function comparison(unstable) {
  return {
    previous_data_date: '2026-10-22',
    current_data_date: '2026-10-29',
    gap_days: 7,
    buckets: {
      short: {
        top1_changed: unstable,
        top3_overlap_count: unstable ? 1 : 3,
        top3_overlap_ratio: unstable ? 1 / 3 : 1,
        top10_overlap_count: unstable ? 4 : 10,
        top10_overlap_ratio: unstable ? 0.4 : 1,
        rank_churn: {
          common_count: 12,
          changed_count: unstable ? 8 : 1,
          changed_ratio: unstable ? 0.6667 : 0.0833,
          spearman: unstable ? 0.5 : 0.95,
        },
      },
      medium: {
        top1_changed: false,
        top3_overlap_count: 3,
        top3_overlap_ratio: 1,
        top10_overlap_count: 10,
        top10_overlap_ratio: 1,
        rank_churn: {
          common_count: 12,
          changed_count: 1,
          changed_ratio: 0.0833,
          spearman: 0.95,
        },
      },
      long: {
        top1_changed: false,
        top3_overlap_count: 3,
        top3_overlap_ratio: 1,
        top10_overlap_count: 10,
        top10_overlap_ratio: 1,
        rank_churn: {
          common_count: 13,
          changed_count: 1,
          changed_ratio: 0.0769,
          spearman: 0.95,
        },
      },
    },
    forward_disclosed_return_proxy: null,
  };
}

function reviewRecord(index, unstable) {
  const dataDate = new Date(
    Date.parse('2026-10-29T00:00:00Z') + (index - 1) * 7 * 86400000,
  )
    .toISOString()
    .slice(0, 10);
  const previousDate =
    index === 1
      ? '2026-10-22'
      : new Date(
          Date.parse('2026-10-29T00:00:00Z') +
            (index - 2) * 7 * 86400000,
        )
          .toISOString()
          .slice(0, 10);
  const bucket = (highConcentration) => ({
    top1: ['SHORT01'],
    top3: ['SHORT01', 'SHORT02', 'SHORT03'],
    top10: Array.from({ length: 10 }, (_, item) => `SHORT${item + 1}`),
    old_top3: ['SHORT01', 'SHORT02', 'SHORT03'],
    top5_excess_share: highConcentration ? 0.8 : 0.3,
    single_window_top5: highConcentration
      ? [
          {
            code: OBSERVATION_THRESHOLDS.spotlight_code,
            evidence_tier: 'three_month',
          },
        ]
      : [],
  });
  return {
    schema_version: 1,
    observation_version: OBSERVATION_VERSION,
    sample_index: index,
    data_date: dataDate,
    policy_version: POLICY_VERSION,
    selection_version: SELECTION_VERSION,
    official_front_load_scheme: OFFICIAL_SCHEME,
    quality: {
      eligible: true,
      gap_days: 7,
      previous_data_date: previousDate,
      cohort_presence_ratio: 1,
      reportable_cohort_ratio: 1,
      candidate_counts: {
        short: 12,
        medium: 12,
        long: 12,
      },
      invariants: { passed: true },
    },
    source: {
      file_name: `universe-${dataDate}.csv`,
      path: `data/universe-${dataDate}.csv`,
    },
    metrics: {
      unavailable_ratio: unstable ? 0.18 : 0.05,
      buckets: {
        short: bucket(unstable),
        medium: bucket(false),
        long: bucket(false),
      },
      boundary: {
        bands: [
          {
            boundary: 30,
            empirical_sample_sufficient: true,
            lower_score_median: 2,
            upper_score_median: unstable ? 5 : 2.2,
          },
          {
            boundary: 100,
            empirical_sample_sufficient: true,
            lower_score_median: 2,
            upper_score_median: 2.1,
          },
        ],
      },
      spotlight_667828A: {
        single_window_top5: unstable,
      },
    },
    comparison: index > 1 ? comparison(unstable) : null,
  };
}

test('fixed cohort capture ignores universe expansion and rejects duplicate cadence', () => {
  const { cohort, spec } = fixture();
  const first = evaluateObservationCapture({
    products: productsForDate('2026-10-29', { extra: true }),
    source: source('2026-10-29', true),
    spec,
    cohort,
    records: [],
    generatedAt: '2026-10-29T00:00:00.000Z',
  });
  assert.equal(first.status, 'accepted');
  assert.equal(first.record.quality.cohort_extra_count, 1);
  assert.equal(first.record.quality.reportable_count, cohort.code_count);
  assert.equal(first.record.tracked_metrics['EXTRA-NOT-IN-COHORT'], undefined);
  assert.equal(first.record.metrics.spotlight_667828A.rank_B, 1);
  assert.equal(first.record.metrics.spotlight_667828A.bucket, 'long');
  assert.equal(
    first.record.metrics.spotlight_667828A.single_window_top5,
    true,
  );
  assert.equal(first.record.source.path, 'data/universe-2026-10-29.csv');

  const duplicate = evaluateObservationCapture({
    products: productsForDate('2026-10-29'),
    source: source('2026-10-29'),
    spec,
    cohort,
    records: [first.record],
    generatedAt: '2026-10-30T00:00:00.000Z',
  });
  assert.equal(duplicate.status, 'duplicate');
});

test('capture rejects non-weekly and low-coverage samples', () => {
  const { cohort, spec } = fixture();
  const nonWeekly = evaluateObservationCapture({
    products: productsForDate('2026-10-26'),
    source: source('2026-10-26'),
    spec,
    cohort,
    records: [],
  });
  assert.equal(nonWeekly.status, 'not_independent');
  assert.equal(nonWeekly.gap_days, 4);

  const accepted = evaluateObservationCapture({
    products: productsForDate('2026-10-29'),
    source: source('2026-10-29'),
    spec,
    cohort,
    records: [],
  });
  const broken = evaluateObservationCapture({
    products: productsForDate('2026-11-12'),
    source: source('2026-11-12'),
    spec,
    cohort,
    records: [accepted.record],
  });
  assert.equal(broken.status, 'cadence_broken');
  assert.equal(broken.gap_days, 14);
  assert.match(broken.message, /观察链已中断/);

  const lowCoverageProducts = productsForDate('2026-10-29').slice(0, 12);
  const lowCoverage = evaluateObservationCapture({
    products: lowCoverageProducts,
    source: {
      ...source('2026-10-29'),
      row_count: lowCoverageProducts.length,
    },
    spec,
    cohort,
    records: [],
  });
  assert.equal(lowCoverage.status, 'disqualified');
  assert.match(lowCoverage.message, /覆盖率/);
});

test('capture rejects high presence with insufficient scoring coverage', () => {
  const baselineProducts = productsForDate('2026-10-22');
  for (let index = 1; index <= 20; index += 1) {
    baselineProducts.push(
      product({
        code: `NODATA${String(index).padStart(2, '0')}`,
        name: `无有效收益产品${index}`,
        termDays: 30,
        dataDate: '2026-10-22',
      }),
    );
  }
  const cohort = buildCohortDefinition(baselineProducts, {
    frozenAt: '2026-10-25T00:00:00.000Z',
    baselineDataDate: '2026-10-22',
  });
  const spec = buildObservationSpec({
    cohort,
    frozenAt: '2026-10-25T00:00:00.000Z',
  });
  const laterProducts = baselineProducts.map((item) => ({
    ...item,
    data_date: '2026-10-29',
  }));
  const result = evaluateObservationCapture({
    products: laterProducts,
    source: source('2026-10-29'),
    spec,
    cohort,
    records: [],
  });
  assert.equal(result.status, 'disqualified');
  assert.match(result.message, /可评分覆盖率/);
  assert.ok(result.quality.reportable_cohort_ratio < 0.8);
});

test('review waits for four samples and then exposes predeclared triggers', () => {
  const { cohort, spec } = fixture();
  const collecting = reviewObservationLedger(
    [1, 2, 3].map((index) => reviewRecord(index, true)),
    spec,
    cohort,
  );
  assert.equal(collecting.status, 'collecting');
  assert.equal(collecting.review_status, 'collecting');
  assert.equal(collecting.remaining_samples, 1);

  const unstable = reviewObservationLedger(
    [1, 2, 3, 4].map((index) => reviewRecord(index, true)),
    spec,
    cohort,
  );
  assert.equal(unstable.ready_for_parameter_review, true);
  assert.equal(unstable.status, 'review_required');
  assert.equal(unstable.review_status, 'review_required');
  assert.ok(
    unstable.triggers.some(
      (item) => item.key === 'short_top5_concentration',
    ),
  );
  assert.ok(
    unstable.triggers.some(
      (item) => item.key === 'sustained_single_window_high_score',
    ),
  );
  assert.ok(
    unstable.triggers.some((item) => item.key === 'spotlight_667828A'),
  );
  assert.match(
    unstable.parameter_review_command,
    /--context stage6/,
  );
  assert.match(
    unstable.parameter_review_command,
    /--spec data\/yield-observations\/td-yield-002-observation-spec\.json/,
  );
  assert.match(
    unstable.parameter_review_command,
    /--cohort data\/yield-observations\/td-yield-002-cohort-v1\.json/,
  );
  assert.match(
    unstable.parameter_review_command,
    /data\/universe-2026-10-29\.csv/,
  );

  const stable = reviewObservationLedger(
    [1, 2, 3, 4].map((index) => reviewRecord(index, false)),
    spec,
    cohort,
  );
  assert.equal(stable.ready_for_parameter_review, true);
  assert.equal(stable.status, 'continue_current_policy');
  assert.equal(stable.review_status, 'continue_current_policy');
  assert.equal(stable.triggers.length, 0);
  assert.equal(stable.formal_weight_change, false);

  const preferred = reviewObservationLedger(
    Array.from({ length: 8 }, (_, index) =>
      reviewRecord(index + 1, false),
    ),
    spec,
    cohort,
  );
  assert.equal(preferred.status, 'review_required');
  assert.equal(preferred.preferred_samples_reached, true);
  assert.equal(preferred.remaining_preferred_samples, 0);
  assert.ok(
    preferred.triggers.some(
      (item) => item.key === 'preferred_sample_count_reached',
    ),
  );
});

test('review uses only the latest three comparisons for ranking stability', () => {
  const { cohort, spec } = fixture();
  const records = [1, 2, 3, 4, 5].map((index) =>
    reviewRecord(index, index <= 3),
  );
  const review = reviewObservationLedger(records, spec, cohort);
  assert.equal(
    review.triggers.some(
      (item) => item.key === 'short_ranking_instability',
    ),
    false,
  );
  assert.equal(
    review.triggers.some((item) => item.key === 'short_rank_churn'),
    false,
  );
});

test('review rejects duplicate or non-weekly ledger dates', () => {
  const { cohort, spec } = fixture();
  const duplicateRecords = [1, 2, 3, 4].map((index) =>
    reviewRecord(index, false),
  );
  duplicateRecords[1].data_date = duplicateRecords[0].data_date;
  const duplicateReview = reviewObservationLedger(
    duplicateRecords,
    spec,
    cohort,
  );
  assert.equal(duplicateReview.status, 'ledger_invalid');
  assert.equal(duplicateReview.ready_for_parameter_review, false);
  assert.ok(
    duplicateReview.ledger_issues.some(
      (item) => item.code === 'duplicate_data_date',
    ),
  );

  const closeRecord = reviewRecord(1, false);
  closeRecord.data_date = '2026-10-23';
  const closeReview = reviewObservationLedger([closeRecord], spec, cohort);
  assert.equal(closeReview.status, 'ledger_invalid');
  assert.ok(
    closeReview.ledger_issues.some(
      (item) => item.code === 'invalid_sample_gap',
    ),
  );
});

test('review rejects invalid calendar dates and stored quality overrides', () => {
  const { cohort, spec } = fixture();
  const invalidDate = reviewRecord(1, false);
  invalidDate.data_date = '2026-02-31';
  const invalidDateReview = reviewObservationLedger(
    [invalidDate],
    spec,
    cohort,
  );
  assert.equal(invalidDateReview.status, 'ledger_invalid');
  assert.ok(
    invalidDateReview.ledger_issues.some(
      (item) => item.code === 'invalid_data_date',
    ),
  );

  const falseQuality = reviewRecord(1, false);
  falseQuality.quality.cohort_presence_ratio = 0;
  falseQuality.quality.candidate_counts.short = 0;
  falseQuality.quality.invariants.passed = false;
  const qualityReview = reviewObservationLedger(
    [falseQuality],
    spec,
    cohort,
  );
  assert.equal(qualityReview.status, 'ledger_invalid');
  assert.ok(
    qualityReview.ledger_issues.some(
      (item) => item.code === 'stored_quality_failed',
    ),
  );
});

test('rank churn and forward proxy handle sparse or missing values', () => {
  const previous = reviewRecord(1, false);
  const current = reviewRecord(2, false);
  const rankMap = (short) => ({
    short,
    medium: { MEDIUM01: 1, MEDIUM02: 2, MEDIUM03: 3 },
    long: { LONG01: 1, LONG02: 2, LONG03: 3 },
  });
  previous.rank_map_by_bucket = rankMap({ A: 1, B: 3, C: 5 });
  current.rank_map_by_bucket = rankMap({ A: 1, B: 2, C: 3 });
  current.tracked_metrics = {
    SHORT01: { return_1m: 2 },
    SHORT02: { return_1m: null },
    SHORT03: { return_1m: 4 },
    MEDIUM01: { return_1m: 2 },
    MEDIUM02: { return_1m: null },
    MEDIUM03: { return_1m: 4 },
    LONG01: { return_1m: 2 },
    LONG02: { return_1m: null },
    LONG03: { return_1m: 4 },
  };
  const compared = compareObservationRecords(previous, current);
  assert.equal(compared.buckets.short.rank_churn.spearman, 1);
  assert.equal(
    compared.forward_disclosed_return_proxy.short.official_top3_coverage,
    2,
  );
  assert.equal(
    compared.forward_disclosed_return_proxy.short.official_top3_total,
    3,
  );
  assert.equal(
    compared.forward_disclosed_return_proxy.short
      .official_top3_mean_return_1m,
    3,
  );
});

test('review rejects a tampered cohort even when the stored hash is unchanged', () => {
  const { cohort, spec } = fixture();
  cohort.codes[0] = 'TAMPERED';
  assert.throws(
    () => reviewObservationLedger([], spec, cohort),
    /代码清单哈希不匹配/,
  );
});

test('initialized observation spec and cohort cannot be overwritten', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-observation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const initialized = initializeObservationStore({
    root,
    inputPath: productCsv,
    generatedAt: '2026-10-25T00:00:00.000Z',
  });
  assert.equal(initialized.cohort.baseline_data_date, '2026-10-22');
  assert.ok(initialized.cohort.code_count > 600);
  assert.equal(
    fs.existsSync(initialized.paths.ledger),
    true,
  );
  assert.throws(
    () =>
      initializeObservationStore({
        root,
        inputPath: productCsv,
        generatedAt: '2026-10-26T00:00:00.000Z',
      }),
    /不覆盖已冻结文件/,
  );
  const review = reviewFromStore({ root });
  assert.equal(review.status, 'collecting');
  assert.equal(review.sample_count, 0);
  const options = parseArgs([
    'capture',
    '--input',
    productCsv,
    '--root',
    root,
    '--dry-run',
    '--json',
  ]);
  assert.equal(options.command, 'capture');
  assert.equal(options.dryRun, true);
  assert.equal(options.json, true);

  const reviewOptions = parseArgs(['review', '--root', root]);
  assert.equal(reviewOptions.command, 'review');
  assert.equal(reviewOptions.input, null);
});

test('capture is serialized and dry-run never appends a sample', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-observation-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const initialized = initializeObservationStore({
    root,
    inputPath: productCsv,
    generatedAt: '2026-10-25T00:00:00.000Z',
  });
  const laterCsv = path.join(root, 'universe-2026-10-29.csv');
  fs.writeFileSync(
    laterCsv,
    fs
      .readFileSync(productCsv, 'utf8')
      .replaceAll('2026-10-22', '2026-10-29'),
    'utf8',
  );

  const dryRun = captureObservationFromFile({
    root,
    inputPath: laterCsv,
    generatedAt: '2026-10-29T00:00:00.000Z',
    dryRun: true,
  });
  assert.equal(dryRun.status, 'accepted');
  assert.equal(readObservationLedger(initialized.paths.ledger).length, 0);

  const lockPath = `${initialized.paths.ledger}.lock`;
  fs.writeFileSync(lockPath, 'busy', 'utf8');
  assert.throws(
    () =>
      captureObservationFromFile({
        root,
        inputPath: laterCsv,
        generatedAt: '2026-10-29T00:00:00.000Z',
        lockWaitMs: 0,
      }),
    /正在被其他进程写入/,
  );
  fs.unlinkSync(lockPath);

  const accepted = captureObservationFromFile({
    root,
    inputPath: laterCsv,
    generatedAt: '2026-10-29T00:00:00.000Z',
  });
  const duplicate = captureObservationFromFile({
    root,
    inputPath: laterCsv,
    generatedAt: '2026-10-30T00:00:00.000Z',
  });
  assert.equal(accepted.status, 'accepted');
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(readObservationLedger(initialized.paths.ledger).length, 1);
});
