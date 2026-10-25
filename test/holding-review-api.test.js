'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { createServer } = require('../server');

const { productCsv } = require('./fixtures');

async function startTestServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-holding-review-api-'));
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: productCsv,
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
  return `http://127.0.0.1:${port}`;
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
    trade_date: '2026-10-19',
    confirm_date: '2026-10-20',
    trade_type: 'buy',
    status: 'confirmed',
    product_code: '120056A',
    product_name: '招银理财招睿添金90天持有期6号A',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 7500,
    settlement_amount: null,
    shares: 7208.07,
    term_days: 90,
    maturity_date: null,
    decision_id: null,
    notes: '',
    ...overrides,
  };
}

test('holding review API builds candidates, stores redemption rules and links a replacement decision', async (t) => {
  const base = await startTestServer(t);
  await postJson(`${base}/api/capital/init`, {
    initial_principal: 30000,
    initial_date: '2026-10-19',
  });
  const trade = await postJson(`${base}/api/trades`, tradePayload());
  assert.equal(trade.status, 201);

  let dashboard = await fetch(`${base}/api/dashboard`).then((response) =>
    response.json(),
  );
  assert.equal(dashboard.workspace.holding_reviews.length, 1);
  const review = dashboard.workspace.holding_reviews[0];
  assert.equal(review.product_code, '120056A');
  assert.ok(review.candidates.length > 0);
  assert.equal(review.yield_policy_version, 'r2-term-yield-v1');
  assert.equal(review.current.yield_status, 'available');
  assert.ok(Array.isArray(review.current.yield_available_horizons));
  assert.equal(review.candidates[0].yield_status, 'available');
  assert.deepEqual(review.candidates[0].yield_normalized_weights, {
    return_3m: 0.5,
    return_6m: 0.3,
    return_1y: 0.2,
  });
  assert.equal(review.redemption.redeemable_now, false);
  assert.equal(review.verdict, 'hold');
  assert.equal(review.verdict_label, '继续持有（锁定期）');
  assert.equal(review.review_setting.complete, false);

  const saved = await postJson(
    `${base}/api/holding-reviews/120056A`,
    {
      redemption_days: 1,
      arrival_days: 1,
      redemption_fee_bps: 0,
      purchase_fee_bps: 0,
      purchase_confirm_days: 2,
      next_redeem_open_date: '2027-01-18',
      notes: '产品说明书：赎回 T+1 确认、T+1 到账，赎回费 0',
      verified_at: '2026-10-20',
    },
    'PUT',
  );
  assert.equal(saved.status, 200);
  dashboard = (await saved.json()).dashboard;
  const updated = dashboard.workspace.holding_reviews[0];
  assert.equal(updated.review_setting.complete, true);
  assert.equal(updated.review_setting.purchase_confirm_days, 2);
  assert.equal(updated.review_setting.rollover_gap_days, 0);
  assert.equal('idle_days' in updated.review_setting, false);
  assert.equal('compare_horizon_days' in updated.review_setting, false);
  assert.equal('min_gain_amount' in updated.review_setting, false);
  assert.equal('idle_source' in updated.review_setting, false);
  assert.equal(
    updated.thresholds.min_gain_amount,
    Math.round(
      Math.max(
        1,
        7500 * 0.001 * updated.horizon_days / 90,
      ) * 100,
    ) / 100,
  );
  assert.equal(updated.thresholds.min_gain_rule_pct, 0.1);
  assert.equal(updated.next_redeem_open_date, '2027-01-18');

  const decision = await postJson(`${base}/api/review/decisions`, {
    date: '2026-10-20',
    product_name: '招银理财招睿添金90天持有期6号A → 测试候选',
    action: '观察',
    reason: '锁定期内不可赎回，记录到期后计划；同桶候选参考年化更高',
    expectation: '到期前重新核验候选、额度与赎回规则，再决定是否执行替换',
    invalidation_condition:
      '候选额度、风险、期限或赎回规则恶化，或比较期净增益低于门槛时取消替换',
    actual_result: '',
    strategy_version: 'r2-holding-review-v7',
    target_annualized: 3,
    bucket_plan: { short: 30, medium: 35, long: 35, max_single: 30 },
    evaluation_at: ['holding', 'maturity'],
    evidence_date: '2026-10-16',
    verify_date: '2026-11-19',
    review_meta: {
      holding_code: '120056A',
      candidate_code: '120026A',
      break_even_yield_pct: 2.2,
      difference: 35.5,
      min_gain_amount: 20,
      redeemable_now: false,
      planned_action: 'replace_at_maturity',
    },
    rating: '待评估',
  });
  assert.equal(decision.status, 201);
  const decisionPayload = await decision.json();
  assert.equal(decisionPayload.decision.action, '观察');
  assert.equal(decisionPayload.decision.evidence_date, '2026-10-16');
  assert.equal(decisionPayload.decision.verify_date, '2026-11-19');
  assert.equal(decisionPayload.decision.review_meta.candidate_code, '120026A');
  assert.equal(
    decisionPayload.dashboard.workspace.holding_reviews[0].decision.id,
    decisionPayload.decision.id,
  );

  const badDate = await postJson(`${base}/api/review/decisions`, {
    date: '2026-10-20',
    product_name: '坏日期',
    action: '观察',
    reason: '测试',
    evidence_date: '2026-13-01',
  });
  assert.equal(badDate.status, 400);
});

test('holding review API rejects invalid redemption settings', async (t) => {
  const base = await startTestServer(t);
  const invalid = await postJson(
    `${base}/api/holding-reviews/120056A`,
    {
      redemption_days: 1.5,
      verified_at: '2026-10-20',
    },
    'PUT',
  );
  assert.equal(invalid.status, 400);

  const invalidPurchaseConfirm = await postJson(
    `${base}/api/holding-reviews/120056A`,
    {
      purchase_confirm_days: 1.5,
      verified_at: '2026-10-20',
    },
    'PUT',
  );
  assert.equal(invalidPurchaseConfirm.status, 400);

  const future = await postJson(
    `${base}/api/holding-reviews/120056A`,
    {
      redemption_days: 1,
      arrival_days: 1,
      verified_at: '2099-01-01',
    },
    'PUT',
  );
  assert.equal(future.status, 400);

  const badOpenDate = await postJson(
    `${base}/api/holding-reviews/120056A`,
    {
      next_redeem_open_date: '2027/01/18',
    },
    'PUT',
  );
  assert.equal(badOpenDate.status, 400);

  for (const field of [
    'idle_days',
    'compare_horizon_days',
    'min_gain_amount',
  ]) {
    const deprecated = await postJson(
      `${base}/api/holding-reviews/120056A`,
      { [field]: 1 },
      'PUT',
    );
    assert.equal(deprecated.status, 400);
    assert.match((await deprecated.json()).error, /已停用/);
  }
});

test('holding review API exposes snapshot, partial and unavailable reasons', async (t) => {
  const base = await startTestServer(t);
  const productPayload = await fetch(`${base}/api/dashboard/products`).then(
    (response) => response.json(),
  );
  const partialProduct = productPayload.products.all.find(
    (product) =>
      product.reference_yield_status === 'available' &&
      product.reference_yield_reason === 'partial_history',
  );
  const unavailableProduct = productPayload.products.all.find(
    (product) =>
      product.reference_yield_status === 'unavailable' &&
      product.reference_yield_reason === 'no_available_horizons',
  );
  assert.ok(partialProduct);
  assert.ok(unavailableProduct);

  await postJson(`${base}/api/capital/init`, {
    initial_principal: 30000,
    initial_date: '2026-10-19',
  });
  for (const payload of [
    tradePayload({
      product_code: partialProduct.code,
      product_name: partialProduct.name,
      risk_level: partialProduct.risk_level,
      term_days: partialProduct.term_days,
      amount: 1000,
    }),
    tradePayload({
      product_code: unavailableProduct.code,
      product_name: unavailableProduct.name,
      risk_level: unavailableProduct.risk_level,
      term_days: unavailableProduct.term_days,
      amount: 1000,
    }),
    tradePayload({
      product_code: 'NOT-IN-SNAPSHOT',
      product_name: '不在最新快照的产品',
      term_days: 30,
      amount: 1000,
    }),
  ]) {
    const response = await postJson(`${base}/api/trades`, payload);
    assert.equal(response.status, 201);
  }

  const dashboard = await fetch(`${base}/api/dashboard`).then((response) =>
    response.json(),
  );
  const reviews = new Map(
    dashboard.workspace.holding_reviews.map((review) => [
      review.product_code,
      review,
    ]),
  );
  const partial = reviews.get(partialProduct.code);
  assert.ok(partial);
  assert.equal(partial.review_version, 'r2-holding-review-v7');
  assert.equal(partial.current.yield_status, 'available');
  assert.equal(partial.current.yield_reason, 'partial_history');
  assert.ok(partial.current.yield_available_horizons.length > 0);
  assert.ok(Object.keys(partial.current.yield_normalized_weights).length > 0);

  const unavailable = reviews.get(unavailableProduct.code);
  assert.ok(unavailable);
  assert.equal(unavailable.current.yield_status, 'unavailable');
  assert.equal(
    unavailable.current.yield_reason,
    'no_available_horizons',
  );
  assert.deepEqual(unavailable.current.yield_available_horizons, []);
  assert.deepEqual(unavailable.current.yield_normalized_weights, {});

  const missingSnapshot = reviews.get('NOT-IN-SNAPSHOT');
  assert.ok(missingSnapshot);
  assert.equal(missingSnapshot.current.found, false);
  assert.equal(missingSnapshot.current.yield_status, 'unavailable');
  assert.equal(
    missingSnapshot.current.yield_reason,
    'no_product_snapshot',
  );
  assert.deepEqual(missingSnapshot.current.yield_available_horizons, []);
  assert.deepEqual(missingSnapshot.current.yield_normalized_weights, {});
});
