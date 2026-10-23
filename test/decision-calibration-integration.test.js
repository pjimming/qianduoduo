'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');

function openTemp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-calibration-'));
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: null,
    logger: { warn() {} },
  });
  repository.initializeCapital(30000, '2026-10-01');
  t.after(() => {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return repository;
}

function product() {
  return {
    code: 'CAL001',
    name: '校准测试产品',
    selected: true,
    target_amount: 5000,
    target_pct: 16.67,
    allocation_bucket: 'short',
    allocation_reason: '短期桶目标不足',
    selection_score: 82,
    quota_status: 'verified',
    quota_available: 10000,
    quota_verified_at: '2026-10-22',
    yield_pct: 2.8,
    return_3m: 2.8,
    return_6m: 2.7,
    return_1y: 2.9,
  };
}

function dashboard() {
  return {
    meta: {
      today: '2026-10-22',
      product_snapshot_date: '2026-10-21',
    },
    workspace: { holding_reviews: [] },
    products: {
      allocation: { available_cash: 5000 },
      watchlist: [product()],
    },
  };
}

test('proposal prediction closes through formal trade and product valuations, then reports calibration', (t) => {
  const repository = openTemp(t);
  repository.decisionProposalStore.sync(dashboard());
  const proposal = repository.decisionProposalStore
    .getWorkspace('2026-10-22')
    .pending.find((item) => item.proposal_type === 'cash_allocation');
  assert.ok(proposal);
  assert.equal(proposal.payload.prediction.expected.target.point, 2.8);

  const adopted = repository.decisionProposalStore.adoptProposal(proposal.id, {
    today: '2026-10-22',
  });
  repository.tradeStore.createTrade(
    {
      trade_date: '2026-10-22',
      confirm_date: '2026-10-22',
      trade_type: 'buy',
      status: 'confirmed',
      product_code: 'CAL001',
      product_name: '校准测试产品',
      issuer: '测试发行方',
      risk_level: 'R2',
      amount: 5000,
      term_days: 30,
      decision_id: adopted.decision.id,
      source: 'manual',
      screenshot_id: 1,
      notes: '校准测试',
    },
    '校准测试',
  );
  repository.productValuationStore.upsertMany(
    Array.from({ length: 31 }, (_, index) => {
      const date = new Date(
        Date.UTC(2026, 9, 22 + index),
      ).toISOString().slice(0, 10);
      return {
        yield_date: date,
        valuation_date: date,
        credit_date: date,
        product_code: 'CAL001',
        product_name: '校准测试产品',
        holding_amount: 5000,
        daily_pnl: 1,
        source: 'manual-correction',
      };
    }),
  );

  const first = repository.automationStore.runCycle({
    today: '2026-11-21',
    trigger: 'calibration-test',
  });
  assert.equal(first.ok, true);
  assert.equal(first.summary.predictions_evaluated >= 1, true);
  const decision = repository
    .listDecisions()
    .find((item) => item.id === adopted.decision.id);
  const prediction = decision.review_meta.predictions[0];
  const result = decision.review_meta.prediction_results[prediction.id];
  assert.equal(result.status, 'hit');
  assert.equal(result.classification, 'direction_hit');
  assert.ok(result.actual > prediction.expected.target.point);
  assert.equal(result.evidence.trade_ids.length, 1);

  const report = repository.automationStore.getCalibration(
    '2026-11',
    '2026-11-21',
  );
  const record = report.records.find(
    (item) => item.prediction.id === prediction.id,
  );
  assert.ok(record);
  assert.equal(record.result.status, 'hit');
  assert.equal(record.decision.id, adopted.decision.id);
  assert.equal(report.by_type[0].hit, 1);
  assert.equal(report.by_confidence[0].hit_rate, 1);

  const updatedAt = repository
    .listDecisions()
    .find((item) => item.id === adopted.decision.id).updated_at;
  repository.automationStore.runCycle({
    today: '2026-11-21',
    trigger: 'calibration-repeat',
  });
  assert.equal(
    repository
      .listDecisions()
      .find((item) => item.id === adopted.decision.id).updated_at,
    updatedAt,
  );
});

test('low-confidence prediction waits for human confirmation before entering hit rate', (t) => {
  const repository = openTemp(t);
  const decision = repository.createDecision({
    date: '2026-10-01',
    product_name: '低置信度测试',
    action: '买入',
    reason: '测试低置信度确认',
    expectation: '完成目标金额',
    invalidation_condition: '决策取消',
    actual_result: '',
    strategy_version: 'r2-3pct-v1',
    target_annualized: 3,
    bucket_plan: { short: 30, medium: 35, long: 35, max_single: 30 },
    evaluation_at: ['buy_day', 'maturity'],
    evidence_date: '2026-10-01',
    verify_date: '2026-10-31',
    review_meta: {},
    rating: '待评估',
  });
  repository.addPredictionVersion(decision.id, {
    recommendation_type: 'cash_allocation',
    action: '买入',
    source: 'platform',
    start_date: '2026-10-01',
    review_date: '2026-10-31',
    confidence: 40,
    baseline: { metric: 'executed_amount', value: 0, unit: '元' },
    expected: {
      direction: 'at_least',
      target: { point: 5000, unit: '元' },
    },
    metric: 'executed_amount',
    evaluation: {
      method: 'confirmed_trade_amount',
      tolerance_abs: 1,
    },
    invalidation_condition: '决策取消',
    invalidation_triggers: ['decision_cancelled'],
    original_text: '低置信度买入预测',
  });
  repository.tradeStore.createTrade(
    {
      trade_date: '2026-10-01',
      confirm_date: '2026-10-01',
      trade_type: 'buy',
      status: 'confirmed',
      product_code: 'LOW001',
      product_name: '低置信度测试产品',
      issuer: '测试发行方',
      risk_level: 'R2',
      amount: 5000,
      term_days: 30,
      decision_id: decision.id,
      source: 'manual',
      screenshot_id: 2,
      notes: '',
    },
    '低置信度测试',
  );
  repository.automationStore.runCycle({
    today: '2026-10-31',
    trigger: 'low-confidence-test',
  });
  let current = repository
    .listDecisions()
    .find((item) => item.id === decision.id);
  const prediction = current.review_meta.predictions[0];
  assert.equal(
    current.review_meta.prediction_results[prediction.id].status,
    'pending_confirmation',
  );
  let report = repository.automationStore.getCalibration(
    '2026-10',
    '2026-10-31',
  );
  assert.equal(report.by_type[0].evaluated, 0);
  assert.equal(report.by_type[0].pending_confirmation, 1);

  repository.automationStore.confirmPredictionResult(prediction.id, {
    status: 'hit',
    note: '人工核对成交截图',
  });
  current = repository
    .listDecisions()
    .find((item) => item.id === decision.id);
  assert.equal(
    current.review_meta.prediction_results[prediction.id].status,
    'hit',
  );
  report = repository.automationStore.getCalibration(
    '2026-10',
    '2026-10-31',
  );
  assert.equal(report.by_type[0].evaluated, 1);
  assert.equal(report.by_type[0].hit, 1);
});
