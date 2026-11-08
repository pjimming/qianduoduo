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

function frozenDecision({
  id,
  prediction: record,
  strategy_version,
  rule_version,
  status,
  numeric_error = null,
}) {
  return {
    id,
    strategy_version,
    review_meta: {
      predictions: [record],
      prediction_results: {
        [record.id]: {
          status,
          reason_code:
            status === 'hit'
              ? 'target_met'
              : status === 'miss'
                ? 'target_missed'
                : 'product_income_coverage_incomplete',
          numeric_error,
          evaluated_for: '2026-02-01',
          data_as_of: '2026-01-31',
        },
      },
      evaluation_settings: { status: 'frozen', rule_version },
    },
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

test('calibration separates strategies, contract versions and metrics into distinct samples', () => {
  const hitPrediction = prediction();
  const missPrediction = prediction({ source_ref: 'proposal:miss' });
  const otherVersionPrediction = prediction({ source_ref: 'proposal:v3' });
  const pnlPrediction = prediction({
    source_ref: 'proposal:pnl',
    metric: 'net_pnl_cents',
    baseline: { metric: 'net_pnl_cents', value: 0, unit: 'cent' },
    expected: { direction: 'at_least', target: { point: 1000, unit: 'cent' } },
  });
  const gapPrediction = prediction({ source_ref: 'proposal:gap' });

  const decisions = [
    frozenDecision({
      id: 1,
      prediction: hitPrediction,
      strategy_version: 'r2-3pct-v1',
      rule_version: 'r2-eval-v2',
      status: 'hit',
      numeric_error: 1,
    }),
    frozenDecision({
      id: 2,
      prediction: missPrediction,
      strategy_version: 'r2-3pct-v1',
      rule_version: 'r2-eval-v2',
      status: 'miss',
      numeric_error: -1,
    }),
    frozenDecision({
      id: 3,
      prediction: otherVersionPrediction,
      strategy_version: 'r2-3pct-v1',
      rule_version: 'r2-eval-v3',
      status: 'miss',
      numeric_error: -2,
    }),
    frozenDecision({
      id: 4,
      prediction: pnlPrediction,
      strategy_version: 'historical_unfrozen',
      rule_version: 'historical_unfrozen',
      status: 'hit',
      numeric_error: 5,
    }),
    frozenDecision({
      id: 5,
      prediction: gapPrediction,
      strategy_version: 'r2-3pct-v1',
      rule_version: 'r2-eval-v2',
      status: 'insufficient_data',
    }),
  ];

  const report = buildCalibrationReport({
    month: '2026-01',
    today: '2026-02-01',
    decisions,
    proposals: [],
    trades: [],
    valuations: [],
  });

  const row = (strategy, rule, metric) =>
    report.by_strategy.find(
      (item) =>
        item.strategy_version === strategy &&
        item.evaluation_policy_version === rule &&
        item.metric === metric,
    );

  // 同一旧策略、不同评价契约版本：两个独立样本。
  assert.equal(row('r2-3pct-v1', 'r2-eval-v2', 'personal_annualized_return_pct').hit_rate, 0.5);
  assert.equal(row('r2-3pct-v1', 'r2-eval-v3', 'personal_annualized_return_pct').hit_rate, 0);
  // 不同预测指标（净收益分 vs 年化%）不得混算。
  assert.equal(row('historical_unfrozen', 'historical_unfrozen', 'net_pnl_cents').hit_rate, 1);
  assert.equal(
    row('historical_unfrozen', 'historical_unfrozen', 'net_pnl_cents').mixed_metrics,
    false,
  );
  // 证据不足样本保留在分组里，但不进入命中率分母。
  const gapRow = row('r2-3pct-v1', 'r2-eval-v2', 'personal_annualized_return_pct');
  assert.equal(gapRow.insufficient_data, 1);
  assert.equal(gapRow.evaluated, 2);
  assert.equal(gapRow.hit_rate, 0.5);
  // 五个样本按 策略|契约版本|指标|方法 拆成三组。
  assert.equal(report.by_strategy.length, 3);
  // 推荐类型汇总的命中率同样只算 hit/miss（2 命中 / 2 命中+2 未中）。
  assert.equal(report.by_type[0].hit_rate, 0.5);
});
