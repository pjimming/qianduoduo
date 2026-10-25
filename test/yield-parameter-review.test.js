'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadProductsFromCsv } = require('../lib/products');
const {
  REVIEW_WRITE_POLICY,
  SELECTED_BUCKET_WEIGHTS,
  SELECTED_LONG_SCHEME,
  SELECTED_SHORT_VARIANT,
  buildParameterReviewReport,
} = require('../lib/yield-parameter-review');
const { productCsv } = require('./fixtures');

function snapshots() {
  return fs
    .readdirSync(path.join(__dirname, '..', 'data'))
    .filter((name) => /^cmb_r2_universe.*\.csv$/i.test(name))
    .sort()
    .map((name) => {
      const filePath = path.join(__dirname, '..', 'data', name);
      return {
        label: name,
        products: loadProductsFromCsv(filePath),
        source: {
          kind: 'product_csv',
          file_name: name,
          path: path
            .relative(path.join(__dirname, '..'), filePath)
            .replaceAll('\\', '/'),
        },
      };
    });
}

function stage6Fixture() {
  const observationDir = path.join(
    __dirname,
    '..',
    'data',
    'yield-observations',
  );
  const observationSpec = JSON.parse(
    fs.readFileSync(
      path.join(observationDir, 'td-yield-002-observation-spec.json'),
      'utf8',
    ),
  );
  const cohort = JSON.parse(
    fs.readFileSync(
      path.join(observationDir, 'td-yield-002-cohort-v1.json'),
      'utf8',
    ),
  );
  const baseProducts = loadProductsFromCsv(productCsv);
  const dated = (date, extra = null) => {
    const products = baseProducts.map((product) => ({
      ...product,
      data_date: date,
    }));
    if (extra) products.push(extra);
    return {
      label: `universe-${date}.csv`,
      products,
      report_date: date,
      source: {
        kind: 'product_csv',
        file_name: `universe-${date}.csv`,
        path: `data/universe-${date}.csv`,
        row_count: products.length,
      },
    };
  };
  return {
    observationSpec,
    cohort,
    snapshots: [
      dated('2026-10-29'),
      dated('2026-11-05', {
        ...baseProducts[0],
        code: 'EXTRA-NOT-IN-COHORT',
        name: '扩池产品',
        data_date: '2026-11-05',
        return_1m: 99,
        return_3m: 99,
        return_6m: 99,
        return_1y: 99,
      }),
    ],
  };
}

test('short weight review selects 20/50/30 and improves stress metrics', () => {
  const report = buildParameterReviewReport({
    snapshots: snapshots(),
    generatedAt: '2026-10-25T00:00:00.000Z',
  });
  assert.equal(SELECTED_SHORT_VARIANT, 'selected_20_50_30');
  assert.deepEqual(SELECTED_BUCKET_WEIGHTS.short, {
    return_1m: 0.2,
    return_3m: 0.5,
    return_6m: 0.3,
  });
  const original =
    report.short_weight_options.original_50_30_20.aggregate;
  const selected =
    report.short_weight_options.selected_20_50_30.aggregate;
  assert.ok(selected.max_score_across_snapshots < original.max_score_across_snapshots);
  assert.ok(selected.average_spearman_vs_old > original.average_spearman_vs_old);
  assert.ok(
    selected.average_mean_absolute_score_delta <
      original.average_mean_absolute_score_delta,
  );
  assert.ok(
    selected.top3_preserved_snapshot_count >=
      original.top3_preserved_snapshot_count,
  );
  for (const weights of Object.values(report.short_weight_options)) {
    const sum = Object.values(weights.weights).reduce(
      (total, value) => total + value,
      0,
    );
    assert.ok(Math.abs(sum - 1) < 1e-12);
  }
});

test('long review selects B with stable top three and lower rank churn', () => {
  const report = buildParameterReviewReport({
    snapshots: snapshots(),
    generatedAt: '2026-10-25T00:00:00.000Z',
  });
  assert.equal(SELECTED_LONG_SCHEME, 'B');
  const bOption = report.long_frontload_options.B;
  const a = report.long_frontload_options.A.aggregate;
  const b = bOption.aggregate;
  const c = report.long_frontload_options.C.aggregate;
  assert.equal(b.top3_same_as_A_snapshot_count, 3);
  assert.ok(b.average_rank_changed <= a.average_rank_changed);
  assert.ok(b.average_rank_changed < c.average_rank_changed);
  assert.ok(bOption.pairwise_to_A.max_positive_score_delta <= 0.075);
});

test('selected parameters retain non-short weights and keep the review read-only', () => {
  const report = buildParameterReviewReport({
    snapshots: snapshots(),
    generatedAt: '2026-10-25T00:00:00.000Z',
  });
  assert.deepEqual(SELECTED_BUCKET_WEIGHTS.cash, {
    return_1m: 0.7,
    return_3m: 0.3,
  });
  assert.deepEqual(SELECTED_BUCKET_WEIGHTS.medium, {
    return_3m: 0.5,
    return_6m: 0.3,
    return_1y: 0.2,
  });
  assert.deepEqual(SELECTED_BUCKET_WEIGHTS.long, {
    return_3m: 0.2,
    return_6m: 0.4,
    return_1y: 0.4,
  });
  assert.equal(report.decision.short_weights.outcome, 'adjusted_down');
  assert.equal(report.decision.long_frontload.outcome, 'select_B');
  assert.deepEqual(report.write_policy, REVIEW_WRITE_POLICY);
  assert.deepEqual(report.production_projection.selected.status, 'not_checked');
  assert.match(report.conclusion, /阶段 5/);
});

test('stage-six review uses neutral out-of-sample conclusions', () => {
  const fixture = stage6Fixture();
  const report = buildParameterReviewReport({
    snapshots: fixture.snapshots,
    generatedAt: '2026-10-25T00:00:00.000Z',
    reviewContext: 'stage6',
    observationSpec: fixture.observationSpec,
    cohort: fixture.cohort,
  });
  assert.equal(report.review_context.id, 'stage6');
  assert.equal(report.review_context.snapshot_count, 2);
  assert.equal(
    report.review_context.cohort.code_count,
    fixture.cohort.code_count,
  );
  assert.equal(report.snapshots[1].product_count, fixture.cohort.code_count);
  assert.equal(report.snapshots[1].cohort_quality.extra_count, 1);
  assert.match(report.conclusion, /规格后快照/);
  assert.doesNotMatch(report.conclusion, /阶段 5/);
  assert.ok(
    report.residual_risks.some((item) => /实际持有收益/.test(item)),
  );
  assert.equal(report.decision.short_weights.outcome, 'decision_required');
  assert.equal(report.decision.long_frontload.outcome, 'decision_required');
  assert.equal(report.write_policy.formal_scoring_written, false);
});

test('stage-six review rejects snapshots outside the frozen cohort coverage', () => {
  const fixture = stage6Fixture();
  assert.throws(
    () =>
      buildParameterReviewReport({
        snapshots: snapshots(),
        generatedAt: '2026-10-25T00:00:00.000Z',
        reviewContext: 'stage6',
        observationSpec: fixture.observationSpec,
        cohort: fixture.cohort,
      }),
    /固定 cohort 覆盖率/,
  );
});

test('stage-six parameter review rejects duplicate or off-cadence sample dates', () => {
  const fixture = stage6Fixture();
  fixture.snapshots[1].products = fixture.snapshots[1].products.map(
    (product) => ({
      ...product,
      data_date: '2026-10-29',
    }),
  );
  assert.throws(
    () =>
      buildParameterReviewReport({
        snapshots: fixture.snapshots,
        generatedAt: '2026-10-25T00:00:00.000Z',
        reviewContext: 'stage6',
        observationSpec: fixture.observationSpec,
        cohort: fixture.cohort,
      }),
    /独立周样本间隔要求/,
  );
});
