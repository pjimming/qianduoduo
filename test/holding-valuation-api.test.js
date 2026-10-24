'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shiftDate, todayShanghai } = require('../lib/metrics');
const {
  requestJson,
  startTestServer,
} = require('./helpers/test-context');

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Wl3sAAAAASUVORK5CYII=';

function tradePayload(overrides = {}) {
  return {
    trade_date: '2026-10-20',
    confirm_date: '2026-10-20',
    trade_type: 'buy',
    status: 'confirmed',
    product_code: '120026A',
    product_name: '招银理财14天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 15000,
    settlement_amount: null,
    shares: null,
    term_days: 14,
    maturity_date: null,
    decision_id: null,
    notes: '',
    ...overrides,
  };
}

test('holding valuation API updates dashboard with confirmed holdings value', async (t) => {
  const { baseUrl, repository } = await startTestServer(t);
  const today = todayShanghai();
  repository.tradeStore.createTrade(tradePayload());
  repository.tradeStore.createTrade(
    tradePayload({
      product_code: '120056A',
      product_name: '招银理财90天',
      amount: 15000,
      term_days: 90,
    }),
  );
  repository.tradeStore.createTrade(
    tradePayload({
      trade_date: '2026-10-23',
      confirm_date: null,
      status: 'pending',
      product_code: 'JX040210',
      product_name: '建信理财7天',
      amount: 16000,
      term_days: 7,
    }),
  );
  repository.productValuationStore.upsertMany(
    [
      {
        yield_date: shiftDate(today, -1),
        product_code: '120026A',
        product_name: '招银理财14天',
        daily_pnl: 2.5,
        confidence: 100,
      },
      {
        yield_date: shiftDate(today, -1),
        product_code: '120056A',
        product_name: '招银理财90天',
        daily_pnl: 3.53,
        confidence: 100,
      },
    ],
    { source: 'income-screenshot', screenshotId: 1 },
  );

  const before = await requestJson(`${baseUrl}/api/dashboard`);
  assert.equal(before.response.status, 200);
  assert.equal(
    before.body.workspace.current_holdings_valuation.current_value,
    30006.03,
  );
  assert.equal(
    before.body.workspace.current_holdings_valuation.product_income,
    6.03,
  );
  assert.equal(
    before.body.workspace.current_holdings_valuation.bank_reconciliation
      .status,
    'missing',
  );
  assert.equal(
    before.body.workspace.current_holdings_valuation.pending_buy_amount,
    16000,
  );

  const created = await requestJson(`${baseUrl}/api/holding-valuations`, {
    method: 'POST',
    body: JSON.stringify({
      as_of_date: today,
      total_value: 30006.04,
      source: 'user-confirmed',
      notes: '银行当前已确认持仓总市值',
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.created, true);
  assert.equal(created.body.snapshot.total_value, 30006.04);
  assert.equal(
    created.body.dashboard.workspace.current_holdings_valuation.current_value,
    30006.03,
  );
  assert.equal(
    created.body.dashboard.workspace.current_holdings_valuation.active_cost,
    30000,
  );
  assert.equal(
    created.body.dashboard.workspace.current_holdings_valuation.status,
    'current',
  );
  assert.equal(
    created.body.dashboard.workspace.current_holdings_valuation
      .bank_reconciliation.status,
    'rounding',
  );
  assert.equal(
    created.body.dashboard.workspace.current_holdings_valuation
      .bank_reconciliation.difference,
    -0.01,
  );
  assert.equal(
    created.body.dashboard.workspace.current_holdings_valuation
      .bank_reconciliation.matched,
    true,
  );
  assert.equal(
    created.body.dashboard.workspace.current_holdings_valuation
      .pending_buy_amount,
    16000,
  );

  const duplicate = await requestJson(`${baseUrl}/api/holding-valuations`, {
    method: 'POST',
    body: JSON.stringify({
      as_of_date: today,
      total_value: 30006.04,
      source: 'user-confirmed',
      notes: '重复提交',
    }),
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.created, false);
  assert.equal(
    duplicate.body.snapshot.id,
    created.body.snapshot.id,
  );

  const evidence = await requestJson(
    `${baseUrl}/api/holding-valuations/evidence`,
    {
      method: 'POST',
      body: JSON.stringify({
        filename: 'bank-holdings.png',
        mime: 'image/png',
        data: ONE_PIXEL_PNG,
      }),
    },
  );
  assert.equal(
    evidence.response.status,
    201,
    JSON.stringify(evidence.body),
  );
  assert.equal(evidence.body.evidence.evidence_type, 'bank-statement');
  const evidenceImage = await fetch(
    `${baseUrl}/api/holding-valuations/evidence/${evidence.body.evidence.id}/image`,
  );
  assert.equal(evidenceImage.status, 200);
  assert.equal(evidenceImage.headers.get('content-type'), 'image/png');
  assert.equal((await evidenceImage.arrayBuffer()).byteLength, 68);

  const withEvidence = await requestJson(
    `${baseUrl}/api/holding-valuations`,
    {
      method: 'POST',
      body: JSON.stringify({
        as_of_date: today,
        total_value: 30006.04,
        source: 'user-confirmed',
        evidence_id: evidence.body.evidence.id,
        notes: '绑定银行持仓截图',
      }),
    },
  );
  assert.equal(withEvidence.response.status, 201);
  assert.equal(
    withEvidence.body.dashboard.workspace.current_holdings_valuation
      .previous_value,
    30006.04,
  );
  assert.equal(
    withEvidence.body.dashboard.workspace.current_holdings_valuation
      .change_since_previous,
    0,
  );

  const listed = await requestJson(
    `${baseUrl}/api/holding-valuations?limit=10`,
  );
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.current.current_value, 30006.03);
  assert.equal(listed.body.current.bank_reconciliation.bank_value, 30006.04);
  assert.equal(listed.body.snapshots.length, 2);

  const future = await requestJson(`${baseUrl}/api/holding-valuations`, {
    method: 'POST',
    body: JSON.stringify({
      as_of_date: shiftDate(today, 1),
      total_value: 30006.04,
    }),
  });
  assert.equal(future.response.status, 400);
  assert.match(future.body.error, /不能晚于今天/);
});
