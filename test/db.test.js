'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');

const { productCsv } = require('./fixtures');

test('SQLite repository creates, updates and deletes daily records', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-ledger-test-'));
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: productCsv,
    logger: { warn() {} },
  });
  t.after(() => {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(repository.listRecords().length, 0);
  const productCount = repository.listProducts().length;
  assert.ok(productCount > 0);
  assert.equal(repository.refreshProducts(), productCount);
  assert.equal(repository.listProducts().length, productCount);
  repository.initializeCapital(540000, '2026-09-01', '测试初始化');
  repository.createCapitalEvent({
    date: '2026-10-18',
    type: 'deposit',
    amount: 10000,
    note: '测试转入',
  });

  repository.createRecord({
    date: '2026-10-18',
    daily_pnl: 54,
    action: '无操作',
    notes: '测试',
  });
  assert.equal(repository.getRecord('2026-10-18').daily_pnl, 54);
  assert.equal(repository.getRecord('2026-10-18').principal, 550000);
  assert.equal(repository.getCapitalState('2026-10-18').current_principal, 550000);

  repository.updateRecord('2026-10-18', {
    daily_pnl: 60,
    action: '无操作',
    notes: '已更新',
  });
  assert.equal(repository.getRecord('2026-10-18').daily_pnl, 60);
  assert.equal(repository.getRecord('2026-10-18').notes, '已更新');

  assert.equal(repository.deleteRecord('2026-10-18'), true);
  assert.equal(repository.getRecord('2026-10-18'), null);
});
