'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const {
  createDashboardQueryService,
} = require('../server/modules/dashboard/service');

function openTemp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-projection-'));
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

function snapshotState(repository) {
  return Object.fromEntries(
    ['decision_proposals', 'notifications', 'inbox_items'].map((table) => [
      table,
      repository.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
    ]),
  );
}

function saveBridgeNotification(repository, input) {
  return repository.automationStore.saveNotification({
    dedupe_key:
      `codex-r2-review:capital-bridge:${input.bridge_date}:${input.bridge_amount}` +
      (input.suffix ? `:${input.suffix}` : ''),
    kind: 'agent_confirmation',
    level: 'warn',
    title: '桥接本金待转出',
    message: '请核对转出并恢复目标本金。',
    data: {
      category: 'action',
      severity: 'warn',
      action_label: '查看本金账户',
      action_url: '/ledger/daily#capital',
      due_at: '2026-10-23',
      source: 'codex-r2-review',
      capital_bridge: {
        bridge_amount: input.bridge_amount,
        bridge_date: input.bridge_date,
        withdraw_date: input.withdraw_date || null,
        target_principal: input.target_principal,
        decision_id: input.decision_id,
      },
    },
  });
}

test('dashboard reads do not mutate proposals, notifications or inbox state', (t) => {
  const repository = openTemp(t);
  repository.automationStore.saveNotification({
    dedupe_key: 'agent-confirmation:read-only-test',
    kind: 'agent_confirmation',
    level: 'info',
    title: '只读测试提醒',
    message: '读取 Dashboard 不应更新消息状态。',
    data: { category: 'action', severity: 'info', source: 'test' },
  });
  const query = createDashboardQueryService(repository, {
    todayProvider: () => '2026-10-23',
  });
  query.projectDashboard();
  const before = snapshotState(repository);

  const dashboard = query.getDashboard();
  const workspace = query.getWorkspace();

  assert.ok(
    dashboard.inbox_center.items.some(
      (item) => item.metadata.notification_id,
    ),
  );
  assert.ok(workspace.timeline);
  assert.deepEqual(snapshotState(repository), before);
});

test('capital bridge reminders resolve only after matching deposit, withdrawal and principal recovery', (t) => {
  const repository = openTemp(t);
  const decision = repository.createDecision({
    date: '2026-10-22',
    product_name: '桥接切换',
    action: '切换',
    reason: '测试桥接本金',
    expectation: '完成转出并恢复目标本金',
    invalidation_condition: '转出缺失或目标本金未恢复',
    actual_result: '',
    strategy_version: 'r2-3pct-v1',
    target_annualized: 3,
    bucket_plan: { short: 30, medium: 35, long: 35, max_single: 30 },
    evaluation_at: ['buy_day', 'holding', 'maturity'],
    evidence_date: '2026-10-22',
    verify_date: '2026-10-23',
    review_meta: {},
    rating: '待评估',
  });

  const matching = saveBridgeNotification(repository, {
    bridge_amount: 3000,
    bridge_date: '2026-10-22',
    withdraw_date: '2026-10-23',
    target_principal: 30000,
    decision_id: decision.id,
    suffix: 'matching',
  });
  const wrongDecision = saveBridgeNotification(repository, {
    bridge_amount: 1000,
    bridge_date: '2026-10-22',
    withdraw_date: '2026-10-23',
    target_principal: 30000,
    decision_id: 9999,
    suffix: 'wrong-decision',
  });
  const targetNotRestored = saveBridgeNotification(repository, {
    bridge_amount: 500,
    bridge_date: '2026-10-22',
    withdraw_date: '2026-10-23',
    target_principal: 35000,
    decision_id: decision.id,
    suffix: 'target-not-restored',
  });
  const unrelated = repository.automationStore.saveNotification({
    dedupe_key: 'agent-confirmation:other',
    kind: 'agent_confirmation',
    level: 'info',
    title: '其他提醒',
    message: '不得被桥接提醒规则关闭。',
    data: { category: 'action', severity: 'info', source: 'test' },
  });

  repository.createCapitalEvent({
    date: '2026-10-22',
    type: 'deposit',
    amount: 3000,
    note: '第一条桥接本金',
  });
  repository.createCapitalEvent({
    date: '2026-10-23',
    type: 'withdraw',
    amount: 3000,
    note: '第一条桥接本金已完成转出',
  });
  repository.createCapitalEvent({
    date: '2026-10-22',
    type: 'deposit',
    amount: 1000,
    note: '第二条桥接本金',
  });
  repository.createCapitalEvent({
    date: '2026-10-23',
    type: 'withdraw',
    amount: 1000,
    note: '第二条桥接本金已完成转出',
  });
  repository.createCapitalEvent({
    date: '2026-10-22',
    type: 'deposit',
    amount: 500,
    note: '第三条桥接本金',
  });
  repository.createCapitalEvent({
    date: '2026-10-23',
    type: 'withdraw',
    amount: 500,
    note: '第三条桥接本金已完成转出',
  });
  const query = createDashboardQueryService(repository, {
    todayProvider: () => '2026-10-23',
  });
  const dashboard = query.projectDashboard();
  const notifications = repository.automationStore.listNotifications();
  const byId = new Map(notifications.map((item) => [item.id, item]));

  assert.ok(byId.get(matching.id).resolved_at);
  assert.equal(byId.get(wrongDecision.id).resolved_at, null);
  assert.equal(byId.get(targetNotRestored.id).resolved_at, null);
  assert.equal(byId.get(unrelated.id).resolved_at, null);
  const resolvedInbox = dashboard.inbox_center.items.find(
    (item) =>
      item.metadata.notification_id === matching.id &&
      item.status === 'resolved',
  );
  assert.ok(resolvedInbox);
  assert.ok(resolvedInbox.resolved_at);
  const enriched = byId.get(matching.id).data.capital_bridge;
  assert.equal(enriched.target_principal, 30000);
  assert.equal(enriched.decision_id, decision.id);
  assert.equal(enriched.withdraw_date, '2026-10-23');

  const resolvedAt = byId.get(matching.id).resolved_at;
  query.projectDashboard();
  assert.equal(
    repository.automationStore
      .listNotifications()
      .find((item) => item.id === matching.id).resolved_at,
    resolvedAt,
  );
});

test('capital bridge reminder resolves when the withdrawal was recorded before the reminder', (t) => {
  const repository = openTemp(t);
  repository.createCapitalEvent({
    date: '2026-10-22',
    type: 'deposit',
    amount: 2000,
    note: '第二笔桥接本金',
  });
  repository.createCapitalEvent({
    date: '2026-10-23',
    type: 'withdraw',
    amount: 2000,
    note: '先记录转出',
  });
  const notification = repository.automationStore.saveNotification({
    dedupe_key: 'codex-r2-review:capital-bridge:2026-10-22:2000',
    kind: 'agent_confirmation',
    level: 'warn',
    title: '旧版桥接本金提醒',
    message: '兼容仅靠 dedupe_key 识别金额和日期的旧提醒。',
    data: {
      category: 'action',
      severity: 'warn',
      action_label: '查看本金账户',
      action_url: '/ledger/daily#capital',
      due_at: '2026-10-23',
      source: 'codex-r2-review',
    },
  });
  repository.createDecision({
    id: 1,
    date: '2026-10-22',
    product_name: '顺序测试',
    action: '切换',
    reason: '测试提醒与转出顺序',
    expectation: '转出事实优先于提醒创建',
    invalidation_condition: '本金未恢复',
    actual_result: '',
    strategy_version: 'r2-3pct-v1',
    target_annualized: 3,
    bucket_plan: { short: 30, medium: 35, long: 35, max_single: 30 },
    evaluation_at: ['buy_day', 'holding', 'maturity'],
    evidence_date: '2026-10-22',
    verify_date: '2026-10-23',
    review_meta: {},
    rating: '待评估',
  });

  const query = createDashboardQueryService(repository, {
    todayProvider: () => '2026-10-23',
  });
  query.projectDashboard();
  assert.ok(
    repository.automationStore
      .listNotifications()
      .find((item) => item.id === notification.id).resolved_at,
  );
});
