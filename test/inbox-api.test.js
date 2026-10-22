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
  const { base } = await startTestServer(t);
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
  assert.equal(settingPayload.dashboard.meta.reporting_date, yesterday);
  assert.equal(settingPayload.dashboard.meta.reporting_lag_days, 1);
  assert.deepEqual(
    settingPayload.dashboard.meta.income_disclosure_policy.unverified_product_codes,
    [],
  );

  const dashboard = await fetch(`${base}/api/dashboard`).then((response) =>
    response.json(),
  );
  assert.equal(dashboard.meta.recording_date_source, 'user-provided');

  const userProvidedRecord = await postJson(`${base}/api/records`, {
    date: yesterday,
    daily_pnl: 1.2,
    action: '无操作',
    notes: '',
  });
  assert.equal(userProvidedRecord.status, 201);

  const userProvidedProduct = await postJson(`${base}/api/product-valuations`, {
    yield_date: yesterday,
    credit_date: yesterday,
    product_code: '120026A',
    product_name: '招银理财14天',
    holding_amount: 3000,
    daily_pnl: 0.6,
  });
  assert.equal(userProvidedProduct.status, 201);

  const acceptedRecord = await postJson(`${base}/api/records`, {
    date: latestComplete,
    daily_pnl: 1.2,
    action: '无操作',
    notes: '',
  });
  assert.equal(acceptedRecord.status, 201);
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
    },
  );
  assert.equal(applied.status, 200);
  const payload = await applied.json();
  assert.equal(payload.inbox.status, 'applied');
  assert.equal(payload.record.date, recordDate);
  assert.equal(payload.record.daily_pnl, -2.35);
  assert.equal(payload.record.source, 'income-screenshot');
  assert.ok(
    payload.dashboard.workspace.income_inbox.some(
      (item) => item.id === captured.inbox.id && item.status === 'applied',
    ),
  );
});

test('income screenshot apply ignores matching dates and flags conflicting amounts without overwriting', async (t) => {
  const { base, repository } = await startTestServer(t);
  const date = shiftDate(todayShanghai(), -1);
  await postJson(`${base}/api/capital/init`, {
    initial_principal: 30000,
    initial_date: shiftDate(todayShanghai(), -10),
  });
  const created = await postJson(`${base}/api/records`, {
    date,
    daily_pnl: 1.23,
    action: '无操作',
    notes: '',
  });
  assert.equal(created.status, 201);

  const matching = repository.incomeStore.addInbox({
    original_name: 'matching.png',
    stored_name: '',
    mime: 'image/png',
    bytes: 1,
    sha256: 'income-idempotent-matching',
    parsed: { date, daily_pnl: 1.23, products: [] },
    parse_confidence: 95,
  });
  const matchingApply = await postJson(
    `${base}/api/income/inbox/${matching.id}/apply`,
    { date, daily_pnl: 1.23, products: [] },
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
    parsed: { date, daily_pnl: 9.99, products: [] },
    parse_confidence: 95,
  });
  const conflictApply = await postJson(
    `${base}/api/income/inbox/${conflicting.id}/apply`,
    { date, daily_pnl: 9.99, products: [] },
  );
  assert.equal(conflictApply.status, 200);
  const conflictPayload = await conflictApply.json();
  assert.equal(conflictPayload.duplicate, false);
  assert.equal(conflictPayload.overwritten, false);
  assert.equal(conflictPayload.record.daily_pnl, 1.23);
  assert.equal(conflictPayload.inbox.status, 'pending');
  assert.equal(conflictPayload.conflict.existing_daily_pnl, 1.23);
  assert.equal(conflictPayload.conflict.incoming_daily_pnl, 9.99);
  assert.ok(
    conflictPayload.dashboard.inbox_center.pending.some(
      (item) =>
        item.source_type === 'system_notification' &&
        item.title.includes('收益金额不一致'),
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
  assert.equal(payload.reconciliation.status, 'mismatch');
  assert.equal(payload.reconciliation.difference, 0.29);
  assert.deepEqual(payload.missing_product_codes, []);
  assert.equal(
    payload.dashboard.inbox_center.pending.some(
      (item) => item.source_type === 'product_valuation_reconciliation',
    ),
    true,
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
  assert.deepEqual(missingPayload.missing_product_codes, ['120026A']);
  assert.ok(
    missingPayload.inbox.parsed.warnings.some((item) =>
      item.includes('本次未拍到：120026A'),
    ),
  );
});
