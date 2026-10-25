'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { createServer } = require('../server');

const PRODUCT_HEADER = [
  'name',
  'short_name',
  'code',
  'issuer',
  'risk_level',
  'currency_code',
  'pub_prv',
  'soc_tag',
  'product_type',
  'term_days',
  'min_amount',
  'annualized_yield',
  'benchmark',
  'return_1m_annualized',
  'return_3m_annualized',
  'return_6m_annualized',
  'return_1y_annualized',
  'return_since_inception_annualized',
  'status',
  'source',
  'data_date',
  'history_months',
  'fee_bps',
  'next_open_date',
].join(',');

function productRow({
  code,
  name,
  termDays,
  return1m = '',
  return3m = '',
  return6m = '',
  return1y = '',
}) {
  return [
    name,
    name,
    code,
    '测试理财',
    'R2',
    '10',
    'A',
    'C',
    '代销理财',
    termDays,
    '1',
    '2.5',
    '测试基准',
    return1m,
    return3m,
    return6m,
    return1y,
    '2.5',
    '开放中',
    'e2e-fixture',
    '2026-10-21',
    '12',
    '0',
    '2026-10-28',
  ].join(',');
}

async function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function tradePayload(code, name) {
  return {
    trade_date: '2026-10-20',
    confirm_date: '2026-10-20',
    trade_type: 'buy',
    status: 'confirmed',
    product_code: code,
    product_name: name,
    issuer: '测试理财',
    risk_level: 'R2',
    amount: 1000,
    settlement_amount: null,
    shares: null,
    term_days: 90,
    maturity_date: null,
    decision_id: null,
    notes: '',
  };
}

test('return attribution API exposes the three unavailable yield reasons', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'r2-return-attribution-api-'),
  );
  const productCsv = path.join(directory, 'products.csv');
  fs.writeFileSync(
    productCsv,
    [
      PRODUCT_HEADER,
      productRow({
        code: 'AVAILABLE001',
        name: '可用历史产品',
        termDays: '90',
        return1m: '2.4',
        return3m: '2.4',
        return6m: '2.4',
        return1y: '2.4',
      }),
      productRow({
        code: 'UNKNOWN001',
        name: '期限未知产品',
        termDays: '',
        return1m: '2.2',
        return3m: '2.3',
        return6m: '2.4',
        return1y: '2.5',
      }),
      productRow({
        code: 'EMPTY001',
        name: '窗口全缺失产品',
        termDays: '90',
      }),
    ].join('\n'),
    'utf8',
  );
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: productCsv,
    logger: { warn() {} },
  });
  const server = createServer({ repository });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const capital = await postJson(`${base}/api/capital/init`, {
    initial_principal: 4000,
    initial_date: '2026-10-20',
  });
  assert.equal(capital.status, 201);
  const record = await postJson(`${base}/api/records`, {
    date: '2026-10-22',
    daily_pnl: 3,
    action: '无操作',
    notes: '收益归因原因码测试',
  });
  assert.equal(record.status, 201);
  for (const [code, name] of [
    ['AVAILABLE001', '可用历史产品'],
    ['UNKNOWN001', '期限未知产品'],
    ['EMPTY001', '窗口全缺失产品'],
    ['MISSING001', '当前快照缺失产品'],
  ]) {
    const created = await postJson(
      `${base}/api/trades`,
      tradePayload(code, name),
    );
    assert.equal(created.status, 201);
  }

  const response = await fetch(
    `${base}/api/dashboard/sections?include=overview`,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  const products =
    payload.workspace.return_attribution.product_evidence.products;
  const byCode = new Map(
    products.map((product) => [product.product_code, product]),
  );

  assert.equal(byCode.get('AVAILABLE001').reference_yield_status, 'available');
  assert.equal(
    byCode.get('AVAILABLE001').reference_yield_reason,
    'complete_history',
  );
  assert.equal(
    byCode.get('AVAILABLE001').reference_yield_policy_version,
    'r2-term-yield-v1',
  );
  assert.equal(
    byCode.get('UNKNOWN001').reference_yield_reason,
    'unknown_term',
  );
  assert.deepEqual(
    byCode.get('UNKNOWN001').reference_available_horizons,
    [],
  );
  assert.equal(
    byCode.get('EMPTY001').reference_yield_reason,
    'no_available_horizons',
  );
  assert.equal(
    byCode.get('MISSING001').reference_yield_reason,
    'no_product_snapshot',
  );
  assert.equal(
    byCode.get('MISSING001').reference_yield_policy_version,
    null,
  );
});
