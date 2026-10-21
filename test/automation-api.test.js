'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { createServer } = require('../server');

async function startTestServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-automation-api-'));
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: null,
    logger: { warn() {} },
  });
  const server = createServer({ repository });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}`, repository };
}

function postJson(url, body, method = 'POST') {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('automation API persists strategy fields, evaluates, applies and undoes', async (t) => {
  const { base } = await startTestServer(t);
  await postJson(`${base}/api/capital/init`, {
    initial_principal: 30000,
    initial_date: '2026-10-01',
  });
  const decisionResponse = await postJson(`${base}/api/review/decisions`, {
    date: '2026-10-01',
    product_name: '测试组合',
    action: '买入',
    reason: '按策略配置',
    expectation: '持有到期达到目标',
    actual_result: '',
    rating: '待评估',
    strategy_version: 'custom-ladder-v1',
    target_annualized: 3,
    bucket_plan: { short: 0, medium: 100, long: 0, max_single: 100 },
    evaluation_at: ['buy_day', 'maturity'],
  });
  assert.equal(decisionResponse.status, 201);
  const decisionPayload = await decisionResponse.json();
  const decision = decisionPayload.decision;
  assert.equal(decision.strategy_version, 'custom-ladder-v1');
  assert.equal(decision.bucket_plan.medium, 100);
  assert.equal(decision.bucket_plan.cash, 0);
  assert.deepEqual(decision.evaluation_at, ['buy_day', 'maturity']);

  const buy = await postJson(`${base}/api/trades`, {
    trade_date: '2026-10-01',
    confirm_date: '2026-10-01',
    trade_type: 'buy',
    status: 'confirmed',
    product_code: 'A001',
    product_name: '测试90天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 10000,
    term_days: 90,
    decision_id: decision.id,
    notes: '',
  });
  assert.equal(buy.status, 201);
  const sell = await postJson(`${base}/api/trades`, {
    trade_date: '2026-10-19',
    confirm_date: '2026-10-19',
    trade_type: 'redeem',
    status: 'confirmed',
    product_code: 'A001',
    product_name: '测试90天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 10000,
    settlement_amount: null,
    decision_id: decision.id,
    notes: '',
  });
  assert.equal(sell.status, 201);

  const run = await postJson(`${base}/api/automation/run`, {});
  assert.equal(run.status, 200);
  const runPayload = await run.json();
  assert.equal(runPayload.ok, true);
  assert.ok(runPayload.automation.runs.length >= 2);

  const pending = runPayload.automation.pending_evaluations.find(
    (item) =>
      item.scope === 'decision' &&
      item.stage === 'maturity' &&
      item.decision_id === decision.id,
  );
  assert.ok(pending);
  assert.equal(pending.outcome, 'unknown');

  const apply = await postJson(
    `${base}/api/evaluations/${pending.id}/apply`,
    { rating: '流程正确，结果差' },
  );
  assert.equal(apply.status, 200);
  const applied = await apply.json();
  assert.equal(
    applied.dashboard.workspace.decisions.find((item) => item.id === decision.id).rating,
    '流程正确，结果差',
  );

  const undo = await postJson(
    `${base}/api/evaluations/${pending.id}/undo`,
    {},
  );
  assert.equal(undo.status, 200);
  const undone = await undo.json();
  assert.equal(
    undone.dashboard.workspace.decisions.find((item) => item.id === decision.id).rating,
    '待评估',
  );
});

test('automation settings, drafts and notifications are exposed through the API', async (t) => {
  const { base } = await startTestServer(t);
  await postJson(`${base}/api/capital/init`, {
    initial_principal: 30000,
    initial_date: '2026-10-01',
  });
  await postJson(`${base}/api/records`, {
    date: '2026-10-10',
    daily_pnl: 10,
    action: '无操作',
    notes: '',
  });

  const settings = await postJson(
    `${base}/api/automation/settings`,
    {
      auto_confidence_threshold: 80,
      hurdle_short: 2.4,
      scheduler_minutes: 10,
    },
    'PUT',
  );
  assert.equal(settings.status, 200);
  const settingsPayload = await settings.json();
  assert.equal(settingsPayload.settings.auto_confidence_threshold, 80);
  assert.equal(settingsPayload.settings.hurdle_short, 2.4);
  assert.equal(settingsPayload.settings.scheduler_minutes, 10);

  const generated = await postJson(
    `${base}/api/review/drafts/monthly/2026-10/generate`,
    {},
  );
  assert.equal(generated.status, 200);
  const generatedPayload = await generated.json();
  assert.equal(generatedPayload.draft.status, 'draft');
  assert.equal(generatedPayload.draft.content.answers.length, 5);

  const confirmed = await postJson(
    `${base}/api/review/drafts/monthly/2026-10/confirm`,
    {
      answers: generatedPayload.draft.content.answers,
      conclusion: generatedPayload.draft.content.conclusion,
    },
  );
  assert.equal(confirmed.status, 200);
  const confirmedPayload = await confirmed.json();
  assert.equal(confirmedPayload.draft.status, 'confirmed');
  assert.equal(
    confirmedPayload.dashboard.workspace.notes.find((item) => item.month === '2026-10')
      .answers.length,
    5,
  );

  const workspace = await fetch(`${base}/api/automation/workspace`).then((response) =>
    response.json(),
  );
  assert.ok(Array.isArray(workspace.automation.jobs));
  assert.ok(workspace.automation.drafts.some((item) => item.period === '2026-10'));
});

test('automation API rejects invalid settings and draft periods', async (t) => {
  const { base } = await startTestServer(t);
  const badThreshold = await postJson(
    `${base}/api/automation/settings`,
    { auto_confidence_threshold: 101 },
    'PUT',
  );
  assert.equal(badThreshold.status, 400);
  const badDailyOpen = await postJson(
    `${base}/api/automation/settings`,
    { daily_open_target_pct: 5 },
    'PUT',
  );
  assert.equal(badDailyOpen.status, 400);
  const badPeriod = await postJson(
    `${base}/api/review/drafts/monthly/2026-13/generate`,
    {},
  );
  assert.equal(badPeriod.status, 400);
});

test('target3 and daily-open policy are enforced through the API', async (t) => {
  const { base } = await startTestServer(t);
  const validTarget3 = await postJson(`${base}/api/review/decisions`, {
    date: '2026-10-01',
    product_name: '3% 固定策略',
    action: '买入',
    reason: '策略校准',
    expectation: '按 30/35/35 执行',
    strategy_version: 'r2-3pct-v1',
    target_annualized: 3,
    bucket_plan: { short: 30, medium: 35, long: 35, max_single: 30 },
  });
  assert.equal(validTarget3.status, 201);
  const validPayload = await validTarget3.json();
  assert.deepEqual(
    {
      short: validPayload.decision.bucket_plan.short,
      medium: validPayload.decision.bucket_plan.medium,
      long: validPayload.decision.bucket_plan.long,
      cash: validPayload.decision.bucket_plan.cash,
    },
    { short: 30, medium: 35, long: 35, cash: 0 },
  );

  const wrongTarget3 = await postJson(`${base}/api/review/decisions`, {
    date: '2026-10-01',
    product_name: '错误 target3',
    action: '买入',
    reason: '测试硬约束',
    strategy_version: 'r2-3pct-v1',
    target_annualized: 3,
    bucket_plan: { short: 0, medium: 100, long: 0 },
  });
  assert.equal(wrongTarget3.status, 400);

  const dailyOpenPlan = await postJson(`${base}/api/review/decisions`, {
    date: '2026-10-01',
    product_name: '错误日开仓位',
    action: '买入',
    reason: '测试硬约束',
    strategy_version: 'custom-ladder-v1',
    target_annualized: 3,
    bucket_plan: { short: 30, medium: 35, long: 35, cash: 5 },
  });
  assert.equal(dailyOpenPlan.status, 400);
});
