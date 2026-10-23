'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDashboardQueryService,
} = require('../../server/modules/dashboard/service');
const {
  createTestContext,
  requestJson,
  startTestServer,
} = require('../helpers/test-context');

function databaseSnapshot(repository) {
  const tables = repository.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  return Object.fromEntries(
    tables.map((table) => [
      table,
      repository.db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );
}

test('dashboard query facade exposes stable dashboard and workspace snapshots', (t) => {
  const context = createTestContext(t);
  const query = createDashboardQueryService(context.repository, {
    todayProvider: () => '2026-10-22',
  });
  const dashboard = query.getDashboard();
  const workspace = query.getWorkspace();

  assert.equal(dashboard.meta.today, '2026-10-22');
  assert.equal(dashboard.meta.reporting_date, '2026-10-21');
  assert.equal(workspace.timeline.nodes.length >= 4, true);
  assert.equal(Array.isArray(dashboard.products.all), true);
});

test('health, backup, dashboard, product, notifications and static routes are module-owned', async (t) => {
  const context = await startTestServer(t);

  const health = await requestJson(`${context.baseUrl}/api/health`);
  assert.equal(health.response.status, 200);
  assert.equal(health.body.ok, true);

  const backup = await requestJson(`${context.baseUrl}/api/backups`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(backup.response.status, 201);
  assert.equal(backup.body.created, true);
  assert.equal(backup.body.backups.length, 1);

  const dashboard = await requestJson(`${context.baseUrl}/api/dashboard`);
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.body.meta.storage, 'SQLite · 本地');

  const workspace = await requestJson(
    `${context.baseUrl}/api/review/workspace`,
  );
  assert.equal(workspace.response.status, 200);
  assert.equal(workspace.body.workspace.timeline.nodes.length >= 4, true);

  const invalidProductSettings = await requestJson(
    `${context.baseUrl}/api/products/allocation`,
    {
      method: 'PUT',
      body: JSON.stringify({ daily_open_target_pct: 1 }),
    },
  );
  assert.equal(invalidProductSettings.response.status, 400);
  assert.match(invalidProductSettings.body.error, /固定为 0%/);

  const productSettings = await requestJson(
    `${context.baseUrl}/api/products/allocation`,
    {
      method: 'PUT',
      body: JSON.stringify({ daily_open_target_pct: 0 }),
    },
  );
  assert.equal(productSettings.response.status, 200);
  assert.equal(productSettings.body.settings.daily_open_target_pct, 0);
  assert.ok(productSettings.body.dashboard);

  const confirmation = await requestJson(
    `${context.baseUrl}/api/inbox/confirmations`,
    {
      method: 'POST',
      body: JSON.stringify({
        dedupe_key: `stage3:test:${Date.now()}`,
        title: '阶段 3 测试',
        message: '消息中心由 notifications 模块接管',
        category: 'action',
        level: 'warn',
        severity: 'warn',
        action_label: '查看',
        action_url: '/ledger/overview',
        due_at: '2026-10-23',
      }),
    },
  );
  assert.equal(confirmation.response.status, 201);
  assert.equal(confirmation.body.notification.kind, 'agent_confirmation');
  assert.ok(confirmation.body.inbox_center);

  const inbox = await requestJson(`${context.baseUrl}/api/inbox`);
  assert.equal(inbox.response.status, 200);
  assert.ok(inbox.body.inbox_center.items.length > 0);

  const beforeReads = databaseSnapshot(context.repository);
  const readDashboard = await requestJson(`${context.baseUrl}/api/dashboard`);
  const readWorkspace = await requestJson(
    `${context.baseUrl}/api/review/workspace`,
  );
  const readInbox = await requestJson(`${context.baseUrl}/api/inbox`);
  assert.equal(readDashboard.response.status, 200);
  assert.equal(readWorkspace.response.status, 200);
  assert.equal(readInbox.response.status, 200);
  assert.deepEqual(databaseSnapshot(context.repository), beforeReads);
  const refreshed = await requestJson(
    `${context.baseUrl}/api/dashboard/refresh`,
    { method: 'POST', body: '{}' },
  );
  assert.equal(refreshed.response.status, 200);
  assert.equal(refreshed.body.meta.storage, 'SQLite · 本地');

  const notificationsRead = await requestJson(
    `${context.baseUrl}/api/notifications/read-all`,
    { method: 'POST', body: '{}' },
  );
  assert.equal(notificationsRead.response.status, 200);

  const home = await fetch(`${context.baseUrl}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /^text\/html/);

  const favicon = await fetch(`${context.baseUrl}/favicon.ico`);
  assert.equal(favicon.status, 204);

  const unknown = await requestJson(`${context.baseUrl}/api/not-a-route`);
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.error, '接口不存在');
});
