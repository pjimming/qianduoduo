'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { makeSourceItems } = require('../lib/inbox-center');
const { buildProductView } = require('../lib/products');

function openTemp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-proposals-'));
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: null,
    logger: { warn() {} },
  });
  repository.initializeCapital(30000, '2026-10-01');
  t.after(() => {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return repository;
}

function holdingReview() {
  return {
    lot_id: '1:OLD001',
    product_code: 'OLD001',
    product_name: '旧产品',
    amount: 10000,
    evidence_date: '2026-10-22',
    verify_date: '2026-11-21',
    verdict: 'replace',
    top_candidate_code: 'NEW001',
    redemption: {
      redeemable_now: true,
      available_date: '2026-10-22',
      reason: '日开产品当前可赎回',
    },
    thresholds: { min_gain_amount: 10 },
    candidates: [
      {
        code: 'NEW001',
        name: '新产品',
        comparison_days: 30,
        switch_wait_days: 2,
        switch_wait_status: 'verified',
        effective_days: 28,
        execution_ready: true,
        min_gain_amount: 10,
        switch: {
          difference: 50,
          break_even_yield_pct: 2.1,
        },
      },
    ],
  };
}

function allocationProduct() {
  return {
    code: 'BUY001',
    name: '冗余资金产品',
    selected: true,
    target_amount: 5000,
    target_pct: 16.67,
    allocation_bucket: 'short',
    allocation_reason: '短期桶目标不足，额度和集中度均满足',
    selection_score: 82,
    quota_status: 'verified',
    quota_available: 8000,
    quota_verified_at: '2026-10-22',
  };
}

function proposalDashboard() {
  return {
    meta: {
      today: '2026-10-22',
      product_snapshot_date: '2026-10-21',
    },
    workspace: {
      holding_reviews: [holdingReview()],
    },
    products: {
      allocation: { available_cash: 5000 },
      watchlist: [allocationProduct()],
    },
  };
}

test('proposal engine creates holding-switch and cash-allocation proposals without decisions', (t) => {
  const repository = openTemp(t);
  repository.decisionProposalStore.sync(proposalDashboard());
  const workspace = repository.decisionProposalStore.getWorkspace('2026-10-22');
  assert.equal(workspace.pending.length, 2);
  assert.equal(repository.listDecisions().length, 0);
  assert.ok(
    workspace.pending.some(
      (item) =>
        item.proposal_type === 'holding_switch' &&
        item.product_code === 'OLD001' &&
        item.target_product_code === 'NEW001',
    ),
  );
  assert.ok(
    workspace.pending.some(
      (item) =>
        item.proposal_type === 'cash_allocation' &&
        item.product_code === 'BUY001' &&
        item.amount === 5000,
    ),
  );
});

test('cash proposals preserve top-up mode and reject undersized first positions', (t) => {
  const repository = openTemp(t);
  const dashboard = proposalDashboard();
  dashboard.workspace.holding_reviews = [];
  dashboard.products.allocation.available_cash = 5500;
  dashboard.products.watchlist = [
    {
      ...allocationProduct(),
      code: 'TOPUP001',
      name: '已确认持仓补仓',
      target_amount: 5000,
      allocation_mode: 'top_up',
      existing_exposure: 12000,
      meaningful_target_amount: 10000,
      meaningful_min_amount: 100,
    },
    {
      ...allocationProduct(),
      code: 'SMALLNEW',
      name: '低于门槛的新仓',
      target_amount: 500,
      allocation_mode: 'new',
      existing_exposure: 0,
      meaningful_target_amount: 10000,
      meaningful_min_amount: 5000,
    },
  ];
  repository.decisionProposalStore.sync(dashboard);
  const workspace = repository.decisionProposalStore.getWorkspace('2026-10-22');
  const cashProposals = workspace.pending.filter(
    (item) => item.proposal_type === 'cash_allocation',
  );
  assert.equal(cashProposals.length, 1);
  assert.equal(cashProposals[0].product_code, 'TOPUP001');
  assert.equal(cashProposals[0].amount, 5000);
  assert.match(cashProposals[0].title, /持仓补仓/);
  assert.equal(cashProposals[0].payload.review_meta.allocation_mode, 'top_up');
  assert.equal(cashProposals[0].payload.review_meta.existing_exposure, 12000);
  assert.equal(cashProposals[0].payload.review_meta.meaningful_min_amount, 100);
  assert.equal(
    workspace.pending.some((item) => item.product_code === 'SMALLNEW'),
    false,
  );
});

test('cash proposals expire without funding and can be reissued after funding returns', (t) => {
  const repository = openTemp(t);
  repository.decisionProposalStore.sync(proposalDashboard());
  const original = repository.decisionProposalStore
    .getWorkspace('2026-10-22')
    .pending.find((item) => item.proposal_type === 'cash_allocation');
  assert.ok(original);

  const noFunding = proposalDashboard();
  noFunding.products.allocation.available_cash = 0;
  noFunding.workspace.holding_reviews = [];
  repository.decisionProposalStore.sync(noFunding);
  let workspace = repository.decisionProposalStore.getWorkspace('2026-10-22');
  assert.equal(
    workspace.pending.some((item) => item.proposal_type === 'cash_allocation'),
    false,
  );
  const expired = workspace.history.find((item) => item.id === original.id);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.reject_reason, '当前可分配资金为 0，自动作废');

  repository.decisionProposalStore.sync(noFunding);
  workspace = repository.decisionProposalStore.getWorkspace('2026-10-22');
  assert.equal(
    workspace.history.filter((item) => item.id === original.id).length,
    1,
  );
  assert.equal(
    workspace.pending.some((item) => item.proposal_type === 'cash_allocation'),
    false,
  );

  repository.decisionProposalStore.sync(proposalDashboard());
  workspace = repository.decisionProposalStore.getWorkspace('2026-10-22');
  const reissued = workspace.pending.find(
    (item) => item.proposal_type === 'cash_allocation',
  );
  assert.ok(reissued);
  assert.notEqual(reissued.id, original.id);
  assert.match(reissued.dedupe_key, /:reissue:/);
  assert.equal(
    workspace.history.find((item) => item.id === original.id).status,
    'expired',
  );

  repository.decisionProposalStore.adoptProposal(reissued.id, {
    today: '2026-10-22',
  });
  repository.decisionProposalStore.sync(noFunding);
  workspace = repository.decisionProposalStore.getWorkspace('2026-10-22');
  assert.equal(
    workspace.accepted.some((item) => item.id === reissued.id),
    true,
  );
});

test('adopted proposal predictions are frozen and later corrections append versions', (t) => {
  const repository = openTemp(t);
  repository.decisionProposalStore.sync(proposalDashboard());
  const proposal = repository.decisionProposalStore
    .getWorkspace('2026-10-22')
    .pending.find((item) => item.proposal_type === 'cash_allocation');
  const original = proposal.payload.prediction;
  assert.ok(original);
  assert.equal(original.expected.target.point, proposal.amount);

  const adopted = repository.decisionProposalStore.adoptProposal(proposal.id, {
    today: '2026-10-22',
  });
  assert.equal(adopted.decision.review_meta.predictions.length, 1);
  assert.equal(
    adopted.decision.review_meta.predictions[0].id,
    original.id,
  );

  const unchanged = repository.updateDecision(adopted.decision.id, {
    ...adopted.decision,
    expectation: '人工更新说明，但不得改写预测',
    review_meta: {
      ...adopted.decision.review_meta,
      predictions: [],
    },
  });
  assert.equal(unchanged.review_meta.predictions[0].id, original.id);
  assert.equal(
    unchanged.review_meta.predictions[0].expected.target.point,
    original.expected.target.point,
  );

  const corrected = repository.addPredictionVersion(adopted.decision.id, {
    source: 'human-correction',
    start_date: '2026-10-22',
    review_date: '2026-11-21',
    confidence: 70,
    baseline: original.baseline,
    expected: {
      direction: 'at_least',
      target: { point: proposal.amount - 500, unit: '元' },
    },
    metric: 'executed_amount',
    evaluation: {
      method: 'confirmed_trade_amount',
      tolerance_abs: 1,
    },
    invalidation_condition: original.invalidation_condition,
    invalidation_triggers: original.invalidation_triggers,
    original_text: '下调执行金额目标',
    reason: '执行条件变化',
  });
  assert.equal(corrected.review_meta.predictions.length, 2);
  assert.equal(corrected.review_meta.predictions[0].id, original.id);
  assert.equal(corrected.review_meta.predictions[0].expected.target.point, original.expected.target.point);
  assert.equal(corrected.review_meta.predictions[1].version, 2);
  assert.equal(
    corrected.review_meta.predictions[1].expected.target.point,
    proposal.amount - 500,
  );
});

test('zero available cash never expires accepted or holding-switch proposals', (t) => {
  const repository = openTemp(t);
  repository.decisionProposalStore.sync(proposalDashboard());
  const workspace = repository.decisionProposalStore.getWorkspace('2026-10-22');
  const cash = workspace.pending.find(
    (item) => item.proposal_type === 'cash_allocation',
  );
  const holding = workspace.pending.find(
    (item) => item.proposal_type === 'holding_switch',
  );
  assert.ok(cash);
  assert.ok(holding);
  repository.decisionProposalStore.adoptProposal(cash.id, {
    today: '2026-10-22',
  });

  const noFunding = proposalDashboard();
  noFunding.products.allocation.available_cash = 0;
  repository.decisionProposalStore.sync(noFunding);
  const next = repository.decisionProposalStore.getWorkspace('2026-10-22');

  assert.equal(
    next.accepted.some((item) => item.id === cash.id),
    true,
  );
  assert.equal(
    next.pending.some((item) => item.id === holding.id),
    true,
  );
});

test('allocation UI result and generated top-up proposal use the same code and amount', (t) => {
  const repository = openTemp(t);
  const candidate = {
    name: '真实配置补仓产品',
    code: 'REAL-TOPUP',
    short_name: '',
    issuer: '真实发行方',
    risk_level: 'R2',
    currency_code: '10',
    pub_prv: 'A',
    soc_tag: 'C',
    product_type: '代销理财',
    term_days: 14,
    score: null,
    min_amount: 100,
    annualized_yield: 3,
    benchmark: '真实基准',
    return_1m: 2.5,
    return_3m: 2.7,
    return_6m: 2.8,
    return_1y: 3,
    return_since_inception: 2.9,
    status: '开放中',
    source: 'test',
    data_date: '2026-10-21',
    notes: '',
    capacity: null,
    history_months: 24,
    fee_bps: 10,
    next_open_date: '2026-10-22',
  };
  const productView = buildProductView([candidate], {
    principal: 100000,
    holdings: [
      {
        product_code: 'REAL-TOPUP',
        product_name: candidate.name,
        issuer: candidate.issuer,
        amount: 29000,
        term_days: 14,
      },
      {
        product_code: 'MEDIUM-HELD',
        product_name: '已确认中期持仓',
        issuer: '其他发行方',
        amount: 35000,
        term_days: 90,
      },
      {
        product_code: 'LONG-HELD',
        product_name: '已确认长期持仓',
        issuer: '其他发行方',
        amount: 35000,
        term_days: 180,
      },
    ],
  });
  const allocatedProduct = productView.watchlist[0];
  assert.equal(allocatedProduct.code, 'REAL-TOPUP');
  assert.equal(allocatedProduct.allocation_mode, 'top_up');
  assert.equal(allocatedProduct.target_amount, 1000);

  repository.decisionProposalStore.sync({
    meta: {
      today: '2026-10-22',
      product_snapshot_date: '2026-10-21',
    },
    workspace: { holding_reviews: [] },
    products: productView,
  });
  const proposal = repository.decisionProposalStore
    .getWorkspace('2026-10-22')
    .pending.find((item) => item.proposal_type === 'cash_allocation');
  assert.ok(proposal);
  assert.equal(proposal.product_code, allocatedProduct.code);
  assert.equal(proposal.amount, allocatedProduct.target_amount);
  assert.equal(proposal.payload.review_meta.target_amount, allocatedProduct.target_amount);
  assert.equal(
    proposal.payload.review_meta.existing_exposure,
    allocatedProduct.existing_exposure,
  );
  assert.equal(
    proposal.payload.review_meta.meaningful_min_amount,
    allocatedProduct.meaningful_min_amount,
  );
});

test('an active switch proposal replaces the duplicate holding-review reminder', (t) => {
  const repository = openTemp(t);
  repository.decisionProposalStore.sync(proposalDashboard());
  const proposal = repository.decisionProposalStore
    .getWorkspace('2026-10-22')
    .pending.find((item) => item.proposal_type === 'holding_switch');
  const items = makeSourceItems({
    meta: { today: '2026-10-22', reporting_date: '2026-10-21' },
    workspace: {
      holding_reviews: [holdingReview()],
      trades: { inbox: [], trades: [], reconciliation: { items: [] } },
      events: [],
      income_inbox: [],
    },
    automation: { pending_evaluations: [], drafts: [], notifications: [] },
    decision_proposals: {
      proposals: [proposal],
    },
    capital: { initialized: false },
  });
  assert.equal(
    items.filter((item) => item.source_type === 'holding_review').length,
    0,
  );
  assert.equal(
    items.filter(
      (item) =>
        item.source_type === 'decision_proposal' &&
        item.metadata.proposal_id === proposal.id,
    ).length,
    1,
  );
});

test('an existing replacement decision does not create a holding-review message', () => {
  const review = holdingReview();
  review.decision = { id: 2 };
  const items = makeSourceItems({
    meta: { today: '2026-10-22', reporting_date: '2026-10-21' },
    workspace: {
      holding_reviews: [review],
      trades: { inbox: [], trades: [], reconciliation: { items: [] } },
      events: [],
      income_inbox: [],
    },
    automation: { pending_evaluations: [], drafts: [], notifications: [] },
    decision_proposals: { proposals: [] },
    capital: { initialized: false },
  });
  assert.equal(
    items.filter((item) => item.source_type === 'holding_review').length,
    0,
  );
});

test('adopting a switch proposal creates a pending decision and screenshot trades match both legs', (t) => {
  const repository = openTemp(t);
  repository.tradeStore.createTrade({
    trade_date: '2026-10-01',
    confirm_date: '2026-10-01',
    trade_type: 'buy',
    status: 'confirmed',
    product_code: 'OLD001',
    product_name: '旧产品',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 10000,
    term_days: 0,
    decision_id: null,
    source: 'manual',
    screenshot_id: null,
    notes: '',
  });
  repository.decisionProposalStore.sync(proposalDashboard());
  const proposal = repository.decisionProposalStore
    .getWorkspace('2026-10-22')
    .pending.find((item) => item.proposal_type === 'holding_switch');
  const adopted = repository.decisionProposalStore.adoptProposal(proposal.id, {
    today: '2026-10-22',
  });
  assert.equal(adopted.proposal.status, 'accepted');
  assert.equal(adopted.decision.review_meta.execution_status, 'pending');

  const redeem = repository.tradeStore.createTrade({
    trade_date: '2026-10-22',
    confirm_date: null,
    trade_type: 'redeem',
    status: 'pending',
    product_code: 'OLD001',
    product_name: '旧产品',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 10000,
    term_days: 0,
    decision_id: null,
    source: 'inbox',
    screenshot_id: 1,
    notes: '',
  });
  const firstMatch = repository.decisionProposalStore.matchTrade(
    redeem,
    '2026-10-22',
  );
  assert.equal(firstMatch.trade.decision_id, adopted.decision.id);
  assert.equal(firstMatch.audit.execution_status, 'partial');

  const buy = repository.tradeStore.createTrade({
    trade_date: '2026-10-22',
    confirm_date: null,
    trade_type: 'buy',
    status: 'pending',
    product_code: 'NEW001',
    product_name: '新产品',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 10000,
    term_days: 7,
    decision_id: null,
    source: 'inbox',
    screenshot_id: 2,
    notes: '',
  });
  const secondMatch = repository.decisionProposalStore.matchTrade(
    buy,
    '2026-10-22',
  );
  assert.equal(secondMatch.audit.execution_status, 'executed');
  assert.equal(secondMatch.audit.audit_status, 'matched');
  assert.equal(secondMatch.proposal.status, 'executed');

  repository.tradeStore.confirmTrade(redeem.id, '2026-10-23', '确认赎回');
  repository.tradeStore.confirmTrade(buy.id, '2026-10-23', '确认买入');
  repository.decisionProposalStore.reconcileExecutionStatuses('2026-10-23');
  const finalDecision = repository
    .listDecisions()
    .find((item) => item.id === adopted.decision.id);
  const finalProposal = repository.decisionProposalStore.getProposal(proposal.id);
  assert.equal(finalDecision.review_meta.execution_status, 'confirmed');
  assert.equal(finalProposal.status, 'confirmed');
});

test('rejecting a proposal creates neither a decision nor executable state', (t) => {
  const repository = openTemp(t);
  repository.decisionProposalStore.sync(proposalDashboard());
  const proposal = repository.decisionProposalStore
    .getWorkspace('2026-10-22')
    .pending.find((item) => item.proposal_type === 'cash_allocation');
  const rejected = repository.decisionProposalStore.rejectProposal(proposal.id, {
    reason: '当前不接受锁定期',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(repository.listDecisions().length, 0);
  assert.equal(
    repository.decisionProposalStore
      .getWorkspace('2026-10-22')
      .pending.some((item) => item.id === proposal.id),
    false,
  );
  repository.decisionProposalStore.sync(proposalDashboard());
  assert.equal(
    repository.decisionProposalStore
      .getWorkspace('2026-10-22')
      .history.filter((item) => item.id === proposal.id).length,
    1,
  );
});

test('an adopted proposal can be cancelled before any transaction is linked', (t) => {
  const repository = openTemp(t);
  repository.decisionProposalStore.sync(proposalDashboard());
  const proposal = repository.decisionProposalStore
    .getWorkspace('2026-10-22')
    .pending.find((item) => item.proposal_type === 'cash_allocation');
  const adopted = repository.decisionProposalStore.adoptProposal(proposal.id, {
    today: '2026-10-22',
  });
  const rejected = repository.decisionProposalStore.rejectProposal(proposal.id, {
    reason: '资金安排改变',
  });
  const decision = repository
    .listDecisions()
    .find((item) => item.id === adopted.decision.id);
  assert.equal(rejected.status, 'rejected');
  assert.equal(decision.review_meta.execution_status, 'cancelled');
  assert.equal(decision.review_meta.lifecycle_status, 'cancelled');
});

test('stale proposals expire instead of being adopted later', (t) => {
  const repository = openTemp(t);
  repository.decisionProposalStore.sync(proposalDashboard());
  const proposal = repository.decisionProposalStore
    .getWorkspace('2026-10-22')
    .pending.find((item) => item.proposal_type === 'cash_allocation');
  assert.throws(
    () =>
      repository.decisionProposalStore.adoptProposal(proposal.id, {
        today: '2026-11-01',
      }),
    /已过期/,
  );
  const expiredWorkspace =
    repository.decisionProposalStore.getWorkspace('2026-11-01');
  assert.equal(
    expiredWorkspace.history.find((item) => item.id === proposal.id).status,
    'expired',
  );
  assert.equal(repository.listDecisions().length, 0);
});

test('an unmatched transaction becomes an explicit unplanned decision', (t) => {
  const repository = openTemp(t);
  repository.decisionProposalStore.sync(proposalDashboard());
  const proposal = repository.decisionProposalStore
    .getWorkspace('2026-10-22')
    .pending.find((item) => item.proposal_type === 'cash_allocation');
  repository.decisionProposalStore.adoptProposal(proposal.id, {
    today: '2026-10-22',
  });
  const trade = repository.tradeStore.createTrade({
    trade_date: '2026-10-22',
    confirm_date: null,
    trade_type: 'buy',
    status: 'pending',
    product_code: 'OTHER001',
    product_name: '计划外产品',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 3000,
    term_days: 7,
    decision_id: null,
    source: 'inbox',
    screenshot_id: 3,
    notes: '',
  });
  assert.equal(
    repository.decisionProposalStore.matchTrade(trade, '2026-10-22'),
    null,
  );
  repository.automationStore.ensureTradeDecisions();
  const linked = repository.tradeStore.getTrade(trade.id);
  assert.ok(linked.decision_id);
  const decision = repository
    .listDecisions()
    .find((item) => item.id === linked.decision_id);
  assert.equal(decision.review_meta.execution_status, 'unplanned');
  assert.equal(decision.review_meta.audit_status, 'unplanned');
});

test('a trade linked to the wrong proposal is surfaced as an execution deviation', (t) => {
  const repository = openTemp(t);
  repository.decisionProposalStore.sync(proposalDashboard());
  const proposal = repository.decisionProposalStore
    .getWorkspace('2026-10-22')
    .pending.find((item) => item.proposal_type === 'cash_allocation');
  const adopted = repository.decisionProposalStore.adoptProposal(proposal.id, {
    today: '2026-10-22',
  });
  repository.tradeStore.createTrade({
    trade_date: '2026-10-22',
    confirm_date: null,
    trade_type: 'buy',
    status: 'pending',
    product_code: 'WRONG001',
    product_name: '错误产品',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 5000,
    term_days: 7,
    decision_id: adopted.decision.id,
    source: 'inbox',
    screenshot_id: 9,
    notes: '',
  });
  repository.decisionProposalStore.reconcileExecutionStatuses('2026-10-22');
  const decision = repository
    .listDecisions()
    .find((item) => item.id === adopted.decision.id);
  assert.equal(decision.review_meta.execution_status, 'deviation');
  assert.equal(decision.review_meta.audit_status, 'deviation');
  const workspace = repository.decisionProposalStore.getWorkspace('2026-10-22');
  assert.equal(
    workspace.proposals.find((item) => item.id === proposal.id)
      .decision_execution_status,
    'deviation',
  );
});
