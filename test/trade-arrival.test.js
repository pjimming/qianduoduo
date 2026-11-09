'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initializeCapital,
  requestJson,
  startTestServer,
} = require('./helpers/test-context');

function tradePayload(overrides = {}) {
  return {
    trade_date: '2026-10-19',
    confirm_date: '2026-10-19',
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

async function json(base, path, options = {}) {
  return requestJson(`${base}${path}`, {
    ...options,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
}

async function setup(t) {
  const server = await startTestServer(t);
  initializeCapital(server.repository, { principal: 100000, date: '2026-09-01' });
  const buy = await json(server.baseUrl, '/api/trades', {
    method: 'POST',
    body: tradePayload(),
  });
  assert.equal(buy.response.status, 201);
  const redeem = await json(server.baseUrl, '/api/trades', {
    method: 'POST',
    body: tradePayload({
      trade_type: 'redeem',
      amount: 4000,
      settlement_amount: 4040,
      term_days: null,
    }),
  });
  assert.equal(redeem.response.status, 201);
  return { ...server, buyId: buy.body.trade.id, redeemId: redeem.body.trade.id };
}

test('PUT /api/trades/:id records a verified arrival date on a confirmed redemption', async (t) => {
  const { baseUrl, redeemId } = await setup(t);
  const updated = await json(baseUrl, `/api/trades/${redeemId}`, {
    method: 'PUT',
    body: { arrival_date: '2026-10-25', note: '银行到账截图已核' },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.trade.arrival_date, '2026-10-25');
  assert.equal(typeof updated.body.trade.arrival_verified_at, 'string');
  assert.ok(!Number.isNaN(Date.parse(updated.body.trade.arrival_verified_at)));

  const listed = await json(baseUrl, '/api/trades');
  assert.equal(listed.response.status, 200);
  const stored = listed.body.overview.trades.find((trade) => trade.id === redeemId);
  assert.equal(stored.arrival_date, '2026-10-25');
  assert.equal(stored.arrival_verified_at, updated.body.trade.arrival_verified_at);
});

test('arrival date rejects malformed, pre-confirmation and buy-side values', async (t) => {
  const { baseUrl, buyId, redeemId } = await setup(t);
  const malformed = await json(baseUrl, `/api/trades/${redeemId}`, {
    method: 'PUT',
    body: { arrival_date: '2026-10-32' },
  });
  assert.equal(malformed.response.status, 400);
  assert.match(JSON.stringify(malformed.body), /到账日期/);

  const early = await json(baseUrl, `/api/trades/${redeemId}`, {
    method: 'PUT',
    body: { arrival_date: '2026-10-18' },
  });
  assert.equal(early.response.status, 400);
  assert.match(JSON.stringify(early.body), /不能早于/);

  const buy = await json(baseUrl, `/api/trades/${buyId}`, {
    method: 'PUT',
    body: { arrival_date: '2026-10-25' },
  });
  assert.equal(buy.response.status, 400);
  assert.match(JSON.stringify(buy.body), /已确认的赎回交易/);
});

test('null or empty arrival date clears the verified fact and the settlement projection', async (t) => {
  const { baseUrl, repository, redeemId } = await setup(t);
  const valid = { method: 'PUT', body: { arrival_date: '2026-10-25' } };
  assert.equal((await json(baseUrl, `/api/trades/${redeemId}`, valid)).response.status, 200);

  const context = repository.automationStore.getContext('2026-10-20');
  const settlement = context.executionSettlements.find((row) => row.trade_id === redeemId);
  assert.deepEqual(settlement, {
    trade_id: redeemId,
    product_code: '120056A',
    arrival_date: '2026-10-25',
    status: 'verified',
    verified: true,
  });

  const cleared = await json(baseUrl, `/api/trades/${redeemId}`, {
    method: 'PUT',
    body: { arrival_date: null },
  });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.body.trade.arrival_date, null);
  assert.equal(cleared.body.trade.arrival_verified_at, null);
  assert.equal(
    repository.automationStore.getContext('2026-10-20').executionSettlements
      .some((row) => row.trade_id === redeemId),
    false,
  );

  assert.equal((await json(baseUrl, `/api/trades/${redeemId}`, valid)).response.status, 200);
  const emptied = await json(baseUrl, `/api/trades/${redeemId}`, {
    method: 'PUT',
    body: { arrival_date: '' },
  });
  assert.equal(emptied.response.status, 200);
  assert.equal(emptied.body.trade.arrival_date, null);
  assert.equal(emptied.body.trade.arrival_verified_at, null);
});
