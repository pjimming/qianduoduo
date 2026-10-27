'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { createServer } = require('../server');
const { shiftDate, todayShanghai } = require('../lib/metrics');
const { makeSourceItems } = require('../lib/inbox-center');

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Wl3sAAAAASUVORK5CYII=';

async function startTestServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-inbox-api-'));
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: null,
    logger: { warn() {} },
  });
  const server = createServer({ repository, automation: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}`, repository };
}

function postJson(url, body = {}, method = 'POST') {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('message center aggregates, reads, snoozes and resolves a pending trade', async (t) => {
  const { base } = await startTestServer(t);
  const today = todayShanghai();
  await postJson(`${base}/api/capital/init`, {
    initial_principal: 30000,
    initial_date: '2026-01-01',
  });
  const tradeResponse = await postJson(`${base}/api/trades`, {
    trade_date: today,
    confirm_date: null,
    trade_type: 'buy',
    status: 'pending',
    product_code: 'A001',
    product_name: '测试90天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 10000,
    settlement_amount: null,
    shares: null,
    term_days: 90,
    maturity_date: null,
    decision_id: null,
    notes: '',
  });
  assert.equal(tradeResponse.status, 201);
  const trade = (await tradeResponse.json()).trade;

  const firstDashboard = await fetch(`${base}/api/dashboard`).then((response) =>
    response.json(),
  );
  const pending = firstDashboard.inbox_center.pending.find(
    (item) => item.source_type === 'pending_trade' && item.source_id === String(trade.id),
  );
  assert.ok(pending);
  assert.equal(pending.read_at, null);

  const read = await postJson(`${base}/api/inbox/${pending.id}/read`);
  assert.equal(read.status, 200);
  assert.ok((await read.json()).item.read_at);

  const snoozed = await postJson(`${base}/api/inbox/${pending.id}/snooze`, {
    until: shiftDate(today, 1),
  });
  assert.equal(snoozed.status, 200);
  const snoozedDashboard = (await snoozed.json()).dashboard;
  assert.equal(
    snoozedDashboard.inbox_center.pending.some((item) => item.id === pending.id),
    false,
  );
  assert.equal(
    snoozedDashboard.inbox_center.reminders.some((item) => item.id === pending.id),
    true,
  );

  const confirmed = await postJson(`${base}/api/trades/${trade.id}/confirm`, {
    confirm_date: today,
  });
  assert.equal(confirmed.status, 200);
  const finalDashboard = await fetch(`${base}/api/dashboard`).then((response) =>
    response.json(),
  );
  const resolved = finalDashboard.inbox_center.items.find(
    (item) => item.id === pending.id,
  );
  assert.equal(resolved.status, 'resolved');
});

test('confirmation API publishes deduplicated action items to the message center', async (t) => {
  const { base, repository } = await startTestServer(t);
  const payload = {
    dedupe_key: 'agent-confirmation:test-daily-open',
    title: '现有日开持仓待确认迁移',
    message: '107320A 现有持仓 ¥3,000，需确认迁移安排。',
    category: 'action',
    severity: 'warn',
    action_label: '查看持仓复核',
    action_url: '/ledger/products#holding-reviews',
    due_at: '2026-11-03',
  };
  const created = await postJson(`${base}/api/inbox/confirmations`, payload);
  assert.equal(created.status, 201);
  const createdPayload = await created.json();
  const item = createdPayload.inbox_center.pending.find(
    (entry) => entry.title === payload.title,
  );
  assert.ok(item);
  assert.equal(item.source_type, 'system_notification');
  assert.equal(item.summary, payload.message);
  assert.equal(item.action_label, payload.action_label);
  assert.equal(item.action_url, payload.action_url);
  assert.equal(item.due_at, payload.due_at);

  const decision = repository.createDecision({
    date: '2026-10-22',
    product_name: '桥接切换',
    action: '切换',
    reason: '测试桥接本金',
    expectation: '完成转出并恢复目标本金',
    invalidation_condition: '转出缺失或目标本金未恢复',
    actual_result: '',
    strategy_version: 'r2-3pct-v1',
    target_annualized: 3,
    bucket_plan: { short: 30, medium: 35, long: 35, max_single: 30 },
    evaluation_at: ['buy_day', 'holding', 'maturity'],
    evidence_date: '2026-10-22',
    verify_date: '2026-10-23',
    review_meta: {},
    rating: '待评估',
  });
  const bridgeCreated = await postJson(`${base}/api/inbox/confirmations`, {
    ...payload,
    dedupe_key: 'codex-r2-review:capital-bridge:2026-10-22:3000:metadata-test',
    title: '桥接本金提醒',
    metadata: {
      capital_bridge: {
        bridge_amount: 3000,
        bridge_date: '2026-10-22',
        withdraw_date: '2026-10-23',
        target_principal: 30000,
        decision_id: decision.id,
      },
    },
  });
  assert.equal(bridgeCreated.status, 201);
  const bridgePayload = await bridgeCreated.json();
  assert.deepEqual(
    bridgePayload.notification.data.capital_bridge,
    {
      bridge_amount: 3000,
      bridge_date: '2026-10-22',
      withdraw_date: '2026-10-23',
      target_principal: 30000,
      decision_id: decision.id,
    },
  );

  const invalidBridge = await postJson(
    `${base}/api/inbox/confirmations`,
    {
      ...payload,
      dedupe_key: 'codex-r2-review:capital-bridge:invalid',
      metadata: {
        capital_bridge: {
          bridge_amount: 3000,
          bridge_date: '2026-10-22',
        },
      },
    },
  );
  assert.equal(invalidBridge.status, 400);
  assert.match((await invalidBridge.json()).error, /target_principal/);

  const updated = await postJson(`${base}/api/inbox/confirmations`, {
    ...payload,
    message: '107320A 现有持仓 ¥3,000，已核对赎回规则，等待确认迁移安排。',
  });
  assert.equal(updated.status, 201);
  const updatedPayload = await updated.json();
  const matches = updatedPayload.inbox_center.pending.filter(
    (entry) => entry.title === payload.title,
  );
  assert.equal(matches.length, 1);
  assert.match(matches[0].summary, /已核对赎回规则/);
});

test('product income reminders resolve after the matching yield is recorded', async (t) => {
  const { base, repository } = await startTestServer(t);
  const yieldDate = shiftDate(todayShanghai(), -1);
  const structured = await postJson(`${base}/api/inbox/confirmations`, {
    dedupe_key: `codex-r2-review:income-missing:${yieldDate}:120026A`,
    title: `120026A ${Number(yieldDate.slice(5, 7))}月${Number(
      yieldDate.slice(8, 10),
    )}日收益待补`,
    message: `${yieldDate} 的 120026A 产品明细缺失，请补录。`,
    category: 'action',
    severity: 'warn',
    action_label: '补录产品收益',
    action_url: '/ledger/trades#holdings',
    due_at: yieldDate,
    metadata: {
      product_income_requirement: {
        product_code: '120026A',
        yield_date: yieldDate,
      },
    },
  });
  assert.equal(structured.status, 201);
  const structuredPayload = await structured.json();
  assert.deepEqual(
    structuredPayload.notification.data.product_income_requirement,
    {
      product_code: '120026A',
      yield_date: yieldDate,
    },
  );

  const legacy = await postJson(`${base}/api/inbox/confirmations`, {
    dedupe_key: `agent-confirmation:${yieldDate}:120026A-income-missing`,
    title: `120026A ${Number(yieldDate.slice(5, 7))}月${Number(
      yieldDate.slice(8, 10),
    )}日收益待补`,
    message: `${yieldDate} 的 120026A 产品明细缺失，请补录。`,
    category: 'action',
    severity: 'warn',
    action_label: '补录产品收益',
    action_url: '/ledger/trades#holdings',
    due_at: yieldDate,
  });
  assert.equal(legacy.status, 201);
  const legacyPayload = await legacy.json();
  const notificationIds = [
    structuredPayload.notification.id,
    legacyPayload.notification.id,
  ];

  const before = (
    await fetch(`${base}/api/inbox`).then((response) => response.json())
  ).inbox_center.pending.filter((item) =>
    notificationIds.includes(item.metadata.notification_id),
  );
  assert.equal(before.length, 2);

  const valuation = await postJson(`${base}/api/product-valuations`, {
    yield_date: yieldDate,
    credit_date: yieldDate,
    product_code: '120026A',
    product_name: '招银理财14天',
    holding_amount: 6001.17,
    daily_pnl: 0,
  });
  assert.equal(valuation.status, 201);
  const valuationPayload = await valuation.json();
  const resolvedItems = valuationPayload.dashboard.inbox_center.items.filter(
    (item) => notificationIds.includes(item.metadata.notification_id),
  );
  assert.equal(resolvedItems.length, 2);
  assert.ok(resolvedItems.every((item) => item.status === 'resolved'));
  assert.ok(
    repository.automationStore
      .listNotifications()
      .filter((item) => notificationIds.includes(item.id))
      .every((item) => item.resolved_at),
  );
});

test('product lag remains informational and never blocks a user-provided income date', async (t) => {
  const { base, repository } = await startTestServer(t);
  const today = todayShanghai();
  const yesterday = shiftDate(today, -1);
  const latestComplete = shiftDate(today, -2);
  await postJson(`${base}/api/capital/init`, {
    initial_principal: 30000,
    initial_date: shiftDate(today, -10),
  });
  repository.tradeStore.createTrade({
    trade_date: shiftDate(today, -10),
    confirm_date: shiftDate(today, -10),
    trade_type: 'buy',
    status: 'confirmed',
    product_code: '120026A',
    product_name: '招银理财14天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 3000,
    term_days: 14,
    source: 'manual',
    notes: '',
  });

  const settingResponse = await postJson(
    `${base}/api/product-yield-settings/120026A`,
    {
      yield_lag_days: 2,
      source: 'user-confirmed',
      notes: '用户确认收益 T+2 到账',
      verified_at: today,
    },
    'PUT',
  );
  assert.equal(settingResponse.status, 200);
  const settingPayload = await settingResponse.json();
  assert.equal(settingPayload.setting.yield_lag_days, 2);
  assert.equal(settingPayload.dashboard.meta.reporting_date, latestComplete);
  assert.equal(settingPayload.dashboard.meta.reporting_lag_days, 2);
  assert.equal(settingPayload.dashboard.review.reporting_date, latestComplete);
  assert.equal(settingPayload.dashboard.review.reporting_lag_days, 2);
  assert.deepEqual(
    settingPayload.dashboard.meta.income_disclosure_policy.unverified_product_codes,
    [],
  );

  const dashboard = await fetch(`${base}/api/dashboard`).then((response) =>
    response.json(),
  );
  assert.equal(dashboard.meta.recording_date_source, 'user-provided');

  const userProvidedProduct = await postJson(`${base}/api/product-valuations`, {
    yield_date: yesterday,
    credit_date: yesterday,
    product_code: '120026A',
    product_name: '招银理财14天',
    holding_amount: 3000,
    daily_pnl: 0.6,
  });
  assert.equal(userProvidedProduct.status, 201);
  assert.equal(
    (await fetch(`${base}/api/dashboard`).then((response) => response.json()))
      .records.find((item) => item.date === yesterday).daily_pnl,
    0.6,
  );

  const acceptedProduct = await postJson(`${base}/api/product-valuations`, {
    yield_date: latestComplete,
    credit_date: latestComplete,
    product_code: '120026A',
    product_name: '招银理财14天',
    holding_amount: 3000,
    daily_pnl: 1.2,
  });
  assert.equal(acceptedProduct.status, 201);
});

test('product valuation API stores an explicitly confirmed zero yield', async (t) => {
  const { base, repository } = await startTestServer(t);
  const today = todayShanghai();
  await postJson(`${base}/api/capital/init`, {
    initial_principal: 30000,
    initial_date: shiftDate(today, -10),
  });
  repository.tradeStore.createTrade({
    trade_date: shiftDate(today, -2),
    confirm_date: shiftDate(today, -2),
    trade_type: 'buy',
    status: 'confirmed',
    product_code: '120056A',
    product_name: '招银理财90天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 7500,
    term_days: 90,
    source: 'manual',
    notes: '',
  });

  const response = await postJson(`${base}/api/product-valuations`, {
    yield_date: shiftDate(today, -1),
    credit_date: today,
    valuation_date: shiftDate(today, -1),
    product_code: '120056A',
    product_name: '招银理财90天',
    holding_amount: 7501.44,
    daily_pnl: 0,
    notes: '用户明确确认当日无收益',
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.valuation.daily_pnl, 0);
  const summary = payload.dashboard.workspace.product_valuation_summaries.find(
    (item) => item.product_code === '120056A',
  );
  assert.equal(summary.observed_days, 1);
  assert.equal(summary.cumulative_pnl, 0);
  assert.equal(summary.latest_daily_pnl, 0);
});

test('non-replace holding review still creates a review-window reminder', () => {
  const items = makeSourceItems({
    meta: { today: '2026-10-21' },
    workspace: {
      holding_reviews: [
        {
          lot_id: '6:107320A',
          product_name: '招银理财招睿添利日开1号A',
          product_code: '107320A',
          verdict: 'hold',
          verdict_label: '继续持有',
          reminder: {
            level: 'window',
            text: '距到期 12 天，进入替换/续作比较窗口',
          },
          horizon_days: 30,
          top_candidate_code: 'JX040213',
          candidates: [
            {
              code: 'JX040213',
              name: '建信理财嘉鑫固收类最低持有30天产品第9期',
              comparison_days: 30,
              switch_wait_days: 2,
              switch_wait_status: 'verified',
              effective_days: 28,
              min_gain_amount: 1,
              execution_ready: false,
              switch: { difference: 6.85 },
            },
          ],
          thresholds: { min_gain_amount: 1 },
          redemption: { redeemable_now: true },
          verify_date: '2026-11-05',
        },
      ],
    },
    automation: {},
  });
  const item = items.find((entry) => entry.source_type === 'holding_review');
  assert.ok(item);
  assert.equal(item.title, '持仓进入复核窗口');
  assert.match(item.summary, /招银理财招睿添利日开1号A/);
  assert.match(item.summary, /距到期 12 天/);
  assert.equal(item.action_label, '查看持仓复核');
  assert.equal(item.metadata.verdict, 'hold');
  assert.equal(item.due_at, '2026-11-05');
});

test('a loss-making switch suppresses the duplicate reminder after maturity', () => {
  const review = {
    lot_id: 'sample-holding',
    product_name: '样本持仓',
    product_code: 'HOLD-SAMPLE',
    maturity_date: '2026-10-30',
    verdict: 'hold',
    verdict_label: '继续持有（锁定期）',
    reminder: {
      level: 'urgent',
      text: '已到期 1 天，需处理赎回或续作',
    },
    horizon_days: 30,
    top_candidate_code: 'CAND-SAMPLE',
    candidates: [
      {
        code: 'CAND-SAMPLE',
        name: '样本候选',
        switch: { difference: -1.51 },
      },
    ],
  };
  const dashboard = (today) => ({
    meta: { today },
    workspace: { holding_reviews: [review] },
    automation: {},
  });

  const beforeMaturity = makeSourceItems(dashboard('2026-10-29'));
  assert.equal(
    beforeMaturity.filter((item) => item.source_type === 'holding_review').length,
    1,
  );

  const afterMaturity = makeSourceItems(dashboard('2026-10-31'));
  assert.equal(
    afterMaturity.filter((item) => item.source_type === 'holding_review').length,
    0,
  );
});

test('income screenshot API accepts a queued capture and records the P&L', async (t) => {
  const previousOcr = process.env.R2_OCR;
  process.env.R2_OCR = '0';
  t.after(() => {
    if (previousOcr === undefined) delete process.env.R2_OCR;
    else process.env.R2_OCR = previousOcr;
  });
  const { base } = await startTestServer(t);
  await postJson(`${base}/api/capital/init`, {
    initial_principal: 30000,
    initial_date: '2026-01-01',
  });
  const capture = await postJson(`${base}/api/income/inbox`, {
    filename: 'income.png',
    mime: 'image/png',
    data: `data:image/png;base64,${ONE_PIXEL_PNG}`,
  });
  assert.equal(capture.status, 201);
  const captured = await capture.json();
  assert.equal(captured.auto_applied, false);
  assert.equal(captured.ocr.ok, false);

  const recordDate = '2026-10-18';
  const applied = await postJson(
    `${base}/api/income/inbox/${captured.inbox.id}/apply`,
    {
      date: recordDate,
      daily_pnl: -2.35,
      action: '无操作',
      notes: '收益截图补正',
      products: [
        {
          product_code: '120056A',
          product_name: '测试产品',
          holding_amount: 10000,
          yield_date: recordDate,
          credit_date: recordDate,
          daily_pnl: -2.35,
          confidence: 95,
        },
      ],
    },
  );
  assert.equal(applied.status, 200);
  const payload = await applied.json();
  assert.equal(payload.inbox.status, 'applied');
  assert.equal(payload.record.date, recordDate);
  assert.equal(payload.record.daily_pnl, -2.35);
  assert.equal(payload.record.source, 'product-income-summary');
  assert.ok(
    payload.dashboard.workspace.income_inbox.some(
      (item) => item.id === captured.inbox.id && item.status === 'applied',
    ),
  );
});

test('income screenshot apply derives account totals and preserves product conflicts', async (t) => {
  const { base, repository } = await startTestServer(t);
  const date = shiftDate(todayShanghai(), -1);
  await postJson(`${base}/api/capital/init`, {
    initial_principal: 30000,
    initial_date: shiftDate(todayShanghai(), -10),
  });
  const created = await postJson(`${base}/api/product-valuations`, {
    yield_date: date,
    credit_date: date,
    product_code: '120056A',
    product_name: '测试产品',
    holding_amount: 10000,
    daily_pnl: 1.23,
  });
  assert.equal(created.status, 201);

  const matching = repository.incomeStore.addInbox({
    original_name: 'matching.png',
    stored_name: '',
    mime: 'image/png',
    bytes: 1,
    sha256: 'income-idempotent-matching',
    parsed: {
      date,
      daily_pnl: 1.23,
      products: [
        {
          product_code: '120056A',
          product_name: '测试产品',
          holding_amount: 10000,
          daily_pnl: 1.23,
        },
      ],
    },
    parse_confidence: 95,
  });
  const matchingApply = await postJson(
    `${base}/api/income/inbox/${matching.id}/apply`,
    {
      date,
      daily_pnl: 1.23,
      products: [
        {
          product_code: '120056A',
          product_name: '测试产品',
          holding_amount: 10000,
          daily_pnl: 1.23,
        },
      ],
    },
  );
  assert.equal(matchingApply.status, 200);
  const matchingPayload = await matchingApply.json();
  assert.equal(matchingPayload.duplicate, true);
  assert.equal(matchingPayload.ignored, true);
  assert.equal(matchingPayload.record.daily_pnl, 1.23);
  assert.equal(matchingPayload.inbox.status, 'applied');

  const conflicting = repository.incomeStore.addInbox({
    original_name: 'conflicting.png',
    stored_name: '',
    mime: 'image/png',
    bytes: 1,
    sha256: 'income-idempotent-conflicting',
    parsed: {
      date,
      daily_pnl: 9.99,
      products: [
        {
          product_code: '120056A',
          product_name: '测试产品',
          holding_amount: 10000,
          daily_pnl: 9.99,
        },
      ],
    },
    parse_confidence: 95,
  });
  const conflictApply = await postJson(
    `${base}/api/income/inbox/${conflicting.id}/apply`,
    {
      date,
      daily_pnl: 9.99,
      products: [
        {
          product_code: '120056A',
          product_name: '测试产品',
          holding_amount: 10000,
          daily_pnl: 9.99,
        },
      ],
    },
  );
  assert.equal(conflictApply.status, 200);
  const conflictPayload = await conflictApply.json();
  assert.equal(conflictPayload.duplicate, false);
  assert.equal(conflictPayload.overwritten, false);
  assert.equal(conflictPayload.record.daily_pnl, 1.23);
  assert.equal(conflictPayload.inbox.status, 'pending');
  assert.equal(conflictPayload.conflict, null);
  assert.equal(conflictPayload.valuation_conflicts.length, 1);
  assert.ok(
    conflictPayload.dashboard.inbox_center.pending.some(
      (item) =>
        item.source_type === 'system_notification' &&
        item.title.includes('产品收益不一致'),
    ),
  );
  assert.equal(
    conflictPayload.dashboard.records.find((item) => item.date === date)
      .daily_pnl,
    1.23,
  );
});

test('income screenshot API archives multiple products, flags reconciliation and keeps corrections', async (t) => {
  const previousOcr = process.env.R2_OCR;
  process.env.R2_OCR = '0';
  t.after(() => {
    if (previousOcr === undefined) delete process.env.R2_OCR;
    else process.env.R2_OCR = previousOcr;
  });
  const { base, repository } = await startTestServer(t);
  await postJson(`${base}/api/capital/init`, {
    initial_principal: 30000,
    initial_date: '2026-10-01',
  });
  repository.tradeStore.createTrade({
    trade_date: '2026-10-01',
    confirm_date: '2026-10-01',
    trade_type: 'buy',
    status: 'confirmed',
    product_code: '120056A',
    product_name: '招银理财90天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 6000,
    term_days: 90,
    source: 'manual',
    notes: '',
  });
  repository.tradeStore.createTrade({
    trade_date: '2026-10-01',
    confirm_date: '2026-10-01',
    trade_type: 'buy',
    status: 'confirmed',
    product_code: '120026A',
    product_name: '招银理财14天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 3000,
    term_days: 14,
    source: 'manual',
    notes: '',
  });

  const capture = await postJson(`${base}/api/income/inbox`, {
    filename: 'multi-product.png',
    mime: 'image/png',
    data: `data:image/png;base64,${ONE_PIXEL_PNG}`,
  });
  assert.equal(capture.status, 201);
  const captured = await capture.json();
  const applied = await postJson(
    `${base}/api/income/inbox/${captured.inbox.id}/apply`,
    {
      date: '2026-10-20',
      daily_pnl: 2.31,
      products: [
        {
          product_code: '120056A',
          product_name: '招银理财90天',
          holding_amount: 6000,
          daily_pnl: 1.44,
          confidence: 95,
        },
        {
          product_code: '120026A',
          product_name: '招银理财14天',
          holding_amount: 3000,
          daily_pnl: 0.58,
          confidence: 95,
        },
      ],
    },
  );
  assert.equal(applied.status, 200);
  const payload = await applied.json();
  assert.equal(payload.saved_valuations.length, 2);
  assert.equal(payload.reconciliation.status, 'matched');
  assert.equal(payload.reconciliation.difference, 0);
  assert.equal(payload.record.daily_pnl, 2.02);
  assert.deepEqual(payload.missing_product_codes, []);
  assert.equal(
    payload.dashboard.inbox_center.pending.some(
      (item) =>
        item.source_type === 'product_valuation_reconciliation',
    ),
    false,
  );

  const firstValuation = payload.saved_valuations.find(
    (item) => item.product_code === '120056A',
  );
  const corrected = await postJson(
    `${base}/api/product-valuations/${firstValuation.id}`,
    {
      daily_pnl: 1.73,
      holding_amount: 6000,
      correction_note: 'API 测试手工修正',
    },
    'PUT',
  );
  assert.equal(corrected.status, 200);
  const correctedPayload = await corrected.json();
  assert.equal(correctedPayload.valuation.source, 'manual-correction');

  const detail = await fetch(
    `${base}/api/product-valuations?product_code=120056A`,
  ).then((response) => response.json());
  assert.ok(
    detail.detail.audit.some((item) => item.note === 'API 测试手工修正'),
  );

  const missingItem = repository.incomeStore.addInbox({
    original_name: 'partial-products.png',
    stored_name: '',
    mime: 'image/png',
    bytes: 1,
    sha256: 'partial-products-test',
    ocr_text: '',
    parsed: {},
  });
  const missingApplied = await postJson(
    `${base}/api/income/inbox/${missingItem.id}/apply`,
    {
      date: '2026-10-21',
      daily_pnl: 1.5,
      products: [
        {
          product_code: '120056A',
          product_name: '招银理财90天',
          holding_amount: 6000,
          daily_pnl: 1.5,
          confidence: 90,
        },
      ],
    },
  );
  assert.equal(missingApplied.status, 200);
  const missingPayload = await missingApplied.json();
  assert.equal(
    missingPayload.reconciliation.status,
    'missing-product-details',
  );
  assert.deepEqual(missingPayload.missing_product_codes, ['120026A']);
  assert.ok(
    missingPayload.inbox.parsed.warnings.some((item) =>
      item.includes('最终仍缺产品收益：120026A'),
    ),
  );
  assert.ok(
    missingPayload.dashboard.inbox_center.pending.some(
      (item) =>
        item.source_type === 'product_valuation_reconciliation' &&
        item.source_id === '2026-10-21' &&
        item.title === '产品收益待补（10/21）',
    ),
  );

  const completed = await postJson(`${base}/api/product-valuations`, {
    yield_date: '2026-10-21',
    credit_date: '2026-10-21',
    product_code: '120026A',
    product_name: '招银理财14天',
    holding_amount: 3000,
    daily_pnl: 0.5,
    covered_yield_dates: ['2026-10-21'],
  });
  assert.equal(completed.status, 201);
  const completedPayload = await completed.json();
  assert.deepEqual(completedPayload.valuation.covered_yield_dates, [
    '2026-10-21',
  ]);
  assert.equal(
    completedPayload.dashboard.workspace.product_valuation_reconciliation.items.find(
      (item) => item.account_date === '2026-10-21',
    ).status,
    'matched',
  );
  assert.equal(
    completedPayload.dashboard.inbox_center.items.some(
      (item) =>
        item.source_type === 'product_valuation_reconciliation' &&
        item.metadata?.account_dates?.includes('2026-10-21') &&
        item.status !== 'resolved',
    ),
    false,
  );
  const cleared = await postJson(
    `${base}/api/product-valuations/${completedPayload.valuation.id}`,
    {
      notes: '撤回错误的覆盖说明',
      clear_coverage: true,
      correction_note: 'API 测试撤回覆盖区间',
    },
    'PUT',
  );
  assert.equal(cleared.status, 200);
  const clearedPayload = await cleared.json();
  assert.deepEqual(clearedPayload.valuation.covered_yield_dates, []);
  assert.match(clearedPayload.valuation.notes, /覆盖收益日期：无/);

  await postJson(`${base}/api/product-valuations`, {
    yield_date: '2026-10-22',
    product_code: '120056A',
    product_name: '招银理财90天',
    daily_pnl: 1.2,
  });
  const coveredFutureResponse = await postJson(
    `${base}/api/product-valuations`,
    {
      yield_date: '2026-10-23',
      product_code: '120026A',
      product_name: '招银理财14天',
      daily_pnl: 0.6,
      covered_yield_dates: ['2026-10-22', '2026-10-23'],
    },
  );
  const coveredFuture = await coveredFutureResponse.json();
  assert.equal(
    coveredFuture.dashboard.workspace.product_valuation_reconciliation.items.find(
      (item) => item.account_date === '2026-10-22',
    ).status,
    'matched',
  );

  const clearFuture = await postJson(
    `${base}/api/product-valuations/${coveredFuture.valuation.id}`,
    {
      clear_coverage: true,
      correction_note: '撤回后续合并覆盖',
    },
    'PUT',
  );
  const clearFuturePayload = await clearFuture.json();
  const reopened = clearFuturePayload.dashboard.workspace
    .product_valuation_reconciliation.items.find(
      (item) => item.account_date === '2026-10-22',
    );
  assert.equal(reopened.status, 'missing-product-details');
  assert.deepEqual(reopened.missing_product_codes, ['120026A']);
  assert.ok(
    clearFuturePayload.dashboard.inbox_center.pending.some(
      (item) =>
        item.source_type === 'product_valuation_reconciliation' &&
        item.metadata?.account_dates?.includes('2026-10-22'),
    ),
  );
});

test('product-only income derives the account total through T+N and never asks for an account-only total', async (t) => {
  const { base, repository } = await startTestServer(t);
  const today = todayShanghai();
  const waitingDate = shiftDate(today, -1);
  const finalDate = shiftDate(today, -3);
  await postJson(`${base}/api/capital/init`, {
    initial_principal: 30000,
    initial_date: '2026-10-01',
  });
  for (const product of [
    ['120056A', '招银理财90天', 6000],
    ['120026A', '招银理财14天', 3000],
  ]) {
    repository.tradeStore.createTrade({
      trade_date: '2026-10-01',
      confirm_date: '2026-10-01',
      trade_type: 'buy',
      status: 'confirmed',
      product_code: product[0],
      product_name: product[1],
      issuer: '招银理财',
      risk_level: 'R2',
      amount: product[2],
      term_days: 90,
      source: 'manual',
      notes: '',
    });
    repository.productValuationStore.saveYieldSetting(product[0], {
      yield_lag_days: 2,
      source: 'app-rule',
      notes: '测试 T+2',
      verified_at: '2026-10-20',
    });
  }

  const waitingItem = repository.incomeStore.addInbox({
    original_name: 'waiting-products.png',
    stored_name: '',
    mime: 'image/png',
    bytes: 1,
    sha256: 'waiting-products-test',
    ocr_text: '',
    parsed: {},
  });
  const waitingResponse = await postJson(
    `${base}/api/income/inbox/${waitingItem.id}/apply`,
    {
      date: waitingDate,
      products: [
        {
          product_code: '120056A',
          product_name: '招银理财90天',
          holding_amount: 6000,
          daily_pnl: 1,
        },
      ],
    },
  );
  assert.equal(waitingResponse.status, 200);
  const waitingPayload = await waitingResponse.json();
  assert.equal(waitingPayload.record.daily_pnl, 1);
  assert.equal(waitingPayload.reconciliation.status, 'waiting');
  assert.equal(waitingPayload.reconciliation.difference, null);
  assert.deepEqual(waitingPayload.reconciliation.missing_product_codes, [
    '120026A',
  ]);
  assert.equal(repository.getRecord(waitingDate).daily_pnl, 1);
  assert.equal(
    waitingPayload.dashboard.inbox_center.pending.some(
      (item) =>
        item.source_type === 'product_valuation_reconciliation' &&
        item.source_id === waitingDate,
    ),
    false,
  );

  const finalItem = repository.incomeStore.addInbox({
    original_name: 'complete-products-missing-account.png',
    stored_name: '',
    mime: 'image/png',
    bytes: 1,
    sha256: 'complete-products-missing-account-test',
    ocr_text: '',
    parsed: {},
  });
  const finalResponse = await postJson(
    `${base}/api/income/inbox/${finalItem.id}/apply`,
    {
      date: finalDate,
      products: [
        {
          product_code: '120056A',
          product_name: '招银理财90天',
          holding_amount: 6000,
          daily_pnl: 1,
        },
        {
          product_code: '120026A',
          product_name: '招银理财14天',
          holding_amount: 3000,
          daily_pnl: 0.5,
        },
      ],
    },
  );
  assert.equal(finalResponse.status, 200);
  const finalPayload = await finalResponse.json();
  assert.equal(finalPayload.record.daily_pnl, 1.5);
  assert.equal(finalPayload.reconciliation.status, 'matched');
  assert.deepEqual(finalPayload.reconciliation.missing_product_codes, []);
  assert.equal(repository.getRecord(finalDate).daily_pnl, 1.5);
  assert.equal(
    finalPayload.dashboard.inbox_center.items.some(
      (item) =>
        item.source_type === 'product_valuation_reconciliation' &&
        item.source_id === finalDate &&
        item.status !== 'resolved',
    ),
    false,
  );
});
