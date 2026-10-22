'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  requestJson,
  startTestServer,
} = require('../helpers/test-context');

test('capital, ledger and product valuation routes are module-owned and compatible', async (t) => {
  const context = await startTestServer(t);

  const initial = await requestJson(`${context.baseUrl}/api/capital/init`, {
    method: 'POST',
    body: JSON.stringify({
      initial_principal: 100000,
      initial_date: '2026-09-01',
    }),
  });
  assert.equal(initial.response.status, 201);
  assert.equal(initial.body.dashboard.capital.initial_principal, 100000);

  const event = await requestJson(`${context.baseUrl}/api/capital/events`, {
    method: 'POST',
    body: JSON.stringify({
      event_date: '2026-09-10',
      event_type: 'deposit',
      amount: 5000,
      note: 'stage4',
    }),
  });
  assert.equal(event.response.status, 201);
  assert.equal(event.body.event.amount, 5000);

  const record = await requestJson(`${context.baseUrl}/api/records`, {
    method: 'POST',
    body: JSON.stringify({
      date: '2026-09-15',
      daily_pnl: 12.34,
      action: '无操作',
      notes: 'module record',
    }),
  });
  assert.equal(record.response.status, 201);
  assert.equal(record.body.record.principal, 105000);

  const setting = await requestJson(
    `${context.baseUrl}/api/product-yield-settings/120056A`,
    {
      method: 'PUT',
      body: JSON.stringify({
        yield_lag_days: 1,
        source: 'user-confirmed',
        verified_at: '2026-10-22',
        notes: 'stage4',
      }),
    },
  );
  assert.equal(setting.response.status, 200);
  assert.equal(setting.body.setting.product_code, '120056A');

  const valuation = await requestJson(
    `${context.baseUrl}/api/product-valuations`,
    {
      method: 'POST',
      body: JSON.stringify({
        product_code: '120056A',
        product_name: '测试产品',
        yield_date: '2026-09-15',
        credit_date: '2026-09-16',
        daily_pnl: 0,
        holding_amount: 10000,
      }),
    },
  );
  assert.equal(valuation.response.status, 201);
  assert.equal(valuation.body.valuation.daily_pnl, 0);

  const csv = await fetch(`${context.baseUrl}/api/export.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(await csv.text(), /2026-09-15,105000,12.34,无操作,module record/);
});
