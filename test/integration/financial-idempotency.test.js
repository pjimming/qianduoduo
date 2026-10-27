'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initializeCapital,
  requestJson,
  startTestServer,
} = require('../helpers/test-context');

function tradePayload(overrides = {}) {
  return {
    trade_date: '2026-10-01',
    trade_type: 'buy',
    status: 'pending',
    product_code: '120056A',
    product_name: '测试产品',
    issuer: '测试银行',
    risk_level: 'R2',
    amount: 10000,
    term_days: 30,
    notes: 'integration test',
    ...overrides,
  };
}

test('trade confirmation and partial redemption remain idempotent at the ledger boundary', async (t) => {
  const context = await startTestServer(t);
  initializeCapital(context.repository);

  const created = await requestJson(`${context.baseUrl}/api/trades`, {
    method: 'POST',
    body: JSON.stringify(tradePayload()),
  });
  assert.equal(created.response.status, 201);
  const tradeId = created.body.trade.id;

  const pendingOverview = await requestJson(`${context.baseUrl}/api/trades`);
  assert.equal(pendingOverview.body.overview.summary.open_principal, 0);
  assert.equal(pendingOverview.body.overview.summary.pending_count, 1);

  const duplicateCreate = await requestJson(`${context.baseUrl}/api/trades`, {
    method: 'POST',
    body: JSON.stringify(tradePayload()),
  });
  assert.equal(duplicateCreate.response.status, 409);

  const confirmed = await requestJson(
    `${context.baseUrl}/api/trades/${tradeId}/confirm`,
    {
      method: 'POST',
      body: JSON.stringify({ confirm_date: '2026-10-02' }),
    },
  );
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.overview.summary.open_principal, 10000);

  const confirmedAgain = await requestJson(
    `${context.baseUrl}/api/trades/${tradeId}/confirm`,
    {
      method: 'POST',
      body: JSON.stringify({ confirm_date: '2026-10-02' }),
    },
  );
  assert.equal(confirmedAgain.response.status, 200);
  assert.equal(confirmedAgain.body.overview.summary.open_principal, 10000);
  assert.equal(confirmedAgain.body.overview.holdings.length, 1);

  const redeemed = await requestJson(`${context.baseUrl}/api/trades`, {
    method: 'POST',
    body: JSON.stringify(
      tradePayload({
        trade_date: '2026-10-10',
        trade_type: 'redeem',
        amount: 4000,
        settlement_amount: 4020,
        term_days: null,
      }),
    ),
  });
  assert.equal(redeemed.response.status, 201);
  const redeemedConfirmed = await requestJson(
    `${context.baseUrl}/api/trades/${redeemed.body.trade.id}/confirm`,
    {
      method: 'POST',
      body: JSON.stringify({ confirm_date: '2026-10-11' }),
    },
  );
  assert.equal(redeemedConfirmed.response.status, 200);
  assert.equal(redeemedConfirmed.body.overview.summary.open_principal, 6000);
  assert.equal(redeemedConfirmed.body.overview.summary.realized_pnl, 20);
});

test('same-day income requests do not duplicate or overwrite the ledger', async (t) => {
  const context = await startTestServer(t);
  initializeCapital(context.repository);

  const input = {
    date: '2026-10-12',
    daily_pnl: 12.34,
    action: '无操作',
    notes: 'first',
  };
  const product = await requestJson(
    `${context.baseUrl}/api/product-valuations`,
    {
      method: 'POST',
      body: JSON.stringify({
        yield_date: input.date,
        credit_date: input.date,
        product_code: '120056A',
        product_name: '测试产品',
        holding_amount: 10000,
        daily_pnl: input.daily_pnl,
      }),
    },
  );
  assert.equal(product.response.status, 201);
  const first = await requestJson(`${context.baseUrl}/api/records`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.duplicate, false);
  assert.equal(first.body.changed, true);
  assert.equal(first.body.record.notes, 'first');

  const same = await requestJson(`${context.baseUrl}/api/records`, {
    method: 'POST',
    body: JSON.stringify({ ...input, notes: 'retry should not overwrite' }),
  });
  assert.equal(same.response.status, 200);
  assert.equal(same.body.duplicate, true);
  assert.equal(same.body.record.notes, 'first');

  const conflict = await requestJson(`${context.baseUrl}/api/records`, {
    method: 'POST',
    body: JSON.stringify({ ...input, daily_pnl: 99 }),
  });
  assert.equal(conflict.response.status, 200);
  assert.equal(conflict.body.conflict, null);
  assert.equal(conflict.body.record.daily_pnl, 12.34);
  assert.equal(conflict.body.record.notes, 'first');
  assert.equal(conflict.body.dashboard.records.length, 1);
});
