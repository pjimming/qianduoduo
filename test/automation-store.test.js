'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');

function openTemp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-automation-'));
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
  return { repository, automation: repository.automationStore };
}

function decisionInput(overrides = {}) {
  return {
    date: '2026-10-01',
    product_name: '测试组合',
    action: '买入',
    reason: '按策略配置',
    expectation: '持有到期达到目标',
    invalidation_condition: '实际年化低于 3% 或期限桶偏离计划时重新评估',
    actual_result: '',
    evidence_date: '2026-10-01',
    verify_date: '2026-12-31',
    rating: '待评估',
    strategy_version: 'custom-ladder-v1',
    target_annualized: 3,
    bucket_plan: { short: 0, medium: 100, long: 0, max_single: 100 },
    evaluation_at: ['buy_day'],
    ...overrides,
  };
}

function buy(repository, decisionId, overrides = {}) {
  return repository.tradeStore.createTrade({
    trade_date: '2026-10-01',
    confirm_date: '2026-10-01',
    trade_type: 'buy',
    status: 'confirmed',
    product_code: 'A001',
    product_name: '测试90天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 10000,
    term_days: 90,
    decision_id: decisionId,
    source: 'manual',
    notes: '',
    ...overrides,
  });
}

function sell(repository, decisionId, overrides = {}) {
  return repository.tradeStore.createTrade({
    trade_date: '2026-10-31',
    confirm_date: '2026-10-31',
    trade_type: 'redeem',
    status: 'confirmed',
    product_code: 'A001',
    product_name: '测试90天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 10000,
    settlement_amount: 10065,
    decision_id: decisionId,
    source: 'manual',
    notes: '',
    ...overrides,
  });
}

test('buy-day evaluation checks strategy and updates the decision text', (t) => {
  const { repository, automation } = openTemp(t);
  automation.updateSettings({ liquidity_floor_pct: 0 });
  const decision = repository.createDecision(decisionInput());
  buy(repository, decision.id);

  const result = automation.runCycle({ today: '2026-10-19', trigger: 'test' });
  assert.equal(result.ok, true);
  const run = automation
    .listRuns()
    .find((item) => item.stage === 'buy_day' && item.decision_id === decision.id);
  assert.ok(run);
  assert.equal(run.process_ok, true);
  assert.equal(run.status, 'auto');
  assert.ok(run.confidence >= 75);
  assert.match(run.evidence.next_update, /持有期或到期\/赎回后更新/);
  const updated = repository.listDecisions().find((item) => item.id === decision.id);
  assert.match(updated.actual_result, /\[自动评估\]/);
  assert.match(updated.actual_result, /流程通过/);
  assert.equal(updated.rating, '待评估');
});

test('correcting a decision date supersedes the stale buy-day evaluation', (t) => {
  const { repository, automation } = openTemp(t);
  const decision = repository.createDecision(decisionInput());

  automation.runCycle({ today: '2026-10-02', trigger: 'first' });
  const firstPending = automation
    .listPendingRuns()
    .find(
      (item) =>
        item.scope === 'decision' &&
        item.stage === 'buy_day' &&
        item.decision_id === decision.id,
    );
  assert.ok(firstPending);
  assert.equal(firstPending.period, '2026-10-01');

  repository.updateDecision(decision.id, {
    ...decision,
    date: '2026-10-02',
  });
  automation.runCycle({ today: '2026-10-02', trigger: 'date-corrected' });

  const buyDayRuns = automation
    .listRuns()
    .filter(
      (item) =>
        item.scope === 'decision' &&
        item.stage === 'buy_day' &&
        item.decision_id === decision.id,
    );
  assert.equal(buyDayRuns.filter((item) => item.status === 'pending').length, 1);
  assert.equal(
    buyDayRuns.find((item) => item.status === 'pending').period,
    '2026-10-02',
  );
  assert.equal(
    buyDayRuns.find((item) => item.id === firstPending.id).status,
    'undone',
  );
  assert.equal(
    automation
      .listJobs({ status: 'pending' })
      .filter(
        (job) =>
          job.job_type === 'evaluation_review' &&
          Number(job.payload.decision_id) === decision.id,
      ).length,
    1,
  );
  assert.ok(
    automation
      .listJobs({ status: 'skipped' })
      .some(
        (job) =>
          job.job_type === 'evaluation_review' &&
          Number(job.payload.evaluation_id) === firstPending.id,
      ),
  );
});

test('a new rule version supersedes pending runs from the previous version', (t) => {
  const { repository, automation } = openTemp(t);
  const decision = repository.createDecision(decisionInput());
  automation.updateSettings({ rule_version: 'r2-eval-test-v1' });
  automation.runCycle({ today: '2026-10-02', trigger: 'v1' });
  const first = automation
    .listPendingRuns()
    .find((item) => item.decision_id === decision.id);
  assert.ok(first);

  automation.updateSettings({ rule_version: 'r2-eval-test-v2' });
  automation.runCycle({ today: '2026-10-02', trigger: 'v2' });
  const runs = automation
    .listRuns()
    .filter(
      (item) =>
        item.decision_id === decision.id && item.stage === 'buy_day',
    );
  const current = runs.find((item) => item.rule_version === 'r2-eval-test-v2');
  const previous = runs.find((item) => item.id === first.id);
  assert.ok(current);
  assert.equal(current.status, 'pending');
  assert.equal(previous.status, 'undone');
  assert.equal(
    automation
      .listJobs({ status: 'pending' })
      .filter(
        (job) =>
          job.job_type === 'evaluation_review' &&
          Number(job.payload.decision_id) === decision.id,
      ).length,
    1,
  );
});

test('maturity evaluation writes a four-quadrant rating and can be undone', (t) => {
  const { repository, automation } = openTemp(t);
  automation.updateSettings({ liquidity_floor_pct: 0 });
  const decision = repository.createDecision(
    decisionInput({ evaluation_at: ['buy_day', 'maturity'] }),
  );
  buy(repository, decision.id);
  sell(repository, decision.id);

  automation.runCycle({ today: '2026-11-01', trigger: 'test' });
  const updated = repository.listDecisions().find((item) => item.id === decision.id);
  assert.equal(updated.rating, '流程正确，结果好');
  const maturity = automation
    .listRuns()
    .find(
      (item) =>
        item.scope === 'decision' &&
        item.stage === 'maturity' &&
        item.decision_id === decision.id,
    );
  assert.ok(maturity);
  assert.equal(maturity.status, 'auto');
  assert.ok(maturity.evidence.annualized_pct > 3);

  automation.undoRun(maturity.id);
  const restored = repository.listDecisions().find((item) => item.id === decision.id);
  assert.equal(restored.rating, '待评估');
  assert.equal(
    automation.listRuns().find((item) => item.id === maturity.id).status,
    'undone',
  );
});

test('missing settlement stays pending; manual confirmation and undo are traceable', (t) => {
  const { repository, automation } = openTemp(t);
  automation.updateSettings({ liquidity_floor_pct: 0 });
  const decision = repository.createDecision(
    decisionInput({ evaluation_at: ['buy_day', 'maturity'] }),
  );
  buy(repository, decision.id);
  sell(repository, decision.id, { settlement_amount: null });

  automation.runCycle({ today: '2026-11-01', trigger: 'test' });
  const pending = automation
    .listPendingRuns()
    .find(
      (item) =>
        item.scope === 'decision' &&
        item.stage === 'maturity' &&
        item.decision_id === decision.id,
    );
  assert.ok(pending);
  assert.equal(pending.outcome, 'unknown');
  assert.ok(pending.confidence < 75);
  assert.equal(repository.listDecisions()[0].rating, '待评估');
  assert.ok(automation.listJobs({ status: 'pending' }).length > 0);

  automation.forceApplyRun(pending.id, { rating: '流程正确，结果差' });
  assert.equal(repository.listDecisions()[0].rating, '流程正确，结果差');
  automation.undoRun(pending.id);
  assert.equal(repository.listDecisions()[0].rating, '待评估');
  assert.equal(automation.getRun(pending.id).status, 'undone');
});

test('manual rating is protected from automatic overwrite', (t) => {
  const { repository, automation } = openTemp(t);
  automation.updateSettings({ liquidity_floor_pct: 0 });
  const decision = repository.createDecision(
    decisionInput({
      evaluation_at: ['buy_day', 'maturity'],
      rating: '流程正确，结果差',
    }),
  );
  buy(repository, decision.id);
  sell(repository, decision.id);

  automation.runCycle({ today: '2026-11-01', trigger: 'test' });
  const updated = repository.listDecisions().find((item) => item.id === decision.id);
  assert.equal(updated.rating, '流程正确，结果差');
  const maturity = automation
    .listRuns()
    .find(
      (item) =>
        item.scope === 'decision' &&
        item.stage === 'maturity' &&
        item.decision_id === decision.id,
    );
  assert.equal(maturity.status, 'pending');
});

test('monthly draft contains generated answers and confirmation saves the note', (t) => {
  const { repository, automation } = openTemp(t);
  repository.createRecord({
    date: '2026-10-10',
    daily_pnl: 10,
    action: '无操作',
    notes: '',
  });
  repository.createRecord({
    date: '2026-10-11',
    daily_pnl: 12,
    action: '无操作',
    notes: '',
  });
  const draft = automation.generateDraft(
    'monthly',
    '2026-10',
    automation.getContext('2026-10-19'),
  );
  assert.equal(draft.status, 'draft');
  assert.equal(draft.content.answers.length, 5);
  assert.equal(typeof draft.content.holdings_changes.net_principal_change, 'number');
  assert.match(draft.content.answers[2], /样本不足|记录/);
  assert.equal(draft.content.calibration.month, '2026-10');
  assert.equal(Array.isArray(draft.content.calibration.records), true);
  const confirmed = automation.confirmDraft('monthly', '2026-10', {
    answers: draft.content.answers,
    conclusion: draft.content.conclusion,
  });
  assert.equal(confirmed.draft.status, 'confirmed');
  assert.equal(confirmed.note.answers.length, 5);
  assert.match(confirmed.note.conclusion, /样本不足|年化|收益/);
  assert.ok(
    automation
      .listJobs()
      .some((job) => job.job_type === 'monthly_summary'),
  );
});

test('repeated cycles dedupe notifications and resolve stale items', (t) => {
  const { repository, automation } = openTemp(t);
  const decision = repository.createDecision(decisionInput());
  buy(repository, decision.id);
  automation.runCycle({ today: '2026-10-19', trigger: 'first' });
  const firstCount = automation.listNotifications({ openOnly: true }).length;
  automation.runCycle({ today: '2026-10-19', trigger: 'second' });
  const secondCount = automation.listNotifications({ openOnly: true }).length;
  assert.equal(secondCount, firstCount);
  const notification = automation
    .listNotifications({ openOnly: true })
    .find((item) => item.kind === 'reconciliation');
  assert.ok(notification);
  automation.markNotification(notification.id, 'resolve');
  automation.runCycle({ today: '2026-10-19', trigger: 'third' });
  const reopened = automation
    .listNotifications()
    .find((item) => item.id === notification.id);
  assert.equal(reopened.resolved_at, null);
  assert.ok(automation.listAutomationRuns(10).length >= 3);
});

test('scheduled cycles create previous month and quarter drafts once', (t) => {
  const { repository, automation } = openTemp(t);
  repository.createRecord({
    date: '2026-10-10',
    daily_pnl: 8,
    action: '无操作',
    notes: '',
  });
  const monthResult = automation.runCycle({
    today: '2026-11-02',
    trigger: 'interval',
  });
  assert.equal(monthResult.summary.drafts_generated, 1);
  const monthlyDraft = automation.getDraft('monthly', '2026-10');
  assert.equal(monthlyDraft.status, 'confirmed');
  assert.ok(repository.getReviewNote('2026-10'));
  automation.runCycle({ today: '2026-11-02', trigger: 'interval' });
  assert.equal(automation.listDrafts().filter((item) => item.period === '2026-10').length, 1);

  const quarterResult = automation.runCycle({
    today: '2026-10-02',
    trigger: 'interval',
  });
  assert.ok(quarterResult.summary.drafts_generated >= 1);
  assert.ok(automation.getDraft('quarterly', '2026-Q3'));
});

test('pending screenshot trades immediately receive an incomplete decision record', (t) => {
  const { repository, automation } = openTemp(t);
  const trade = repository.tradeStore.createTrade({
    trade_date: '2026-10-18',
    confirm_date: null,
    trade_type: 'buy',
    status: 'pending',
    product_code: 'AUTO001',
    product_name: '截图自动入账产品',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 5000,
    term_days: 30,
    decision_id: null,
    source: 'inbox',
    screenshot_id: 1,
    notes: '',
  });

  const result = automation.runCycle({
    today: '2026-10-19',
    trigger: 'test',
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary.auto_decisions_created, 1);
  const decisions = repository.listDecisions();
  const decision = decisions.find(
    (item) =>
      item.review_meta?.source === 'trade-auto' &&
      Number(item.review_meta?.trade_id) === trade.id,
  );
  assert.ok(decision);
  assert.equal(
    repository.tradeStore.getTrade(trade.id).decision_id,
    decision.id,
  );
  assert.equal(decision.review_meta.decision_completeness.complete, false);
  assert.deepEqual(decision.review_meta.decision_completeness.missing_fields, [
    'reason',
    'expectation',
    'invalidation_condition',
  ]);
  assert.equal(decision.review_meta.transaction_status, 'pending');
});

test('unknown evaluations cannot be confirmed without a real conclusion', (t) => {
  const { repository, automation } = openTemp(t);
  const decision = repository.createDecision(decisionInput());
  automation.runCycle({ today: '2026-10-02', trigger: 'test' });
  const pending = automation
    .listPendingRuns()
    .find((item) => item.decision_id === decision.id);
  assert.ok(pending);
  assert.equal(pending.outcome, 'unknown');
  assert.equal(pending.rating, '待评估');
  assert.throws(
    () => automation.forceApplyRun(pending.id, {}),
    /评估结果仍不明确/,
  );
  assert.equal(automation.getRun(pending.id).status, 'pending');
});

test('uncertain income screenshots enter the Codex review queue', (t) => {
  const { repository, automation } = openTemp(t);
  const screenshot = repository.incomeStore.addInbox({
    original_name: 'income.png',
    stored_name: 'income.png',
    mime: 'image/png',
    bytes: 10,
    sha256: 'income-review-test',
    ocr_text: '昨日收益待核对',
    parsed: {
      date: '2026-10-19',
      daily_pnl: null,
      confidence: 20,
      warnings: ['未识别到昨日/当日收益'],
    },
    parse_confidence: 20,
    record_date: '2026-10-19',
  });

  const result = automation.runCycle({
    today: '2026-10-20',
    trigger: 'test',
  });
  assert.equal(result.ok, true);
  assert.ok(result.summary.inbox_notifications >= 1);
  const job = automation
    .listJobs({ status: 'pending' })
    .find(
      (item) =>
        item.job_type === 'income_screenshot_review' &&
        Number(item.payload.income_inbox_id) === screenshot.id,
    );
  assert.ok(job);
});

test('pending evaluation job closes when missing evidence is filled', (t) => {
  const { repository, automation } = openTemp(t);
  automation.updateSettings({ liquidity_floor_pct: 0 });
  const decision = repository.createDecision(
    decisionInput({ evaluation_at: ['buy_day', 'maturity'] }),
  );
  buy(repository, decision.id);
  const redemption = sell(repository, decision.id, { settlement_amount: null });
  automation.runCycle({ today: '2026-11-01', trigger: 'first' });
  assert.ok(
    automation
      .listJobs({ status: 'pending' })
      .some((job) => job.job_type === 'evaluation_review'),
  );

  repository.tradeStore.updateTrade(
    redemption.id,
    { ...redemption, settlement_amount: 10065 },
    '补齐到账金额',
  );
  automation.runCycle({ today: '2026-11-01', trigger: 'second' });
  const updated = repository.listDecisions().find((item) => item.id === decision.id);
  assert.equal(updated.rating, '流程正确，结果好');
  assert.equal(
    automation
      .listJobs({ status: 'pending' })
      .filter((job) => job.job_type === 'evaluation_review').length,
    0,
  );
});
