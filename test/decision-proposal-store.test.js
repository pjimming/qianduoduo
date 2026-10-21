'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { makeSourceItems } = require('../lib/inbox-center');

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
