'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../../lib/db');
const { createDailyBackup } = require('../../lib/backup');
const { productCsv } = require('../fixtures');
const { createTestContext } = require('../helpers/test-context');

test('legacy daily_records migrate without losing income data', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-migration-test-'));
  const dbPath = path.join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE daily_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_date TEXT NOT NULL UNIQUE,
      principal REAL NOT NULL CHECK (principal > 0),
      daily_pnl REAL NOT NULL,
      action TEXT NOT NULL DEFAULT '无操作',
      notes TEXT NOT NULL DEFAULT '',
      cash_balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO daily_records (
      record_date, principal, daily_pnl, action, notes, cash_balance,
      created_at, updated_at
    ) VALUES (
      '2026-09-01', 100000, 12.34, '无操作', 'legacy row', 500,
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
    );
  `);
  legacy.close();

  const repository = openDatabase({
    dbPath,
    productCsvPath: productCsv,
    tradeInboxDir: path.join(directory, 'trade-inbox'),
    incomeInboxDir: path.join(directory, 'income-inbox'),
    logger: { warn() {}, info() {} },
  });
  t.after(() => {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const columns = repository.db
    .prepare('PRAGMA table_info(daily_records)')
    .all()
    .map((column) => column.name);
  assert.equal(columns.includes('cash_balance'), false);
  assert.equal(columns.includes('source'), true);
  assert.equal(columns.includes('screenshot_id'), true);
  assert.equal(repository.getRecord('2026-09-01').daily_pnl, 12.34);
  assert.equal(repository.getRecord('2026-09-01').source, 'manual');
  assert.equal(repository.getCapitalState('2026-09-01').initial_principal, 100000);
});

test('daily backup contains committed WAL-mode data', (t) => {
  const context = createTestContext(t);
  context.repository.initializeCapital(100000, '2026-09-01', 'test');
  context.repository.createRecord({
    date: '2026-10-12',
    daily_pnl: 42.5,
    action: '无操作',
    notes: 'wal-backed row',
  });

  const backup = createDailyBackup(
    context.repository.db,
    context.repository.dbPath,
    {
      dir: path.join(context.directory, 'backup-check'),
      today: '2026-10-22',
    },
  );
  assert.equal(backup.created, true);

  const snapshot = new DatabaseSync(backup.file, { readOnly: true });
  try {
    const row = snapshot
      .prepare(
        'SELECT daily_pnl, notes FROM daily_records WHERE record_date = ?',
      )
      .get('2026-10-12');
    assert.equal(row.daily_pnl, 42.5);
    assert.equal(row.notes, 'wal-backed row');
  } finally {
    snapshot.close();
  }
});
