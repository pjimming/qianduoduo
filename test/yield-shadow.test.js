'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BUCKET_WEIGHTS,
  FRONT_LOAD_SCHEMES,
  WRITE_POLICY,
  bucketForTerm,
  buildYieldShadowReport,
  calculateReferenceYield,
  calculateShadowScore,
  frontLoadDeduction,
  roundHalfAwayFromZero,
} = require('../lib/yield-shadow');
const {
  FRONTLOAD_GAP_CASES,
  REFERENCE_YIELD_CASES,
  ROUNDING_CASES,
  SCORE_CASES,
  TERM_BOUNDARY_CASES,
} = require('./helpers/td-yield-001-cases');
const { loadProductsFromCsv } = require('../lib/products');
const { productCsv } = require('./fixtures');

function product({
  code,
  termDays,
  returns = {},
  historyMonths = 24,
  name = `${code}测试产品`,
} = {}) {
  return {
    name,
    code,
    short_name: '',
    issuer: '招银理财',
    risk_level: 'R2',
    currency_code: '10',
    pub_prv: 'A',
    soc_tag: 'C',
    product_type: '代销理财',
    term_days: termDays,
    score: null,
    min_amount: 1,
    annualized_yield: 3,
    benchmark: '测试基准',
    return_1m: returns.return_1m ?? null,
    return_3m: returns.return_3m ?? null,
    return_6m: returns.return_6m ?? null,
    return_1y: returns.return_1y ?? null,
    return_since_inception: 3,
    status: '开放中',
    source: 'test',
    data_date: '2026-10-22',
    notes: '',
    capacity: null,
    history_months: historyMonths,
    fee_bps: 10,
    next_open_date: '2026-10-26',
  };
}

test('shadow bucket contract matches the frozen term boundaries', () => {
  for (const item of TERM_BOUNDARY_CASES) {
    assert.equal(bucketForTerm(item.term_days), item.expected_bucket);
  }
  assert.equal(bucketForTerm(0), 'cash');
  assert.equal(bucketForTerm(1), 'short');
});

test('shadow reference calculator matches every phase-one case', () => {
  for (const item of REFERENCE_YIELD_CASES) {
    const actual = calculateReferenceYield(item.bucket, item.returns);
    assert.deepEqual(
      {
        status: actual.status,
        reason: actual.reason,
        value_pct: actual.value_pct,
        available_horizons: actual.available_horizons,
        missing_horizons: actual.missing_horizons,
        weight_sum: actual.weight_sum,
      },
      item.expected,
      item.name,
    );
  }
  assert.deepEqual(BUCKET_WEIGHTS.long, {
    return_3m: 0.2,
    return_6m: 0.4,
    return_1y: 0.4,
  });
});

test('shadow rounding and A/B/C deductions match the frozen cases', () => {
  for (const item of ROUNDING_CASES) {
    assert.equal(roundHalfAwayFromZero(item.value), item.expected);
  }
  for (const item of FRONTLOAD_GAP_CASES) {
    for (const scheme of ['A', 'B', 'C']) {
      assert.ok(
        Math.abs(
          frontLoadDeduction('long', { return_1y: item.gap_pp + 2, return_6m: 2 }, scheme) -
            item.expected[scheme],
        ) < 1e-12,
      );
    }
  }
  assert.equal(FRONT_LOAD_SCHEMES.C.long, null);
});

test('shadow score calculator matches the phase-one A/B/C score cases', () => {
  for (const item of SCORE_CASES) {
    const input = {
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
    const actual = calculateShadowScore(input, item.bucket);
    assert.equal(actual.reference.value_pct, item.expected.reference_yield_pct);
    assert.equal(actual.observation_score, item.expected.observation_score);
    assert.deepEqual(actual.selection_scores, item.expected.selection_score);
  }
});

test('shadow report produces old/new rows without mutating inputs or formal state', () => {
  const products = [
    product({
      code: 'CASH000',
      termDays: 0,
      returns: { return_1m: 2, return_3m: 3, return_6m: 4, return_1y: 5 },
    }),
    product({
      code: 'DAY0001',
      termDays: 1,
      historyMonths: 8,
      returns: { return_1m: 2, return_3m: 3, return_6m: 4 },
    }),
    product({
      code: 'SHORT030',
      termDays: 30,
      historyMonths: 8,
      returns: { return_1m: 2, return_3m: 3, return_6m: 4 },
    }),
    product({
      code: 'MEDIUM90',
      termDays: 90,
      returns: { return_1m: 3, return_3m: 2, return_6m: 3, return_1y: 4 },
    }),
    product({
      code: 'LONG0180',
      termDays: 180,
      returns: { return_1m: 1, return_3m: 2, return_6m: 3, return_1y: 5 },
    }),
    product({
      code: 'NEWONLY1',
      termDays: 7,
      historyMonths: 2,
      returns: { return_1m: 3 },
    }),
  ];
  const before = structuredClone(products);
  const report = buildYieldShadowReport({
    products,
    source: { kind: 'test', file_name: 'fixture.csv' },
    generatedAt: '2026-10-25T00:00:00.000Z',
  });
  assert.deepEqual(products, before);
  assert.deepEqual(report.write_policy, WRITE_POLICY);
  assert.equal(report.summary.total_products, 6);
  assert.equal(report.summary.old_observation_ready, 5);
  assert.equal(report.summary.old_ranking_candidates, 3);
  assert.equal(report.summary.new_ranking_candidates, 4);
  assert.equal(report.summary.candidate_changes.removed_count, 1);
  assert.equal(report.summary.candidate_changes.removed[0].code, 'CASH000');
  assert.equal(report.summary.candidate_changes.removed[0].reason, 'cash_excluded');

  const cash = report.rows.find((row) => row.code === 'CASH000');
  assert.equal(cash.new_bucket, 'cash');
  assert.equal(cash.new_observation_score, null);
  assert.equal(cash.selection_score_A, null);
  assert.equal(cash.new_ranking_candidate, false);
  assert.equal(cash.new_weighted_yield_pct, cash.new_reference_yield_pct);
  assert.ok(Number.isFinite(cash.old_selection_score));

  const oneDay = report.rows.find((row) => row.code === 'DAY0001');
  assert.equal(oneDay.old_bucket, 'cash');
  assert.equal(oneDay.new_bucket, 'short');
  assert.equal(oneDay.bucket_changed, true);
  assert.equal(oneDay.old_ranking_candidate, false);
  assert.equal(oneDay.new_ranking_candidate, true);
  assert.equal(oneDay.new_reference_yield_pct, 3.1);
  assert.equal(oneDay.new_weighted_yield_pct, 3.1);

  const oneMonthOnly = report.rows.find((row) => row.code === 'NEWONLY1');
  assert.equal(oneMonthOnly.new_reference_yield_status, 'available');
  assert.equal(oneMonthOnly.new_ranking_candidate, false);

  const long = report.rows.find((row) => row.code === 'LONG0180');
  assert.notEqual(long.selection_score_A, long.selection_score_B);
  assert.notEqual(long.selection_score_B, long.selection_score_C);
});

test('current snapshot shadow output is finite, aliased and consistently ranked', () => {
  const products = loadProductsFromCsv(productCsv);
  const before = structuredClone(products);
  const report = buildYieldShadowReport({
    products,
    source: { kind: 'test-current-snapshot' },
    generatedAt: '2026-10-25T00:00:00.000Z',
  });
  assert.deepEqual(products, before);
  assert.ok(report.rows.length > 0);
  assert.equal(report.rows.length, report.summary.total_products);
  for (const row of report.rows) {
    assert.equal(row.new_weighted_yield_pct, row.new_reference_yield_pct);
    if (row.new_reference_yield_status === 'unavailable') {
      assert.equal(row.new_reference_yield_pct, null);
    } else {
      assert.ok(Number.isFinite(row.new_reference_yield_pct));
    }
    if (row.new_bucket === 'cash') {
      assert.equal(row.new_observation_score, null);
      assert.equal(row.selection_score_A, null);
      assert.equal(row.selection_score_B, null);
      assert.equal(row.selection_score_C, null);
      assert.equal(row.new_ranking_candidate, false);
    }
  }
  for (const scheme of ['old', 'A', 'B', 'C']) {
    for (const bucket of ['short', 'medium', 'long']) {
      const bucketKey = scheme === 'old' ? 'old_bucket' : 'new_bucket';
      const ranks = report.rows
        .filter((row) => row[bucketKey] === bucket)
        .map((row) => row.ranking[scheme].rank)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      assert.deepEqual(
        ranks,
        Array.from({ length: ranks.length }, (_, index) => index + 1),
        `${scheme}:${bucket}`,
      );
    }
  }
});
