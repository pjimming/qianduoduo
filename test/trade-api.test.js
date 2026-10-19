'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { createServer } = require('../server');

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9ZkAAAAASUVORK5CYII=';

async function startTestServer(t) {
  process.env.R2_OCR = '0';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-trade-api-'));
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: null,
    tradeInboxDir: path.join(directory, 'inbox'),
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

function tradePayload(overrides = {}) {
  return {
    trade_date: '2026-10-01',
    confirm_date: '2026-10-01',
    trade_type: 'buy',
    status: 'confirmed',
    product_code: '120056A',
    product_name: '招银理财90天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 10000,
    settlement_amount: null,
    shares: null,
    term_days: 90,
    maturity_date: null,
    decision_id: null,
    notes: '',
    ...overrides,
  };
}

test('trade API keeps pending out of holdings and updates after confirm/redeem', async (t) => {
  const { base } = await startTestServer(t);
  await postJson(`${base}/api/capital/init`, {
    initial_principal: 30000,
    initial_date: '2026-10-01',
  });

  const buyResponse = await postJson(`${base}/api/trades`, tradePayload());
  assert.equal(buyResponse.status, 201);
  const buy = await buyResponse.json();
  assert.equal(buy.trade.maturity_date, '2026-12-30');
  assert.equal(buy.dashboard.workspace.trades.summary.open_principal, 10000);
  assert.equal(buy.dashboard.workspace.holdings_summary.total_amount, 10000);

  const pendingResponse = await postJson(
    `${base}/api/trades`,
    tradePayload({
      trade_date: '2026-10-19',
      confirm_date: null,
      status: 'pending',
      product_code: '120026A',
      product_name: '招银理财14天',
      amount: 6000,
      term_days: 14,
    }),
  );
  assert.equal(pendingResponse.status, 201);
  const pending = await pendingResponse.json();
  assert.equal(pending.dashboard.workspace.holdings_summary.total_amount, 10000);
  assert.equal(pending.dashboard.workspace.trades.summary.pending_buy_amount, 6000);

  const confirmed = await postJson(
    `${base}/api/trades/${pending.trade.id}/confirm`,
    { confirm_date: '2026-10-19' },
  );
  assert.equal(confirmed.status, 200);
  const confirmedPayload = await confirmed.json();
  assert.equal(
    confirmedPayload.dashboard.workspace.holdings_summary.total_amount,
    16000,
  );

  const redeem = await postJson(
    `${base}/api/trades`,
    tradePayload({
      trade_date: '2026-10-19',
      confirm_date: '2026-10-19',
      trade_type: 'redeem',
      product_code: '120056A',
      product_name: '招银理财90天',
      amount: 4000,
      settlement_amount: 4040,
      term_days: null,
    }),
  );
  assert.equal(redeem.status, 201);
  const redeemPayload = await redeem.json();
  assert.equal(redeemPayload.dashboard.workspace.trades.summary.realized_pnl, 40);
  assert.equal(redeemPayload.dashboard.workspace.holdings_summary.total_amount, 12000);
  assert.equal(redeemPayload.trade.allocations.length, 1);
  assert.equal(redeemPayload.trade.allocations[0].principal, 4000);

  const duplicate = await postJson(`${base}/api/trades`, tradePayload());
  assert.equal(duplicate.status, 409);

  const badSwitch = await postJson(
    `${base}/api/trades`,
    tradePayload({ trade_type: 'switch', status: 'pending', confirm_date: null }),
  );
  assert.equal(badSwitch.status, 400);
});

test('trade inbox dedupes image hashes and applies corrected fields', async (t) => {
  const { base } = await startTestServer(t);
  await postJson(`${base}/api/capital/init`, {
    initial_principal: 30000,
    initial_date: '2026-10-01',
  });

  const upload = await postJson(`${base}/api/trades/inbox`, {
    filename: 'cmb-trade.png',
    mime: 'image/png',
    data: `data:image/png;base64,${PNG_BASE64}`,
  });
  assert.equal(upload.status, 201);
  const uploaded = await upload.json();
  assert.equal(uploaded.duplicate, false);
  assert.equal(uploaded.inbox.status, 'pending');
  assert.equal(uploaded.inbox.image_url, `/api/trades/inbox/${uploaded.inbox.id}/image`);

  const again = await postJson(`${base}/api/trades/inbox`, {
    filename: 'cmb-trade-copy.png',
    mime: 'image/png',
    data: `data:image/png;base64,${PNG_BASE64}`,
  });
  assert.equal(again.status, 200);
  const duplicate = await again.json();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.inbox.id, uploaded.inbox.id);

  const image = await fetch(`${base}${uploaded.inbox.image_url}`);
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type'), /image\/png/);
  assert.ok((await image.arrayBuffer()).byteLength > 0);

  const corrected = await postJson(
    `${base}/api/trades/inbox/${uploaded.inbox.id}`,
    {
      trade_date: '2026-10-19',
      trade_type: 'buy',
      status: 'pending',
      product_code: '120026A',
      product_name: '招银理财14天',
      issuer: '招银理财',
      risk_level: 'R2',
      amount: 6000,
      term_days: 14,
    },
    'PUT',
  );
  assert.equal(corrected.status, 200);

  const applied = await postJson(
    `${base}/api/trades/inbox/${uploaded.inbox.id}/apply`,
    {},
  );
  assert.equal(applied.status, 200);
  const appliedPayload = await applied.json();
  assert.equal(appliedPayload.matched, false);
  assert.equal(appliedPayload.trade.source, 'inbox');
  assert.equal(appliedPayload.trade.screenshot_id, uploaded.inbox.id);
  assert.equal(appliedPayload.inbox.status, 'applied');
  assert.equal(
    appliedPayload.dashboard.workspace.trades.summary.pending_buy_amount,
    6000,
  );
  assert.equal(appliedPayload.dashboard.workspace.holdings_summary.total_amount, 0);
});

test('trade reconciliation flags missing screenshots and stale pending trades', async (t) => {
  const { base } = await startTestServer(t);
  await postJson(`${base}/api/capital/init`, {
    initial_principal: 30000,
    initial_date: '2026-10-01',
  });
  await postJson(
    `${base}/api/trades`,
    tradePayload({
      trade_date: '2026-10-10',
      confirm_date: null,
      status: 'pending',
      source: 'manual',
    }),
  );
  const response = await fetch(`${base}/api/trades`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  const codes = payload.overview.reconciliation.items.map((item) => item.code);
  assert.ok(codes.includes('missing-screenshot'));
  assert.ok(codes.includes('stale-pending'));
  assert.ok(payload.overview.reconciliation.counts.warn >= 1);
  assert.equal(payload.overview.inbox.length, 0);
});

test('vision apply refuses OCR amount mismatch and links the screenshot when confirmed', async (t) => {
  const { base } = await startTestServer(t);
  const created = await postJson(
    `${base}/api/trades`,
    tradePayload({
      trade_date: '2026-10-19',
      confirm_date: null,
      status: 'pending',
      amount: 10000,
    }),
  );
  assert.equal(created.status, 201);

  const upload = await postJson(`${base}/api/trades/inbox`, {
    data: PNG_BASE64,
    mime: 'image/png',
    original_name: 'vision.png',
  });
  assert.equal(upload.status, 201);
  const uploaded = await upload.json();

  const corrected = await postJson(
    `${base}/api/trades/inbox/${uploaded.inbox.id}`,
    { amount: 9999, trade_date: '2026-10-19' },
    'PUT',
  );
  assert.equal(corrected.status, 200);

  const visionTrade = {
    trade_date: '2026-10-19',
    trade_type: 'buy',
    status: 'pending',
    product_code: '120056A',
    product_name: '招银理财90天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 10000,
  };

  const mismatch = await postJson(
    `${base}/api/trades/inbox/${uploaded.inbox.id}/vision-apply`,
    visionTrade,
  );
  assert.equal(mismatch.status, 409);
  const mismatchPayload = await mismatch.json();
  assert.equal(mismatchPayload.code, 'OCR_AMOUNT_MISMATCH');
  assert.equal(mismatchPayload.ocr_amount, 9999);

  const applied = await postJson(
    `${base}/api/trades/inbox/${uploaded.inbox.id}/vision-apply`,
    {
      ...visionTrade,
      confirm_mismatch: true,
      allow_unknown_code: true,
      confidence: 97,
    },
  );
  assert.equal(applied.status, 200);
  const payload = await applied.json();
  assert.equal(payload.trade.screenshot_id, uploaded.inbox.id);
  assert.equal(payload.trade.status, 'pending');
  assert.equal(payload.inbox.parse_confidence, 97);
  assert.equal(payload.inbox.parsed.trade_date, '2026-10-19');
  assert.ok(payload.checks.some((check) => check.key === 'amount'));

  const overview = await (await fetch(`${base}/api/trades`)).json();
  const codes = overview.overview.reconciliation.items.map((item) => item.code);
  assert.ok(!codes.includes('missing-screenshot'));
});
