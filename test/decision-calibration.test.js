'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  appendPredictionVersion,
  buildCalibrationReport,
  buildPrediction,
  evaluatePrediction,
} = require('../lib/decision-calibration');

function prediction(overrides = {}) {
  return buildPrediction({
    recommendation_type: 'cash_allocation',
    action: '买入',
    source: 'platform',
    source_ref: 'proposal:test',
    created_at: '2026-01-01T08:00:00.000Z',
    start_date: '2026-01-01',
    review_date: '2026-01-31',
    confidence: 80,
    baseline: {
      metric: 'personal_annualized_return_pct',
      value: 0,
      unit: '%',
    },
    expected: {
      direction: 'at_least',
      target: { point: 3, unit: '%' },
    },
    metric: 'personal_annualized_return_pct',
    evaluation: {
      minimum_observations: 3,
      minimum_coverage_ratio: 0.5,
      tolerance_pp: 0.15,
    },
    invalidation_condition: '决策取消',
    invalidation_triggers: ['decision_cancelled'],
    ...overrides,
  });
}

function valuations(dailyPnl = 1, days = 31) {
  return Array.from({ length: days }, (_, index) => ({
    id: index + 1,
    yield_date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    product_code: 'P001',
    daily_pnl: dailyPnl,
    holding_amount: 1000,
  }));
}

function confirmedTrade() {
  return {
    id: 1,
    decision_id: 1,
    trade_type: 'buy',
    status: 'confirmed',
    confirm_date: '2026-01-01',
    product_code: 'P001',
    amount: 1000,
  };
}

test('prediction outcomes distinguish hit, miss, pending, invalidation and evidence gaps', () => {
  const base = prediction();
  const decision = { id: 1, review_meta: { lifecycle_status: 'accepted' } };
  const hit = evaluatePrediction({
    prediction: base,
    decision,
    trades: [confirmedTrade()],
    valuations: valuations(1),
    today: '2026-01-31',
  });
  assert.equal(hit.status, 'hit');
  assert.equal(hit.classification, 'direction_hit');
  assert.ok(hit.actual > 3);
  const late = evaluatePrediction({
    prediction: base,
    decision,
    trades: [confirmedTrade()],
    valuations: valuations(1),
    today: '2026-02-15',
  });
  assert.equal(late.status, 'hit');
  assert.equal(late.data_as_of, '2026-01-31');

  const miss = evaluatePrediction({
    prediction: base,
    decision,
    trades: [confirmedTrade()],
    valuations: valuations(0.001),
    today: '2026-01-31',
  });
  assert.equal(miss.status, 'miss');
  assert.equal(miss.classification, 'direction_error');

  const pending = evaluatePrediction({
    prediction: base,
    decision,
    trades: [confirmedTrade()],
    valuations: [],
    today: '2026-01-15',
  });
  assert.equal(pending.status, 'pending');

  const invalidated = evaluatePrediction({
    prediction: base,
    decision: { id: 1, review_meta: { lifecycle_status: 'cancelled' } },
    trades: [confirmedTrade()],
    valuations: valuations(1),
    today: '2026-01-31',
  });
  assert.equal(invalidated.status, 'invalidated');

  const insufficient = evaluatePrediction({
    prediction: base,
    decision,
    trades: [confirmedTrade()],
    valuations: valuations(1, 2),
    today: '2026-01-31',
  });
  assert.equal(insufficient.status, 'insufficient_data');
  assert.equal(insufficient.classification, 'insufficient_data');

  const evidenceGap = evaluatePrediction({
    prediction: base,
    decision,
    trades: [confirmedTrade()],
    valuations: [],
    today: '2026-01-31',
  });
  assert.equal(evidenceGap.status, 'insufficient_data');
  assert.equal(evidenceGap.classification, 'evidence_gap');
});

test('prediction outcomes support range checks and execution amount checks', () => {
  const range = prediction({
    expected: {
      direction: 'within',
      target: { min: -50, max: 100, unit: '%' },
    },
  });
  const rangeResult = evaluatePrediction({
    prediction: range,
    decision: { id: 1, review_meta: { lifecycle_status: 'accepted' } },
    trades: [confirmedTrade()],
    valuations: valuations(1),
    today: '2026-01-31',
  });
  assert.equal(rangeResult.status, 'hit');
  assert.equal(rangeResult.classification, 'range_hit');

  const execution = prediction({
    metric: 'executed_amount',
    baseline: { metric: 'executed_amount', value: 0, unit: '元' },
    expected: {
      direction: 'at_least',
      target: { point: 1000, unit: '元' },
    },
    evaluation: { method: 'confirmed_trade_amount', tolerance_abs: 1 },
  });
  const executionResult = evaluatePrediction({
    prediction: execution,
    decision: { id: 1, review_meta: { lifecycle_status: 'accepted' } },
    trades: [confirmedTrade()],
    valuations: [],
    today: '2026-01-31',
  });
  assert.equal(executionResult.status, 'hit');
  assert.equal(executionResult.actual, 1000);
});

test('prediction versions append without changing the original record', () => {
  const first = prediction();
  const second = appendPredictionVersion([first], {
    recommendation_type: first.recommendation_type,
    action: first.action,
    source: 'human-correction',
    source_ref: first.source_ref,
    created_at: '2026-01-05T08:00:00.000Z',
    start_date: '2026-01-01',
    review_date: '2026-01-31',
    confidence: 70,
    baseline: first.baseline,
    expected: {
      direction: 'at_least',
      target: { point: 2, unit: '%' },
    },
    metric: first.evaluation.metric,
    evaluation: first.evaluation,
    invalidation_condition: first.invalidation_condition,
    invalidation_triggers: first.invalidation_triggers,
  });
  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(second.series_id, first.series_id);
  assert.notEqual(second.id, first.id);
  assert.equal(first.expected.target.point, 3);
  assert.equal(second.expected.target.point, 2);
});

test('monthly calibration aggregates confidence buckets and excludes pending from hit rate', () => {
  const one = prediction({ source_ref: 'proposal:one', confidence: 80 });
  const two = prediction({ source_ref: 'proposal:two', confidence: 60 });
  const three = prediction({ source_ref: 'proposal:three', confidence: 80 });
  const decisions = [
    {
      id: 1,
      product_name: '命中',
      action: '买入',
      rating: '待评估',
      review_meta: {
        lifecycle_status: 'accepted',
        predictions: [one],
        prediction_results: {
          [one.id]: evaluatePrediction({
            prediction: one,
            decision: { id: 1 },
            trades: [{ ...confirmedTrade(), decision_id: 1 }],
            valuations: valuations(1),
            today: '2026-01-31',
          }),
        },
      },
    },
    {
      id: 2,
      product_name: '未命中',
      action: '买入',
      rating: '待评估',
      review_meta: {
        lifecycle_status: 'accepted',
        predictions: [two],
        prediction_results: {
          [two.id]: evaluatePrediction({
            prediction: two,
            decision: { id: 2 },
            trades: [{ ...confirmedTrade(), id: 2, decision_id: 2 }],
            valuations: valuations(0.001),
            today: '2026-01-31',
          }),
        },
      },
    },
    {
      id: 3,
      product_name: '待验证',
      action: '买入',
      rating: '待评估',
      review_meta: {
        lifecycle_status: 'accepted',
        predictions: [three],
        prediction_results: {
          [three.id]: evaluatePrediction({
            prediction: three,
            decision: { id: 3 },
            trades: [],
            valuations: [],
            today: '2026-01-31',
          }),
        },
      },
    },
  ];
  const report = buildCalibrationReport({
    month: '2026-01',
    today: '2026-01-31',
    decisions,
    proposals: [],
    trades: [],
    valuations: [],
  });
  assert.equal(report.total, 3);
  assert.equal(report.by_type[0].evaluated, 2);
  assert.equal(report.by_type[0].hit_rate, 0.5);
  assert.equal(report.by_type[0].pending + report.by_type[0].not_executed, 1);
  assert.ok(report.by_confidence.some((item) => item.key === 'high'));
  assert.ok(report.error_sources.some((item) => item.source === '预测命中'));
  assert.ok(report.error_sources.some((item) => item.source === '执行偏差'));
  assert.ok(report.by_action.length > 0);
  assert.ok(report.by_horizon.length > 0);
  assert.deepEqual(
    buildCalibrationReport({
      month: '2026-01',
      today: '2026-01-31',
      decisions,
      proposals: [],
      trades: [],
      valuations: [],
    }),
    report,
  );
});
