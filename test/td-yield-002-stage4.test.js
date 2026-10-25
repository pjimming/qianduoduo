'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { buildHoldingReview } = require('../lib/holdings-review');
const {
  buildHoldingAmountsByDate,
  buildWindows,
  enrichRecords,
} = require('../lib/metrics');
const { buildProductView } = require('../lib/products');
const { buildReturnAttribution } = require('../lib/return-attribution');

const TODAY = '2026-10-20';
const SNAPSHOT_DATE = '2026-10-19';

function rawProduct({
  code,
  name,
  termDays = 30,
  return1m = null,
  return3m = null,
  return6m = null,
  return1y = null,
  historyMonths = 24,
}) {
  return {
    id: code,
    name,
    short_name: name,
    code,
    issuer: '测试理财',
    risk_level: 'R2',
    currency_code: '10',
    pub_prv: 'A',
    soc_tag: 'C',
    product_type: '代销理财',
    term_days: termDays,
    score: null,
    min_amount: 1,
    annualized_yield: 9,
    benchmark: `基准-${code}`,
    return_1m: return1m,
    return_3m: return3m,
    return_6m: return6m,
    return_1y: return1y,
    return_since_inception: 2,
    status: '开放中',
    source: 'stage4-fixture',
    data_date: SNAPSHOT_DATE,
    notes: '',
    capacity: null,
    history_months: historyMonths,
    fee_bps: 0,
    next_open_date: '2026-10-21',
  };
}

function recordsForAttribution(trades) {
  const records = Array.from({ length: 30 }, (_, index) => {
    const day = String(index + 1).padStart(2, '0');
    return {
      date: index < 10 ? `2026-09-${day}` : `2026-10-${String(index - 9).padStart(2, '0')}`,
      principal: 50000,
      daily_pnl: 2,
      action: '无操作',
      notes: '',
    };
  });
  return enrichRecords(records, {
    holdingAmountsByDate: buildHoldingAmountsByDate(records, trades),
  });
}

function unavailableReview() {
  const unavailable = {
    found: true,
    yield_pct: null,
    yield_status: 'unavailable',
    yield_reason: 'no_available_horizons',
    yield_available_horizons: [],
    yield_normalized_weights: {},
    yield_policy_version: 'r2-term-yield-v1',
  };
  return {
    lot_id: '1:NO_WINDOWS',
    product_code: 'NO_WINDOWS',
    product_name: '不可计算收益产品',
    amount: 10000,
    evidence_date: SNAPSHOT_DATE,
    verify_date: '2026-11-19',
    yield_policy_version: 'r2-term-yield-v1',
    verdict: 'replace',
    top_candidate_code: 'NO_WINDOWS_NEXT',
    current: unavailable,
    redemption: {
      redeemable_now: true,
      available_date: TODAY,
      reason: '测试可赎回',
    },
    thresholds: { min_gain_amount: 1 },
    candidates: [
      {
        code: 'NO_WINDOWS_NEXT',
        name: '不可计算候选',
        comparison_days: 30,
        switch_wait_days: 1,
        switch_wait_status: 'verified',
        effective_days: 29,
        execution_ready: true,
        min_gain_amount: 1,
        switch: {
          difference: 100,
          break_even_yield_pct: 1,
        },
        ...unavailable,
        yield_policy_version: 'r2-term-yield-v1',
        bucket: 'short',
      },
    ],
  };
}

function openTemp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-stage4-'));
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: null,
    logger: { warn() {} },
  });
  repository.initializeCapital(50000, TODAY);
  t.after(() => {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return repository;
}

test('raw returns flow through ranking, holding review, attribution and proposal', (t) => {
  const currentProduct = rawProduct({
    code: 'CURRENT30',
    name: '当前短期产品',
    return1m: 1.8,
    return3m: 2,
    return6m: 2.4,
    return1y: 2.5,
  });
  const betterProduct = rawProduct({
    code: 'BETTER30',
    name: '更优短期产品',
    return1m: 3,
    return3m: 4,
    return6m: 4.2,
    return1y: 4.4,
  });
  const lowerProduct = rawProduct({
    code: 'LOWER30',
    name: '较低短期产品',
    return1m: 2,
    return3m: 2.2,
    return6m: 2.4,
    return1y: 2.6,
  });
  const products = [currentProduct, betterProduct, lowerProduct];
  const productView = buildProductView(products, {
    principal: 50000,
    holdings: [],
    pending_trades: [],
  });
  assert.ok(productView.watchlist.length > 0);
  assert.equal(productView.watchlist[0].code, 'BETTER30');
  for (let index = 1; index < productView.watchlist.length; index += 1) {
    assert.ok(
      productView.watchlist[index - 1].selection_score >=
        productView.watchlist[index].selection_score,
    );
  }
  const decoratedCurrent = productView.all.find(
    (product) => product.code === 'CURRENT30',
  );
  const decoratedBetter = productView.all.find(
    (product) => product.code === 'BETTER30',
  );
  assert.equal(decoratedCurrent.bucket, 'short');
  assert.equal(decoratedBetter.bucket, 'short');
  assert.equal(decoratedCurrent.reference_yield_pct, 2.08);
  assert.equal(decoratedBetter.reference_yield_pct, 3.86);

  const review = buildHoldingReview({
    holding: {
      id: 1,
      lot_id: '1:CURRENT30',
      product_code: 'CURRENT30',
      product_name: '当前短期产品',
      issuer: '测试理财',
      risk_level: 'R2',
      amount: 10000,
      purchase_date: '2026-09-01',
      term_days: 30,
      maturity_date: '2026-10-19',
    },
    products: productView.all,
    universe: products,
    principal: 50000,
    settingsByCode: {
      CURRENT30: {
        redemption_days: 1,
        arrival_days: 0,
        redemption_fee_bps: 0,
        purchase_fee_bps: 0,
        purchase_confirm_days: 1,
        verified_at: SNAPSHOT_DATE,
      },
      BETTER30: {
        purchase_confirm_days: 1,
        verified_at: SNAPSHOT_DATE,
      },
    },
    quotaByCode: {
      BETTER30: {
        available: 50000,
        max_order: null,
        window: '已核验',
        verified_at: SNAPSHOT_DATE,
      },
    },
    today: TODAY,
    snapshotDate: SNAPSHOT_DATE,
  });
  assert.equal(review.current.yield_pct, decoratedCurrent.reference_yield_pct);
  assert.deepEqual(
    review.current.yield_normalized_weights,
    decoratedCurrent.reference_normalized_weights,
  );
  assert.ok(
    review.current.yield_available_horizons.includes('6m'),
  );
  const topCandidate = review.candidates.find(
    (candidate) => candidate.code === 'BETTER30',
  );
  assert.ok(topCandidate);
  assert.equal(topCandidate.yield_pct, decoratedBetter.reference_yield_pct);
  assert.deepEqual(
    topCandidate.yield_normalized_weights,
    decoratedBetter.reference_normalized_weights,
  );
  assert.equal(
    review.verdict,
    'replace',
    JSON.stringify({
      redemption: review.redemption,
      candidates: review.candidates.map((candidate) => ({
        code: candidate.code,
        verdict: candidate.verdict,
        reasons: candidate.reasons,
        data_gaps: candidate.data_gaps,
        switch: candidate.switch,
        execution_ready: candidate.execution_ready,
      })),
    }),
  );
  assert.equal(review.top_candidate_code, 'BETTER30');

  const trades = [
    {
      id: 1,
      trade_date: '2026-09-01',
      confirm_date: '2026-09-01',
      trade_type: 'buy',
      status: 'confirmed',
      product_code: 'CURRENT30',
      product_name: '当前短期产品',
      amount: 10000,
    },
  ];
  const records = recordsForAttribution(trades);
  const valuations = records.map((record) => ({
    yield_date: record.date,
    product_code: 'CURRENT30',
    product_name: '当前短期产品',
    daily_pnl: record.daily_pnl,
  }));
  const attribution = buildReturnAttribution({
    records,
    trades,
    products,
    valuations,
    windowSummary: buildWindows(records)[30],
    targetAnnualized: 3,
    today: TODAY,
  });
  const attributedCurrent = attribution.product_evidence.products.find(
    (product) => product.product_code === 'CURRENT30',
  );
  assert.ok(attributedCurrent);
  assert.equal(
    attributedCurrent.reference_yield_pct,
    decoratedCurrent.reference_yield_pct,
  );
  assert.deepEqual(
    attributedCurrent.reference_normalized_weights,
    decoratedCurrent.reference_normalized_weights,
  );
  assert.equal(
    attributedCurrent.reference_yield_policy_version,
    productView.selection.yield_policy_version,
  );
  assert.equal(
    attribution.product_evidence.account_pnl,
    attribution.actual.observed_period_pnl,
  );

  const repository = openTemp(t);
  repository.decisionProposalStore.sync({
    meta: {
      today: TODAY,
      product_snapshot_date: SNAPSHOT_DATE,
    },
    workspace: { holding_reviews: [review] },
    products: {
      allocation: { available_cash: 0 },
      watchlist: [],
    },
  });
  const workspace = repository.decisionProposalStore.getWorkspace(TODAY);
  const proposal = workspace.pending.find(
    (item) => item.proposal_type === 'holding_switch',
  );
  assert.ok(proposal);
  assert.equal(proposal.product_code, 'CURRENT30');
  assert.equal(proposal.target_product_code, 'BETTER30');
  assert.equal(
    proposal.payload.yield_policy.current.reference_yield_pct,
    review.current.yield_pct,
  );
  assert.equal(
    proposal.payload.yield_policy.candidate.reference_yield_pct,
    topCandidate.yield_pct,
  );
  assert.deepEqual(
    proposal.payload.yield_policy.candidate.normalized_weights,
    topCandidate.yield_normalized_weights,
  );
  assert.equal(
    proposal.yield_policy_version,
    productView.selection.yield_policy_version,
  );
});

test('unavailable products never fall back to legacy yield, cash or proposals', (t) => {
  const noWindows = rawProduct({
    code: 'NO_WINDOWS',
    name: '窗口全缺失产品',
    termDays: 90,
    historyMonths: 24,
  });
  const view = buildProductView([noWindows], {
    principal: 50000,
    holdings: [],
    pending_trades: [],
  });
  const product = view.all.find((item) => item.code === 'NO_WINDOWS');
  assert.ok(product);
  assert.equal(product.reference_yield_status, 'unavailable');
  assert.equal(product.reference_yield_reason, 'no_available_horizons');
  assert.equal(product.reference_yield_pct, null);
  assert.equal(product.weighted_yield_pct, null);
  assert.equal(product.observation_score, null);
  assert.equal(product.selection_score, null);
  assert.equal(product.observation_ready, false);
  assert.equal(product.target_amount, 0);
  assert.equal(product.selected, false);
  assert.equal(
    view.watchlist.some((item) => item.code === 'NO_WINDOWS'),
    false,
  );

  const repository = openTemp(t);
  repository.decisionProposalStore.sync({
    meta: {
      today: TODAY,
      product_snapshot_date: SNAPSHOT_DATE,
    },
    workspace: { holding_reviews: [] },
    products: {
      allocation: { available_cash: 5000 },
      watchlist: [
        {
          ...product,
          selected: true,
          target_amount: 5000,
          target_pct: 10,
          allocation_bucket: 'medium',
          allocation_mode: 'new',
          meaningful_min_amount: 1,
          quota_status: 'verified',
          quota_available: 5000,
          quota_verified_at: SNAPSHOT_DATE,
          data_date: SNAPSHOT_DATE,
        },
      ],
    },
  });
  assert.equal(
    repository.decisionProposalStore
      .getWorkspace(TODAY)
      .pending.some((item) => item.product_code === 'NO_WINDOWS'),
    false,
  );

  repository.decisionProposalStore.sync({
    meta: {
      today: TODAY,
      product_snapshot_date: SNAPSHOT_DATE,
    },
    workspace: { holding_reviews: [unavailableReview()] },
    products: {
      allocation: { available_cash: 0 },
      watchlist: [],
    },
  });
  assert.equal(
    repository.decisionProposalStore
      .getWorkspace(TODAY)
      .pending.some(
        (item) =>
          item.product_code === 'NO_WINDOWS' ||
          item.target_product_code === 'NO_WINDOWS_NEXT',
      ),
    false,
  );
});

test('cash targets are rejected at proposal generation, sync and adoption', (t) => {
  const cashProduct = rawProduct({
    code: 'CASH001',
    name: '日开现金产品',
    termDays: 0,
    return1m: 1.5,
    return3m: 1.6,
  });
  const view = buildProductView([cashProduct], {
    principal: 50000,
    holdings: [],
    pending_trades: [],
  });
  const decoratedCash = view.all.find((product) => product.code === 'CASH001');
  assert.ok(decoratedCash);
  assert.equal(decoratedCash.bucket, 'cash');

  const repository = openTemp(t);
  const dashboard = {
    meta: {
      today: TODAY,
      product_snapshot_date: SNAPSHOT_DATE,
    },
    workspace: { holding_reviews: [] },
    products: {
      allocation: { available_cash: 5000 },
      watchlist: [
        {
          ...decoratedCash,
          selected: true,
          target_amount: 5000,
          target_pct: 10,
          allocation_mode: 'new',
          meaningful_min_amount: 1,
          quota_status: 'verified',
          quota_available: 5000,
          quota_verified_at: SNAPSHOT_DATE,
        },
      ],
    },
  };
  repository.decisionProposalStore.sync(dashboard);
  assert.equal(
    repository.decisionProposalStore.getWorkspace(TODAY).pending.length,
    0,
  );

  const insert = repository.db.prepare(`
    INSERT INTO decision_proposals (
      dedupe_key, group_key, proposal_type, title, summary, action,
      product_name, product_code, target_product_code, target_product_name,
      amount, evidence_date, expires_at, verify_date, confidence,
      status, decision_id, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)
  `);
  const payload = {
    yield_policy: {
      version: 'r2-term-yield-v1',
      product: {
        product_code: 'CASH001',
        product_name: '日开现金产品',
        bucket: 'cash',
        yield_policy_version: 'r2-term-yield-v1',
        reference_yield_pct: 1.53,
        status: 'available',
        reason: 'complete_history',
        available_horizons: ['1m', '3m'],
        normalized_weights: {
          return_1m: 0.7,
          return_3m: 0.3,
        },
      },
    },
    review_meta: { yield_policy_version: 'r2-term-yield-v1' },
  };
  const stamp = new Date().toISOString();
  const inserted = insert.run(
    'cash-sync-test',
    'allocation:CASH001',
    'cash_allocation',
    '现金产品提案',
    '现金产品不应生成提案',
    '买入',
    '日开现金产品',
    'CASH001',
    '',
    '',
    5000,
    SNAPSHOT_DATE,
    '2026-10-27',
    '2026-11-19',
    80,
    JSON.stringify(payload),
    stamp,
    stamp,
  );
  repository.decisionProposalStore.sync(dashboard);
  assert.equal(
    repository.decisionProposalStore.getProposal(
      Number(inserted.lastInsertRowid),
    ).status,
    'expired',
  );

  const second = insert.run(
    'cash-adopt-test',
    'allocation:CASH001',
    'cash_allocation',
    '现金产品提案',
    '现金产品不应被采纳',
    '买入',
    '日开现金产品',
    'CASH001',
    '',
    '',
    5000,
    SNAPSHOT_DATE,
    '2026-10-27',
    '2026-11-19',
    80,
    JSON.stringify(payload),
    stamp,
    stamp,
  );
  const secondId = Number(second.lastInsertRowid);
  assert.throws(
    () =>
      repository.decisionProposalStore.adoptProposal(secondId, {
        today: TODAY,
      }),
    /cash 产品不能进入/,
  );
  assert.equal(
    repository.decisionProposalStore.expireInvalidCashProposal(secondId),
    true,
  );
  assert.equal(
    repository.decisionProposalStore.getProposal(secondId).status,
    'expired',
  );
  assert.equal(repository.listDecisions().length, 0);
});
