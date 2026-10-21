'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { createServer } = require('../server');

async function startTestServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-proposal-api-'));
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: null,
    logger: { warn() {} },
  });
  repository.initializeCapital(30000, '2026-10-01');
  const server = createServer({ repository });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}`, repository };
}

function postJson(url, body, method = 'POST') {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function seedProposals(repository) {
  repository.decisionProposalStore.sync({
    meta: {
      today: '2026-10-22',
      product_snapshot_date: '2026-10-21',
    },
    workspace: {
      holding_reviews: [
        {
          lot_id: '1:OLD001',
          product_code: 'OLD001',
          product_name: '旧产品',
          amount: 10000,
          evidence_date: '2026-10-22',
          verify_date: '2026-11-21',
          verdict: 'replace',
          top_candidate_code: 'NEW001',
          redemption: { redeemable_now: true },
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
              switch: { difference: 50, break_even_yield_pct: 2.1 },
            },
          ],
        },
      ],
    },
    products: {
      allocation: { available_cash: 5000 },
      watchlist: [
        {
          code: 'BUY001',
          name: '冗余资金产品',
          selected: true,
          target_amount: 5000,
          target_pct: 16.67,
          allocation_bucket: 'short',
          allocation_reason: '短期桶目标不足',
          selection_score: 82,
          quota_status: 'verified',
          quota_available: 8000,
          quota_verified_at: '2026-10-22',
        },
      ],
    },
  });
}

test('proposal API adopts and rejects without creating premature decisions', async (t) => {
  const { base, repository } = await startTestServer(t);
  seedProposals(repository);
  const workspace = await fetch(`${base}/api/decision-proposals`).then((response) =>
    response.json(),
  );
  assert.equal(workspace.decision_proposals.pending.length, 2);
  assert.equal(repository.listDecisions().length, 0);
  assert.equal(
    workspace.dashboard.inbox_center.items.filter(
      (item) =>
        item.source_type === 'decision_proposal' &&
        item.metadata.proposal_status === 'pending',
    ).length,
    2,
  );

  const holding = workspace.decision_proposals.pending.find(
    (item) => item.proposal_type === 'holding_switch',
  );
  const adoptedResponse = await postJson(
    `${base}/api/decision-proposals/${holding.id}/adopt`,
    {},
  );
  assert.equal(adoptedResponse.status, 200);
  const adopted = await adoptedResponse.json();
  assert.equal(adopted.result.proposal.status, 'accepted');
  assert.equal(adopted.result.decision.review_meta.execution_status, 'pending');
  assert.equal(repository.listDecisions().length, 1);
  assert.ok(
    adopted.dashboard.inbox_center.items.some(
      (item) =>
        item.source_type === 'decision_proposal' &&
        item.metadata.proposal_id === holding.id &&
        item.title === '决策已采纳，待执行',
    ),
  );

  const allocation = workspace.decision_proposals.pending.find(
    (item) => item.proposal_type === 'cash_allocation',
  );
  const rejectedResponse = await postJson(
    `${base}/api/decision-proposals/${allocation.id}/reject`,
    { reason: '当前不接受该期限' },
  );
  assert.equal(rejectedResponse.status, 200);
  const rejected = await rejectedResponse.json();
  assert.equal(rejected.result.proposal.status, 'rejected');
  assert.equal(repository.listDecisions().length, 1);
  assert.equal(
    rejected.dashboard.inbox_center.items.some(
      (item) =>
        item.metadata.proposal_id === allocation.id &&
        item.status === 'active',
    ),
    false,
  );

  const deleted = await fetch(
    `${base}/api/review/decisions/${adopted.result.decision.id}`,
    { method: 'DELETE' },
  );
  assert.equal(deleted.status, 200);
  const deletedPayload = await deleted.json();
  assert.equal(
    deletedPayload.dashboard.decision_proposals.history.find(
      (item) => item.id === holding.id,
    ).status,
    'rejected',
  );
});

test('an API-created trade automatically claims the accepted proposal and flags missing screenshot evidence', async (t) => {
  const { base, repository } = await startTestServer(t);
  seedProposals(repository);
  const proposal = repository.decisionProposalStore
    .getWorkspace('2026-10-22')
    .pending.find((item) => item.proposal_type === 'cash_allocation');
  const adopted = repository.decisionProposalStore.adoptProposal(proposal.id, {
    today: '2026-10-22',
  });
  const response = await postJson(`${base}/api/trades`, {
    trade_date: '2026-10-22',
    confirm_date: null,
    trade_type: 'buy',
    status: 'pending',
    product_code: 'BUY001',
    product_name: '冗余资金产品',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 5000,
    term_days: 7,
    decision_id: null,
    notes: '成交截图自动入账',
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.trade.decision_id, adopted.decision.id);
  const decision = payload.dashboard.workspace.decisions.find(
    (item) => item.id === adopted.decision.id,
  );
  assert.equal(decision.review_meta.execution_status, 'executed');
  assert.equal(decision.review_meta.audit_status, 'review');
  assert.equal(
    decision.review_meta.audit_checks.find((item) => item.key === 'screenshot')
      .pass,
    false,
  );
  assert.deepEqual(decision.review_meta.matched_trade_ids, [payload.trade.id]);
});

test('trade inbox apply uses the same proposal matching path', async (t) => {
  const { base, repository } = await startTestServer(t);
  seedProposals(repository);
  const proposal = repository.decisionProposalStore
    .getWorkspace('2026-10-22')
    .pending.find((item) => item.proposal_type === 'cash_allocation');
  const adopted = repository.decisionProposalStore.adoptProposal(proposal.id, {
    today: '2026-10-22',
  });
  const inbox = repository.tradeStore.addInbox({
    original_name: 'matched-proposal.png',
    stored_name: '',
    mime: 'image/png',
    bytes: 10,
    sha256: 'matched-proposal-image',
    ocr_text: '买入 BUY001 5000',
    parsed: {
      trade_date: '2026-10-22',
      trade_type: 'buy',
      status: 'pending',
      product_code: 'BUY001',
      product_name: '冗余资金产品',
      issuer: '招银理财',
      risk_level: 'R2',
      amount: 5000,
      term_days: 7,
    },
    parse_confidence: 95,
    notes: '',
  });
  const response = await postJson(
    `${base}/api/trades/inbox/${inbox.id}/apply`,
    {},
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.trade.decision_id, adopted.decision.id);
  assert.equal(
    payload.dashboard.workspace.decisions.find(
      (item) => item.id === adopted.decision.id,
    ).review_meta.audit_status,
    'matched',
  );
});
