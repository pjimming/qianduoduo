'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DASHBOARD_SECTIONS,
  createDashboardQueryService,
} = require('../server/modules/dashboard/service');
const {
  createTestContext,
  requestJson,
  startTestServer,
} = require('./helpers/test-context');

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

test('dashboard sections compose to the compatible full payload', (t) => {
  const context = createTestContext(t);
  const query = createDashboardQueryService(context.repository, {
    todayProvider: () => '2026-10-22',
  });
  const full = query.getDashboard();
  const combined = query.getSections(DASHBOARD_SECTIONS);

  assert.deepEqual(combined, full);
  assert.deepEqual(
    query.getSection('products').products,
    full.products,
  );
  assert.deepEqual(
    query.getSection('trades').workspace.trades,
    full.workspace.trades,
  );
  assert.deepEqual(
    query.getSection('evaluation').workspace.decisions,
    full.workspace.decisions,
  );
  assert.deepEqual(
    query.getSection('inbox').inbox_center,
    full.inbox_center,
  );

  const fullBytes = Buffer.byteLength(JSON.stringify(full));
  for (const section of DASHBOARD_SECTIONS) {
    const bytes = Buffer.byteLength(
      JSON.stringify(query.getSection(section)),
    );
    assert.ok(
      bytes < fullBytes,
      `${section} section (${bytes}) should be smaller than full dashboard (${fullBytes})`,
    );
  }
});

test('dashboard section routes are read-only and reject invalid names', async (t) => {
  const context = await startTestServer(t);
  const before = databaseSnapshot(context.repository);

  for (const section of DASHBOARD_SECTIONS) {
    const response = await requestJson(
      `${context.baseUrl}/api/dashboard/${section}`,
    );
    assert.equal(response.response.status, 200);
    assert.ok(response.body.meta.today);
  }

  const combined = await requestJson(
    `${context.baseUrl}/api/dashboard/sections?include=summary,ledger`,
  );
  assert.equal(combined.response.status, 200);
  assert.ok(combined.body.meta.storage);
  assert.ok(Array.isArray(combined.body.records));
  assert.ok(combined.body.review);
  assert.equal(combined.body.products, undefined);
  assert.equal(combined.body.automation, undefined);

  const invalid = await requestJson(
    `${context.baseUrl}/api/dashboard/sections?include=summary,unknown`,
  );
  assert.equal(invalid.response.status, 400);
  assert.match(invalid.body.error, /unknown/);

  const empty = await requestJson(
    `${context.baseUrl}/api/dashboard/sections`,
  );
  assert.equal(empty.response.status, 400);
  assert.match(empty.body.error, /至少选择一个/);

  assert.deepEqual(databaseSnapshot(context.repository), before);
});
