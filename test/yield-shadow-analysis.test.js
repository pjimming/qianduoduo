'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadProductsFromCsv } = require('../lib/products');
const { buildYieldShadowReport } = require('../lib/yield-shadow');
const {
  DIAGNOSTIC_WRITE_POLICY,
  analyzeProductionConsistency,
  analyzeSnapshot,
  buildShadowBacktestReport,
  compareSnapshots,
  projectedCandidateVerdict,
} = require('../lib/yield-shadow-analysis');

function snapshotFiles() {
  return fs
    .readdirSync(path.join(__dirname, '..', 'data'))
    .filter((name) => /^cmb_r2_universe.*\.csv$/i.test(name))
    .sort()
    .map((name) => path.join(__dirname, '..', 'data', name));
}

function buildReport(filePath) {
  return buildYieldShadowReport({
    products: loadProductsFromCsv(filePath),
    generatedAt: '2026-10-25T00:00:00.000Z',
    source: {
      kind: 'product_csv',
      file_name: path.basename(filePath),
      path: path.relative(path.join(__dirname, '..'), filePath).replaceAll('\\', '/'),
    },
  });
}

test('snapshot analysis verifies invariants, missing windows and score diagnostics', () => {
  const filePath = snapshotFiles().at(-1);
  const report = buildReport(filePath);
  const analysis = analyzeSnapshot(report, { label: path.basename(filePath) });
  assert.equal(analysis.invariants.passed, true);
  assert.equal(analysis.counts.products, report.rows.length);
  assert.equal(
    analysis.missing_windows.status_counts.available +
      analysis.missing_windows.status_counts.unavailable,
    report.rows.length,
  );
  for (const bucket of ['short', 'medium', 'long']) {
    assert.ok(analysis.buckets[bucket].scores.candidate_count > 0);
    assert.ok(Array.isArray(analysis.buckets[bucket].scores.outliers));
    assert.ok(analysis.buckets[bucket].ranks.A.changed_count >= 0);
  }
  assert.ok(Object.keys(analysis.boundary.exact_term_counts).includes('101'));
});

test('snapshot comparison distinguishes data refresh from pure universe expansion', () => {
  const files = snapshotFiles();
  const reports = files.map((file) => ({
    label: path.basename(file),
    report: buildReport(file),
  }));
  const transition = compareSnapshots(reports.at(-2), reports.at(-1));
  assert.equal(transition.same_data_date, true);
  assert.equal(transition.interpretation, 'same_product_data_with_universe_expansion');
  assert.equal(transition.common_reference_max_abs_delta, 0);
  assert.ok(transition.added_codes > 0);
  assert.equal(transition.common_rank_changed, transition.common_comparable_ranks);
});

test('multi-snapshot backtest builds a reviewable anomaly register without writes', () => {
  const snapshots = snapshotFiles().map((file) => ({
    label: path.basename(file),
    report: buildReport(file),
  }));
  const analysis = buildShadowBacktestReport({
    snapshots,
    generatedAt: '2026-10-25T00:00:00.000Z',
  });
  assert.equal(analysis.snapshot_count, snapshots.length);
  assert.equal(analysis.snapshots.every((item) => item.invariants.passed), true);
  assert.equal(analysis.transitions.length, snapshots.length - 1);
  assert.ok(analysis.anomalies.items.length > 0);
  assert.deepEqual(analysis.write_policy, DIAGNOSTIC_WRITE_POLICY);
  assert.match(analysis.conclusion, /不选择 A\/B\/C/);
});

test('holding-review projection surfaces current cross-module drift and verdict changes', () => {
  const filePath = snapshotFiles().at(-1);
  const report = buildReport(filePath);
  const current = report.rows.find((row) => row.code === 'JX040210');
  const candidate = report.rows.find((row) => row.code === '134022A');
  const dashboard = {
    meta: { product_snapshot_date: report.snapshot_date },
    workspace: {
      holding_reviews: [
        {
          product_code: current.code,
          product_name: current.name,
          amount: 1000,
          horizon_days: 30,
          current: { yield_pct: current.old_reference_yield_pct },
          review_setting: {
            redemption_fee_bps: 0,
            purchase_fee_bps: 0,
          },
          candidates: [
            {
              code: candidate.code,
              name: candidate.name,
              yield_pct: candidate.old_reference_yield_pct,
              yield_gap_pp: -1,
              verdict: 'hold',
              switch_wait_days: 0,
              min_gain_amount: 1,
              evidence_single_cap_amount: null,
            },
          ],
        },
      ],
    },
  };
  const projection = analyzeProductionConsistency(report, dashboard);
  assert.equal(projection.status, 'projection_only_not_integrated');
  assert.equal(projection.current_yield_changed_count, 1);
  assert.equal(projection.candidate_yield_changed_count, 1);
  assert.equal(projection.verdict_changed_count, 1);
  assert.equal(projection.verdict_changes[0].old_verdict, 'hold');
  assert.equal(projection.verdict_changes[0].shadow_verdict, 'watch');
  const direct = projectedCandidateVerdict({
    currentYieldPct: current.new_reference_yield_pct,
    newYieldPct: candidate.new_reference_yield_pct,
    amount: 1000,
    horizonDays: 30,
    setting: { redemption_fee_bps: 0, purchase_fee_bps: 0 },
    candidate: dashboard.workspace.holding_reviews[0].candidates[0],
  });
  assert.equal(direct.verdict, 'watch');
});
