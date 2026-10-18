'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../lib/db');

const productCsv = path.join(__dirname, '..', 'data', 'cmb_r2_products_2026-10-18.csv');

function makeTempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'r2-capital-test-'));
}

test('legacy daily records are migrated into a capital account', () => {
  const directory = makeTempDirectory();
  const dbPath = path.join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE daily_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_date TEXT NOT NULL UNIQUE,
      principal REAL NOT NULL,
      daily_pnl REAL NOT NULL,
      cash_balance REAL NOT NULL DEFAULT 0,
      action TEXT NOT NULL DEFAULT '无操作',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacy
    .prepare(`
      INSERT INTO daily_records (
        record_date, principal, daily_pnl, cash_balance, action, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run('2026-10-18', 550000, 67, 0, '无操作', '', '2026-10-18T00:00:00Z', '2026-10-18T00:00:00Z');
  legacy
    .prepare(`
      INSERT INTO daily_records (
        record_date, principal, daily_pnl, cash_balance, action, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run('2026-10-20', 560000, 70, 0, '无操作', '', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z');
  legacy.close();

  const repository = openDatabase({
    dbPath,
    productCsvPath: productCsv,
    logger: { warn() {} },
  });
  try {
    const capital = repository.getCapitalState('2026-10-20');
    assert.equal(capital.initialized, true);
    assert.equal(capital.initial_principal, 550000);
    assert.equal(capital.initial_date, '2026-10-18');
    assert.equal(capital.current_principal, 560000);
    assert.equal(capital.events.length, 1);
    assert.equal(capital.events[0].type, 'deposit');
    assert.equal(capital.events[0].amount, 10000);
    assert.equal(repository.getPrincipalForDate('2026-10-18'), 550000);
    assert.equal(repository.getPrincipalForDate('2026-10-20'), 560000);
    assert.equal('cash_balance' in repository.getRecord('2026-10-18'), false);
    const check = new DatabaseSync(dbPath, { readOnly: true });
    const columns = check.prepare('PRAGMA table_info(daily_records)').all();
    check.close();
    assert.equal(columns.some((column) => column.name === 'cash_balance'), false);
  } finally {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('deposits and withdrawals recalculate stored principal snapshots', (t) => {
  const directory = makeTempDirectory();
  const repository = openDatabase({
    dbPath: path.join(directory, 'capital.sqlite'),
    productCsvPath: productCsv,
    logger: { warn() {} },
  });
  t.after(() => {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  repository.initializeCapital(100000, '2026-10-01', '测试');
  repository.createRecord({
    date: '2026-10-18',
    daily_pnl: 50,
    action: '无操作',
    notes: '',
  });
  assert.equal(repository.getRecord('2026-10-18').principal, 100000);

  repository.createCapitalEvent({
    date: '2026-10-18',
    type: 'deposit',
    amount: 20000,
    note: '转入',
  });
  assert.equal(repository.getRecord('2026-10-18').principal, 120000);

  repository.createCapitalEvent({
    date: '2026-10-18',
    type: 'withdraw',
    amount: 5000,
    note: '转出',
  });
  assert.equal(repository.getRecord('2026-10-18').principal, 115000);
  assert.equal(repository.getCapitalState('2026-10-18').current_principal, 115000);

  assert.throws(
    () =>
      repository.createCapitalEvent({
        date: '2026-10-18',
        type: 'withdraw',
        amount: 999999,
        note: '',
      }),
    /可转出本金不足/,
  );
});
