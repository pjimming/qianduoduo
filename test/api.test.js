'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { createServer } = require('../server');
const { shiftDate, todayShanghai } = require('../lib/metrics');

const { productCsv } = require('./fixtures');

async function startTestServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-api-test-'));
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

test('API supports dashboard, create, duplicate guard, update, export and delete', async (t) => {
  const base = await startTestServer(t);

  const dashboard = await fetch(`${base}/api/dashboard`).then((response) => response.json());
  assert.equal(dashboard.records.length, 0);
  assert.equal(dashboard.products.watchlist.length, 0);
  assert.equal(dashboard.products.allocation.status, 'no_principal');
  assert.ok(dashboard.products.observation_list.length > 0);
  const productCount = dashboard.products.all.length;
  assert.ok(productCount > 0);
  assert.equal(dashboard.meta.target_annualized, 3);
  assert.equal(dashboard.meta.reporting_date, shiftDate(todayShanghai(), -1));

  const refreshResponse = await fetch(`${base}/api/products/refresh`, { method: 'POST' });
  assert.equal(refreshResponse.status, 200);
  const refreshed = await refreshResponse.json();
  assert.equal(refreshed.refreshed, productCount);
  assert.equal(refreshed.dashboard.products.all.length, productCount);
  assert.equal(refreshed.dashboard.products.watchlist.length, 0);

  const capitalInitResponse = await fetch(`${base}/api/capital/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      initial_principal: 540000,
      initial_date: '2026-09-01',
    }),
  });
  assert.equal(capitalInitResponse.status, 201);
  const capitalInitialized = await capitalInitResponse.json();
  assert.equal(capitalInitialized.dashboard.products.allocation.principal, 540000);
  assert.ok(capitalInitialized.dashboard.products.watchlist.length > 0);
  assert.ok(
    capitalInitialized.dashboard.products.allocation.allocated_amount <=
      capitalInitialized.dashboard.products.allocation.available_cash + 0.01,
  );
  assert.ok(
    capitalInitialized.dashboard.products.watchlist.every((item) =>
      item.allocation_mode === 'top_up'
        ? item.target_amount >= item.minimum_order_amount
        : item.target_amount >= item.meaningful_min_amount,
    ),
  );
  assert.equal(
    capitalInitialized.dashboard.products.allocation.top_up_amount +
      capitalInitialized.dashboard.products.allocation.new_position_amount,
    capitalInitialized.dashboard.products.allocation.allocated_amount,
  );

  const allocationCode = capitalInitialized.dashboard.products.watchlist[0].code;
  const allocationResponse = await fetch(`${base}/api/products/allocation`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      max_single_pct: 25,
      max_issuer_pct: 40,
      bucket_targets: { short: 30, medium: 35, long: 35 },
      quota_by_code: {
        [allocationCode]: { available: 40000, max_order: 30000 },
      },
    }),
  });
  assert.equal(allocationResponse.status, 200);
  const allocationResult = await allocationResponse.json();
  assert.equal(allocationResult.settings.max_single_pct, 25);
  const quotaProduct = allocationResult.dashboard.products.watchlist.find(
    (item) => item.code === allocationCode,
  );
  assert.ok(quotaProduct);
  assert.ok(quotaProduct.target_amount <= 30000.01);
  assert.ok(quotaProduct.target_amount >= quotaProduct.meaningful_min_amount);
  assert.equal(quotaProduct.quota_status, 'verified');

  const invalidAllocation = await fetch(`${base}/api/products/allocation`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_single_pct: 50 }),
  });
  assert.equal(invalidAllocation.status, 400);

  const invalidDailyOpen = await fetch(`${base}/api/products/allocation`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ daily_open_target_pct: 5 }),
  });
  assert.equal(invalidDailyOpen.status, 400);

  const depositResponse = await fetch(`${base}/api/capital/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_date: '2026-10-18',
      event_type: 'deposit',
      amount: 10000,
      note: '测试转入',
    }),
  });
  assert.equal(depositResponse.status, 201);

  const createResponse = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: '2026-10-18',
      daily_pnl: 54,
      action: '无操作',
      notes: '接口测试',
    }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.dashboard.records.length, 1);
  assert.equal(created.dashboard.summary.total_pnl, 54);
  assert.equal(created.record.principal, 550000);
  assert.equal(created.dashboard.capital.current_principal, 550000);
  assert.equal(created.dashboard.review.current_month.month, '2026-10');
  assert.equal(created.dashboard.review.daily.month_pnl, 54);

  const withdrawResponse = await fetch(`${base}/api/capital/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_date: '2026-10-18',
      event_type: 'withdraw',
      amount: 5000,
      note: '测试转出',
    }),
  });
  assert.equal(withdrawResponse.status, 201);
  const withdrawn = await withdrawResponse.json();
  assert.equal(withdrawn.dashboard.records[0].principal, 545000);
  assert.equal(withdrawn.dashboard.capital.current_principal, 545000);

  const refreshAfterRecord = await fetch(`${base}/api/products/refresh`, { method: 'POST' });
  assert.equal(refreshAfterRecord.status, 200);
  const refreshedAfterRecord = await refreshAfterRecord.json();
  assert.equal(refreshedAfterRecord.dashboard.records.length, 1);
  assert.equal(refreshedAfterRecord.dashboard.records[0].daily_pnl, 54);

  const duplicateResponse = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: '2026-10-18',
      daily_pnl: 50,
    }),
  });
  assert.equal(duplicateResponse.status, 200);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.record.daily_pnl, 54);
  assert.equal(duplicate.conflict.existing_daily_pnl, 54);
  assert.equal(duplicate.conflict.incoming_daily_pnl, 50);
  assert.equal(duplicate.dashboard.records.length, 1);
  assert.ok(
    duplicate.dashboard.inbox_center.pending.some(
      (item) =>
        item.source_type === 'system_notification' &&
        item.title.includes('收益金额不一致'),
    ),
  );

  const updateResponse = await fetch(`${base}/api/records/2026-10-18`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: '2026-10-18',
      daily_pnl: 60,
      action: '买入',
      notes: '更新',
    }),
  });
  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json();
  assert.equal(updated.record.daily_pnl, 60);

  const csvResponse = await fetch(`${base}/api/export.csv`);
  const csv = await csvResponse.text();
  assert.match(csv, /date,principal,daily_pnl,action,notes/);
  assert.match(csv, /2026-10-18,545000,60,买入,更新/);

  const deleteResponse = await fetch(`${base}/api/records/2026-10-18`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 200);
  const deleted = await deleteResponse.json();
  assert.equal(deleted.dashboard.records.length, 0);
});

test('API rejects future dates and records before capital initialization', async (t) => {
  const base = await startTestServer(t);
  const future = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: '2999-01-01',
      daily_pnl: 10,
    }),
  });
  assert.equal(future.status, 400);

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(new Date())
    .reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  const todayText = `${today.year}-${today.month}-${today.day}`;
  const uninitialized = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: todayText,
      daily_pnl: 1,
    }),
  });
  assert.equal(uninitialized.status, 400);
  const uninitializedBody = await uninitialized.json();
  assert.match(uninitializedBody.error, /本金账户/);
});

test('API accepts user-provided dates through today and validates duplicates idempotently', async (t) => {
  const base = await startTestServer(t);
  const today = todayShanghai();
  const reportingDate = shiftDate(today, -1);
  const initResponse = await fetch(`${base}/api/capital/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      initial_principal: 10000,
      initial_date: '2026-09-01',
    }),
  });
  assert.equal(initResponse.status, 201);

  const currentDay = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: today, daily_pnl: 1 }),
  });
  assert.equal(currentDay.status, 201);
  const currentPayload = await currentDay.json();
  assert.equal(currentPayload.record.daily_pnl, 1);

  const sameCurrentDay = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: today, daily_pnl: 1 }),
  });
  assert.equal(sameCurrentDay.status, 200);
  const sameCurrentPayload = await sameCurrentDay.json();
  assert.equal(sameCurrentPayload.duplicate, true);
  assert.equal(sameCurrentPayload.changed, false);
  assert.equal(sameCurrentPayload.conflict, null);
  assert.equal(sameCurrentPayload.dashboard.records.length, 1);

  const previousDay = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: reportingDate, daily_pnl: 1 }),
  });
  assert.equal(previousDay.status, 201);
  assert.equal(
    (await previousDay.json()).dashboard.meta.has_reporting_record,
    true,
  );
});
