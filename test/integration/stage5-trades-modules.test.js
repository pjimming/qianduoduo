'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  requestJson,
  startTestServer,
} = require('../helpers/test-context');

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Wl3sAAAAASUVORK5CYII=';

function imageBody() {
  return {
    filename: 'same.png',
    mime: 'image/png',
    data: `data:image/png;base64,${ONE_PIXEL_PNG}`,
  };
}

test('concurrent identical trade screenshots converge to one inbox record', async (t) => {
  const previousOcr = process.env.R2_OCR;
  process.env.R2_OCR = '0';
  t.after(() => {
    if (previousOcr === undefined) delete process.env.R2_OCR;
    else process.env.R2_OCR = previousOcr;
  });
  const context = await startTestServer(t);
  const body = JSON.stringify(imageBody());
  const responses = await Promise.all([
    fetch(`${context.baseUrl}/api/trades/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
    fetch(`${context.baseUrl}/api/trades/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
  ]);
  const payloads = await Promise.all(
    responses.map((response) => response.json()),
  );
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 201],
  );
  assert.equal(payloads.filter((payload) => payload.duplicate).length, 1);
  const inbox = context.repository.tradeStore.listInbox();
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].status, 'pending');
  assert.match(inbox[0].error, /R2_OCR=0/);
  assert.equal(context.repository.tradeStore.listTrades().length, 0);
});

test('trade inbox apply failure leaves no formal trade and keeps the screenshot pending', async (t) => {
  const previousOcr = process.env.R2_OCR;
  process.env.R2_OCR = '0';
  t.after(() => {
    if (previousOcr === undefined) delete process.env.R2_OCR;
    else process.env.R2_OCR = previousOcr;
  });
  const context = await startTestServer(t);
  const uploaded = await requestJson(`${context.baseUrl}/api/trades/inbox`, {
    method: 'POST',
    body: JSON.stringify(imageBody()),
  });
  assert.equal(uploaded.response.status, 201);
  const id = uploaded.body.inbox.id;
  context.repository.tradeStore.applyInbox = () => {
    throw new Error('injected apply failure');
  };

  const apply = await requestJson(
    `${context.baseUrl}/api/trades/inbox/${id}/apply`,
    {
      method: 'POST',
      body: JSON.stringify({
        trade_date: '2026-10-01',
        trade_type: 'buy',
        status: 'pending',
        product_code: '120056A',
        product_name: '测试产品',
        issuer: '测试银行',
        risk_level: 'R2',
        amount: 10000,
        term_days: 30,
      }),
    },
  );
  assert.equal(apply.response.status, 400, JSON.stringify(apply.body));
  assert.equal(context.repository.tradeStore.listTrades().length, 0);
  assert.equal(
    context.repository.tradeStore.getInboxItem(id).status,
    'pending',
  );
});

test('trade and inbox status commit atomically when inbox update fails', async (t) => {
  const previousOcr = process.env.R2_OCR;
  process.env.R2_OCR = '0';
  t.after(() => {
    if (previousOcr === undefined) delete process.env.R2_OCR;
    else process.env.R2_OCR = previousOcr;
  });
  const context = await startTestServer(t);
  const uploaded = await requestJson(`${context.baseUrl}/api/trades/inbox`, {
    method: 'POST',
    body: JSON.stringify(imageBody()),
  });
  const id = uploaded.body.inbox.id;
  context.repository.db.exec(`
    CREATE TRIGGER fail_trade_inbox_update
    BEFORE UPDATE ON trade_inbox
    BEGIN
      SELECT RAISE(ABORT, 'injected inbox update failure');
    END;
  `);

  const apply = await requestJson(
    `${context.baseUrl}/api/trades/inbox/${id}/apply`,
    {
      method: 'POST',
      body: JSON.stringify({
        trade_date: '2026-10-01',
        trade_type: 'buy',
        status: 'pending',
        product_code: '120056A',
        product_name: '测试产品',
        issuer: '测试银行',
        risk_level: 'R2',
        amount: 10000,
        term_days: 30,
      }),
    },
  );
  assert.equal(apply.response.status, 400, JSON.stringify(apply.body));
  assert.equal(context.repository.tradeStore.listTrades().length, 0);
  assert.equal(
    context.repository.tradeStore.getInboxItem(id).status,
    'pending',
  );
});
