'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  createConsistentSnapshot,
  restoreDatabase,
  validateDatabase,
} = require('../../server/infrastructure/backup/sqlite-backup');
const { createTestContext } = require('../helpers/test-context');

test('restore uses a consistent WAL-aware safety snapshot and preserves current data', (t) => {
  const context = createTestContext(t);
  context.repository.initializeCapital(100000, '2026-09-01', 'backup test');
  context.repository.createRecord({
    date: '2026-09-02',
    daily_pnl: 10,
    action: '无操作',
    notes: 'included in backup',
  });
  const backupPath = path.join(context.directory, 'valid-backup.sqlite');
  createConsistentSnapshot(context.repository.dbPath, backupPath);
  validateDatabase(backupPath);

  context.repository.createRecord({
    date: '2026-09-03',
    daily_pnl: 20,
    action: '无操作',
    notes: 'only in safety snapshot',
  });
  context.repository.close();

  const result = restoreDatabase({
    backupPath,
    dbPath: context.repository.dbPath,
    safetyDir: path.join(context.directory, 'safety'),
  });
  assert.ok(result.safetyPath);
  validateDatabase(result.safetyPath);

  const safety = new DatabaseSync(result.safetyPath, { readOnly: true });
  const restored = new DatabaseSync(context.repository.dbPath, {
    readOnly: true,
  });
  try {
    assert.equal(
      safety
        .prepare(
          "SELECT COUNT(*) AS count FROM daily_records WHERE record_date = '2026-09-03'",
        )
        .get().count,
      1,
    );
    assert.equal(
      restored
        .prepare(
          "SELECT COUNT(*) AS count FROM daily_records WHERE record_date = '2026-09-03'",
        )
        .get().count,
      0,
    );
    assert.equal(
      restored
        .prepare(
          "SELECT COUNT(*) AS count FROM daily_records WHERE record_date = '2026-09-02'",
        )
        .get().count,
      1,
    );
  } finally {
    safety.close();
    restored.close();
  }
});

test('invalid backup is rejected before the current database is replaced', (t) => {
  const context = createTestContext(t);
  context.repository.initializeCapital(100000, '2026-09-01', 'backup test');
  context.repository.createRecord({
    date: '2026-09-04',
    daily_pnl: 5,
    action: '无操作',
    notes: 'current data',
  });
  const invalid = path.join(context.directory, 'invalid.sqlite');
  fs.writeFileSync(invalid, 'not a sqlite database');

  assert.throws(
    () =>
      restoreDatabase({
        backupPath: invalid,
        dbPath: context.repository.dbPath,
        safetyDir: path.join(context.directory, 'safety'),
      }),
    /quick_check|database|SQLite/i,
  );
  assert.equal(
    context.repository.getRecord('2026-09-04').notes,
    'current data',
  );
});
