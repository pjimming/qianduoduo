'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  requestJson,
  startTestServer,
} = require('../helpers/test-context');

function decisionInput(overrides = {}) {
  return {
    date: '2026-09-01',
    product_name: '测试组合',
    action: '观察',
    reason: '验证阶段 6 事务',
    expectation: '验证历史状态一致',
    invalidation_condition: '事务无法回滚',
    actual_result: '',
    strategy_version: 'r2-3pct-v1',
    target_annualized: 3,
    bucket_plan: { short: 30, medium: 35, long: 35, max_single: 30 },
    evaluation_at: ['buy_day', 'holding', 'maturity'],
    evidence_date: '2026-09-01',
    verify_date: '2026-09-30',
    review_meta: {},
    rating: '待评估',
    ...overrides,
  };
}

test('proposal adopt rolls back decision when proposal status update fails', async (t) => {
  const context = await startTestServer(t);
  const stamp = new Date().toISOString();
  const payload = {
    decision: {
      reason: '测试采纳回滚',
      expectation: '无孤儿决策',
      invalidation_condition: '失败未回滚',
      bucket_plan: { short: 30, medium: 35, long: 35, max_single: 30 },
    },
    expected_legs: [],
  };
  const inserted = context.repository.db.prepare(`
    INSERT INTO decision_proposals (
      dedupe_key, group_key, proposal_type, title, summary, action,
      product_name, product_code, target_product_code, target_product_name,
      amount, evidence_date, expires_at, verify_date, confidence, status,
      decision_id, payload_json, created_at, updated_at
    ) VALUES (?, ?, 'cash_allocation', ?, ?, '买入', ?, ?, '', '',
      10000, '2026-09-01', '2026-12-31', '2026-09-30', 80, 'pending',
      NULL, ?, ?, ?)
  `).run(
    'stage6:proposal',
    'stage6:group',
    '阶段 6 提案',
    '测试事务',
    '测试产品',
    '120056A',
    JSON.stringify(payload),
    stamp,
    stamp,
  );
  context.repository.db.exec(`
    CREATE TRIGGER fail_proposal_update
    BEFORE UPDATE ON decision_proposals
    BEGIN
      SELECT RAISE(ABORT, 'injected proposal update failure');
    END;
  `);

  const response = await requestJson(
    `${context.baseUrl}/api/decision-proposals/${Number(inserted.lastInsertRowid)}/adopt`,
    { method: 'POST', body: '{}' },
  );
  assert.equal(response.response.status, 400);
  assert.equal(context.repository.listDecisions().length, 0);
  assert.equal(
    context.repository.decisionProposalStore.getProposal(
      Number(inserted.lastInsertRowid),
    ).status,
    'pending',
  );
});

test('evaluation apply rolls back decision when run status update fails', async (t) => {
  const context = await startTestServer(t);
  const decision = context.repository.createDecision(decisionInput());
  const stamp = new Date().toISOString();
  const inserted = context.repository.db.prepare(`
    INSERT INTO evaluation_runs (
      dedupe_key, scope, decision_id, trade_id, stage, period,
      evaluated_for, rule_version, source, confidence, confidence_level,
      process_ok, outcome, rating, summary, evidence_json, status,
      created_at, updated_at
    ) VALUES (?, 'decision', ?, NULL, 'maturity', '2026-09',
      '2026-09-30', 'r2-eval-v2', 'automation', 95, 'high',
      1, 'good', '流程正确，结果好', '测试评估', '{}', 'pending', ?, ?)
  `).run(
    'stage6:evaluation',
    decision.id,
    stamp,
    stamp,
  );
  context.repository.db.exec(`
    CREATE TRIGGER fail_evaluation_update
    BEFORE UPDATE ON evaluation_runs
    BEGIN
      SELECT RAISE(ABORT, 'injected evaluation update failure');
    END;
  `);

  const response = await requestJson(
    `${context.baseUrl}/api/evaluations/${Number(inserted.lastInsertRowid)}/apply`,
    { method: 'POST', body: '{}' },
  );
  assert.equal(response.response.status, 400);
  const unchanged = context.repository.listDecisions().find(
    (item) => item.id === decision.id,
  );
  assert.equal(unchanged.rating, '待评估');
  assert.equal(unchanged.actual_result, '');
});

test('draft confirmation rolls back note when draft status update fails', async (t) => {
  const context = await startTestServer(t);
  const stamp = new Date().toISOString();
  context.repository.db.prepare(`
    INSERT INTO review_drafts (
      period_type, period, status, content_json, generated_at, updated_at
    ) VALUES ('monthly', '2026-09', 'draft', ?, ?, ?)
  `).run(
    JSON.stringify({
      answers: ['a', 'b', 'c', 'd', 'e'],
      conclusion: 'draft conclusion',
    }),
    stamp,
    stamp,
  );
  context.repository.db.exec(`
    CREATE TRIGGER fail_draft_update
    BEFORE UPDATE ON review_drafts
    BEGIN
      SELECT RAISE(ABORT, 'injected draft update failure');
    END;
  `);

  const response = await requestJson(
    `${context.baseUrl}/api/review/drafts/monthly/2026-09/confirm`,
    {
      method: 'POST',
      body: JSON.stringify({
        answers: ['a', 'b', 'c', 'd', 'e'],
        conclusion: 'confirmed conclusion',
      }),
    },
  );
  assert.equal(response.response.status, 400);
  assert.equal(context.repository.getReviewNote('2026-09'), null);
  assert.equal(
    context.repository.automationStore.getDraft('monthly', '2026-09').status,
    'draft',
  );
});
