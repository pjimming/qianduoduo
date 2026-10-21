'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { buildHoldingsSummary } = require('../lib/review-store');

function openTestRepository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-review-store-'));
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: null,
    logger: { warn() {} },
  });
  t.after(() => {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return repository;
}

test('decision log supports create, update and delete', (t) => {
  const repository = openTestRepository(t);
  const decision = repository.createDecision({
    date: '2026-10-15',
    product_name: '招银理财某90天',
    action: '买入',
    reason: '额度命中且期限匹配',
    expectation: '持有到期年化 2.9%',
    actual_result: '',
    rating: '待评估',
  });
  assert.equal(decision.product_name, '招银理财某90天');
  assert.equal(repository.listDecisions().length, 1);

  const updated = repository.updateDecision(decision.id, {
    ...decision,
    rating: '流程正确，结果好',
    actual_result: '到期年化 2.92%',
  });
  assert.equal(updated.rating, '流程正确，结果好');
  assert.equal(updated.actual_result, '到期年化 2.92%');

  assert.equal(repository.deleteDecision(decision.id), true);
  assert.equal(repository.listDecisions().length, 0);
});

test('holdings compute maturity, buckets and ladder', (t) => {
  const repository = openTestRepository(t);
  const medium = repository.createHolding({
    product_name: '某90天',
    product_code: 'CMB001',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 100000,
    purchase_date: '2026-10-15',
    term_days: 90,
    maturity_date: null,
    notes: '',
  });
  assert.equal(medium.maturity_date, '2027-01-13');

  const daily = repository.createHolding({
    product_name: '某日开',
    product_code: 'CMB002',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 50000,
    purchase_date: '2026-10-01',
    term_days: 0,
    maturity_date: null,
    notes: '',
  });
  assert.equal(daily.maturity_date, null);

  const summary = buildHoldingsSummary(repository.listHoldings(), '2026-10-19');
  assert.equal(summary.total_amount, 150000);
  assert.equal(summary.buckets.medium, 100000);
  assert.equal(summary.buckets.liquid, 50000);
  assert.equal(summary.liquidity_ratio_pct, 33.33);
  assert.equal(summary.short_ratio_pct, 0);
  assert.equal(summary.daily_open_ratio_pct, 33.33);
  assert.equal(summary.max_product.amount, 100000);
  assert.equal(summary.max_product.pct, 66.67);
  assert.equal(summary.ladder[3].month, '2027-01');
  assert.equal(summary.ladder[3].amount, 100000);
  assert.ok(summary.alerts.some((alert) => alert.code === 'single-product'));
  assert.ok(summary.alerts.some((alert) => alert.code === 'daily-open-migration'));
});

test('decision storage normalizes target3 and daily-open targets', (t) => {
  const repository = openTestRepository(t);
  const target3 = repository.createDecision({
    date: '2026-10-15',
    product_name: '3% 策略',
    action: '买入',
    reason: '固定目标',
    expectation: '30/35/35',
    strategy_version: 'r2-3pct-v1',
    target_annualized: 3,
    bucket_plan: { short: 0, medium: 100, long: 0, cash: 10, liquid: 8 },
  });
  assert.deepEqual(
    {
      short: target3.bucket_plan.short,
      medium: target3.bucket_plan.medium,
      long: target3.bucket_plan.long,
      cash: target3.bucket_plan.cash,
      liquid: target3.bucket_plan.liquid,
    },
    { short: 30, medium: 35, long: 35, cash: 0, liquid: 0 },
  );
});

test('product events can be closed and reopened', (t) => {
  const repository = openTestRepository(t);
  const event = repository.createProductEvent({
    date: '2026-10-16',
    product_name: '某90天',
    event_type: '费率',
    description: '销售费率下调 0.05%',
    impact: '低',
    status: '待复核',
  });
  assert.equal(event.status, '待复核');

  const closed = repository.updateProductEvent(event.id, {
    ...event,
    status: '已处理',
  });
  assert.equal(closed.status, '已处理');
  assert.equal(repository.listProductEvents().length, 1);
  assert.equal(repository.deleteProductEvent(event.id), true);
});

test('monthly and quarterly notes upsert by period', (t) => {
  const repository = openTestRepository(t);
  const note = repository.saveReviewNote('2026-09', {
    answers: ['a', 'b', 'c', 'd', '减少切换'],
    conclusion: '执行正常',
  });
  assert.deepEqual(note.answers, ['a', 'b', 'c', 'd', '减少切换']);

  const updated = repository.saveReviewNote('2026-09', {
    answers: ['a2', 'b2', 'c2', 'd2', '只保留短桶'],
    conclusion: '下月只改一件事',
  });
  assert.equal(updated.conclusion, '下月只改一件事');
  assert.equal(repository.listReviewNotes().length, 1);

  const quarter = repository.saveQuarterlyNote('2026-Q3', {
    answers: ['5%', '否', '是', '可接受', '无', '值得'],
    conclusion: '结构稳定',
  });
  assert.equal(quarter.quarter, '2026-Q3');
  assert.equal(repository.listQuarterlyNotes().length, 1);
});

test('review timeline marks completed periods and focuses the daily gap', (t) => {
  const repository = openTestRepository(t);
  repository.saveReviewNote('2026-09', {
    answers: ['a', 'b', 'c', 'd', 'e'],
    conclusion: 'ok',
  });
  repository.saveQuarterlyNote('2026-Q3', {
    answers: ['a', 'b', 'c', 'd', 'e', 'f'],
    conclusion: 'ok',
  });
  const workspace = repository.getReviewWorkspace({
    today: '2026-10-19',
    records: [],
    review: {
      weekly: { record_days: 2, elapsed_days: 2, consecutive_negative_days: 1 },
    },
  });
  const nodes = Object.fromEntries(
    workspace.timeline.nodes.map((node) => [node.key, node.status]),
  );
  assert.equal(nodes.daily, 'due');
  assert.equal(nodes.weekly, 'upcoming');
  assert.equal(nodes.monthly, 'done');
  assert.equal(nodes.quarterly, 'done');
  assert.equal(workspace.timeline.focus, 'daily');
});

test('review timeline checks yesterday instead of today for T+1 reporting', (t) => {
  const repository = openTestRepository(t);
  const workspace = repository.getReviewWorkspace({
    today: '2026-10-20',
    reportingDate: '2026-10-19',
    records: [{ date: '2026-10-19', daily_pnl: 10 }],
    review: {
      reporting_date: '2026-10-19',
      weekly: { record_days: 1, elapsed_days: 1, consecutive_negative_days: 0 },
    },
  });
  const daily = workspace.timeline.nodes.find((node) => node.key === 'daily');
  assert.equal(daily.status, 'done');
  assert.equal(daily.title, '昨日收益已记');
  assert.match(daily.detail, /10\.00/);
});

test('review timeline marks missing monthly notes as overdue after day five', (t) => {
  const repository = openTestRepository(t);
  const workspace = repository.getReviewWorkspace({
    today: '2026-10-19',
    records: [{ date: '2026-10-19', daily_pnl: 10 }],
    review: {
      weekly: { record_days: 1, elapsed_days: 1, consecutive_negative_days: 0 },
    },
  });
  const nodes = Object.fromEntries(
    workspace.timeline.nodes.map((node) => [node.key, node.status]),
  );
  assert.equal(nodes.daily, 'done');
  assert.equal(nodes.monthly, 'overdue');
  assert.equal(nodes.quarterly, 'overdue');
  assert.equal(workspace.timeline.focus, 'monthly');
});

test('review timeline excludes periods before the capital start date', (t) => {
  const repository = openTestRepository(t);
  const workspace = repository.getReviewWorkspace({
    today: '2026-10-19',
    records: [{ date: '2026-10-19', daily_pnl: 10 }],
    review: {
      account_start_date: '2026-10-19',
      weekly: { record_days: 1, elapsed_days: 1, consecutive_negative_days: 0 },
    },
  });
  const nodes = Object.fromEntries(
    workspace.timeline.nodes.map((node) => [node.key, node.status]),
  );
  assert.equal(nodes.daily, 'done');
  assert.equal(nodes.monthly, 'not_applicable');
  assert.equal(nodes.quarterly, 'not_applicable');
  assert.equal(workspace.timeline.focus, null);
});
