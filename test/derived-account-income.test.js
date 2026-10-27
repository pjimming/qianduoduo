'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../lib/db');
const {
  createLedgerRepository,
} = require('../server/modules/ledger/repository');
const {
  createLedgerService,
} = require('../server/modules/ledger/service');

function openTemp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-derived-income-'));
  const dbPath = path.join(directory, 'test.sqlite');
  const repository = openDatabase({
    dbPath,
    productCsvPath: null,
    logger: { warn() {} },
  });
  let closed = false;
  function close() {
    if (closed) return;
    repository.close();
    closed = true;
  }
  t.after(() => {
    close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { repository, dbPath, directory, close };
}

function addProduct(repository, productCode, dailyPnl, extra = {}) {
  return repository.productValuationStore.upsertValuation({
    valuation_date: '2026-10-20',
    credit_date: '2026-10-20',
    yield_date: '2026-10-20',
    product_code: productCode,
    product_name: productCode,
    holding_amount: 1000,
    daily_pnl: dailyPnl,
    ...extra,
  });
}

function fileHash(filePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

function schemaState(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(`
        SELECT type, name, sql
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `)
      .all();
  } finally {
    db.close();
  }
}

function readDailyRecord(dbPath, date) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (
      db
        .prepare(
          `SELECT record_date, daily_pnl, action, notes, source
           FROM daily_records
           WHERE record_date = ?`,
        )
        .get(date) || null
    );
  } finally {
    db.close();
  }
}

test('product writes create and atomically recalculate the derived account record', (t) => {
  const { repository } = openTemp(t);
  repository.initializeCapital(30000, '2026-10-01');

  addProduct(repository, '120056A', 1.23);
  addProduct(repository, '120026A', 0.45);

  let record = repository.getRecord('2026-10-20');
  assert.equal(record.daily_pnl, 1.68);
  assert.equal(record.source, 'product-income-summary');
  assert.equal(record.action, '无操作');

  const saved = repository.productValuationStore.getValuationByKey(
    '120056A',
    '2026-10-20',
  );
  repository.productValuationStore.updateValuationById(saved.id, {
    daily_pnl: 2,
    notes: '产品收益修正',
  });
  record = repository.getRecord('2026-10-20');
  assert.equal(record.daily_pnl, 2.45);
  assert.equal(record.action, '无操作');
});

test('batch product upsert emits one final account revision and retry is idempotent', (t) => {
  const { repository } = openTemp(t);
  repository.initializeCapital(30000, '2026-10-01');
  const entries = [
    {
      valuation_date: '2026-10-20',
      credit_date: '2026-10-20',
      yield_date: '2026-10-20',
      product_code: '120056A',
      product_name: '产品 A',
      holding_amount: 1000,
      daily_pnl: 1.23,
    },
    {
      valuation_date: '2026-10-20',
      credit_date: '2026-10-20',
      yield_date: '2026-10-20',
      product_code: '120026A',
      product_name: '产品 B',
      holding_amount: 1000,
      daily_pnl: 0.45,
    },
  ];
  const options = {
    operationId: 'batch-derived-account',
    requestId: 'batch-derived-account',
  };

  repository.productValuationStore.upsertMany(entries, options);
  const record = repository.getRecord('2026-10-20');
  assert.equal(record.daily_pnl, 1.68);
  let trace = repository.dataTrustStore.traceFact(
    'account_income',
    `account_income:${record.id}`,
  );
  assert.equal(trace.revisions.length, 1);
  assert.equal(trace.revisions[0].action, 'create');
  assert.equal(trace.revisions[0].after.daily_pnl, 1.68);
  assert.equal(trace.revisions[0].operation_id, 'batch-derived-account');

  repository.productValuationStore.upsertMany(entries, options);
  trace = repository.dataTrustStore.traceFact(
    'account_income',
    `account_income:${record.id}`,
  );
  assert.equal(trace.revisions.length, 1);
  assert.equal(repository.getRecord('2026-10-20').daily_pnl, 1.68);
});

test('yield-date correction recalculates both dates and audits old derived deletion', (t) => {
  const { repository } = openTemp(t);
  repository.initializeCapital(30000, '2026-10-01');
  const saved = addProduct(repository, '120056A', 1.23);
  const oldRecord = repository.getRecord('2026-10-20');

  repository.productValuationStore.updateValuationById(
    saved.valuation.id,
    {
      yield_date: '2026-10-21',
      credit_date: '2026-10-21',
    },
    {
      operationId: 'move-product-income-date',
      requestId: 'move-product-income-date',
      auditNote: '收益归属日修正',
    },
  );

  assert.equal(repository.getRecord('2026-10-20'), null);
  const newRecord = repository.getRecord('2026-10-21');
  assert.equal(newRecord.daily_pnl, 1.23);

  const oldTrace = repository.dataTrustStore.traceFact(
    'account_income',
    `account_income:${oldRecord.id}`,
  );
  assert.deepEqual(
    oldTrace.revisions.map((item) => item.action),
    ['delete', 'create'],
  );
  assert.equal(oldTrace.revisions[0].before.daily_pnl, 1.23);
  assert.deepEqual(oldTrace.revisions[0].after, {});
  assert.match(oldTrace.revisions[0].reason, /旧日期已无产品/);
  assert.equal(
    oldTrace.revisions[0].operation_id,
    'move-product-income-date:delete',
  );

  const newTrace = repository.dataTrustStore.traceFact(
    'account_income',
    `account_income:${newRecord.id}`,
  );
  assert.equal(newTrace.revisions.length, 1);
  assert.equal(newTrace.revisions[0].action, 'create');
  assert.equal(newTrace.revisions[0].after.daily_pnl, 1.23);
});

test('account projection failure rolls back the product fact', (t) => {
  const { repository } = openTemp(t);
  repository.initializeCapital(30000, '2026-10-01');
  repository.db.exec(`
    CREATE TRIGGER fail_derived_account_insert
    BEFORE INSERT ON daily_records
    BEGIN
      SELECT RAISE(ABORT, 'derived account projection failed');
    END;
  `);

  assert.throws(
    () => addProduct(repository, '120056A', 1.23),
    /derived account projection failed/,
  );
  assert.equal(
    repository.productValuationStore.getValuationByKey(
      '120056A',
      '2026-10-20',
    ),
    null,
  );
  assert.equal(repository.getRecord('2026-10-20'), null);
});

test('product income waits for capital initialization without a false mismatch', (t) => {
  const { repository } = openTemp(t);

  addProduct(repository, '120056A', 1.23);

  assert.equal(
    repository.productValuationStore.getValuationByKey(
      '120056A',
      '2026-10-20',
    ).daily_pnl,
    1.23,
  );
  assert.equal(repository.getRecord('2026-10-20'), null);
  let reconciliation =
    repository.productValuationStore.getReconciliationForDate('2026-10-20', {
      today: '2026-10-27',
    });
  assert.equal(reconciliation.status, 'waiting');
  assert.equal(reconciliation.account_projection_status, 'pending');
  assert.equal(
    reconciliation.account_projection_reason,
    'capital-uninitialized',
  );
  assert.equal(reconciliation.account_pnl, null);
  assert.equal(reconciliation.difference, null);

  repository.initializeCapital(30000, '2026-10-01');
  const record = repository.getRecord('2026-10-20');
  assert.equal(record.daily_pnl, 1.23);
  reconciliation =
    repository.productValuationStore.getReconciliationForDate('2026-10-20', {
      today: '2026-10-27',
    });
  assert.equal(reconciliation.status, 'matched');
  assert.equal(reconciliation.account_projection_status, 'ready');
  assert.equal(reconciliation.account_projection_reason, null);
});

test('product income before the capital start date waits without a false mismatch', (t) => {
  const { repository } = openTemp(t);
  repository.initializeCapital(30000, '2026-10-21');

  addProduct(repository, '120056A', 1.23);

  assert.equal(repository.getRecord('2026-10-20'), null);
  const reconciliation =
    repository.productValuationStore.getReconciliationForDate('2026-10-20', {
      today: '2026-10-27',
    });
  assert.equal(reconciliation.status, 'waiting');
  assert.equal(reconciliation.account_projection_status, 'pending');
  assert.equal(
    reconciliation.account_projection_reason,
    'before-capital-start',
  );
  assert.equal(reconciliation.difference, null);
});

test('zero principal defers account projection without a false mismatch', (t) => {
  const { repository } = openTemp(t);
  repository.initializeCapital(100, '2026-10-01');
  repository.createCapitalEvent({
    date: '2026-10-01',
    type: 'withdraw',
    amount: 100,
    note: '本金清零',
  });

  addProduct(repository, '120056A', 1.23);

  assert.equal(repository.getRecord('2026-10-20'), null);
  const reconciliation =
    repository.productValuationStore.getReconciliationForDate('2026-10-20', {
      today: '2026-10-27',
    });
  assert.equal(reconciliation.status, 'waiting');
  assert.equal(reconciliation.account_projection_status, 'pending');
  assert.equal(reconciliation.account_projection_reason, 'principal-zero');
  assert.equal(reconciliation.difference, null);
});

test('unexpected principal read errors roll back the product fact', (t) => {
  const { repository } = openTemp(t);
  repository.initializeCapital(30000, '2026-10-01');
  repository.db.exec('DROP TABLE capital_events');

  assert.throws(
    () => addProduct(repository, '120056A', 1.23),
    /no such table: capital_events/i,
  );
  assert.equal(
    repository.productValuationStore.getValuationByKey(
      '120056A',
      '2026-10-20',
    ),
    null,
  );
  assert.equal(repository.getRecord('2026-10-20'), null);
});

test('manual account API ignores client totals and keeps action/notes editable', (t) => {
  const { repository } = openTemp(t);
  repository.initializeCapital(30000, '2026-10-01');
  addProduct(repository, '120056A', 1.23);
  const ledgerRepository = createLedgerRepository(repository);
  const dashboardQuery = { projectDashboard: () => ({ ok: true }) };
  const service = createLedgerService({ ledgerRepository, dashboardQuery });

  const updated = service.updateRecord('2026-10-20', {
    daily_pnl: 99,
    action: '买入',
    notes: '调整操作说明',
  });
  assert.equal(updated.record.daily_pnl, 1.23);
  assert.equal(updated.record.action, '买入');
  assert.equal(updated.record.notes, '调整操作说明');

  assert.throws(
    () => service.deleteRecord('2026-10-20'),
    /由产品收益汇总生成/,
  );
  assert.throws(
    () =>
      service.createRecord({
        date: '2026-10-21',
        daily_pnl: 1,
        action: '无操作',
        notes: '',
      }),
    /请先录入至少一条产品当日收益/,
  );
});

test('migration preflight and verify are strictly read-only', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'r2-derived-preflight-'),
  );
  const dbPath = path.join(directory, 'test.sqlite');
  const setup = new DatabaseSync(dbPath);
  setup.exec(`
    CREATE TABLE product_daily_valuations (
      id INTEGER PRIMARY KEY,
      yield_date TEXT NOT NULL,
      daily_pnl REAL NOT NULL
    );
    CREATE TABLE daily_records (
      record_date TEXT PRIMARY KEY,
      daily_pnl REAL NOT NULL,
      source TEXT NOT NULL
    );
    INSERT INTO product_daily_valuations (yield_date, daily_pnl)
    VALUES ('2026-10-20', 1.23);
    INSERT INTO daily_records (record_date, daily_pnl, source)
    VALUES ('2026-10-20', 1.23, 'manual');
  `);
  setup.close();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const beforeHash = fileHash(dbPath);
  const beforeSchema = schemaState(dbPath);
  const beforeFiles = fs.readdirSync(directory).sort();
  const { runDerivedAccountIncomeMigration } = await import(
    '../scripts/migrate-derived-account-income.mjs'
  );

  const preflight = await runDerivedAccountIncomeMigration({
    action: 'preflight',
    dbPath,
  });
  assert.equal(preflight.read_only, true);
  assert.equal(preflight.changes[0].difference, 0);
  assert.equal(preflight.changes[0].current_source, 'manual');
  assert.equal(preflight.changes[0].needs_source_normalization, true);
  assert.equal(preflight.changes[0].action, 'update');
  assert.equal(preflight.summary.projected_changes, 1);
  assert.equal(preflight.summary.source_normalizations, 1);
  assert.equal(fileHash(dbPath), beforeHash);
  assert.deepEqual(schemaState(dbPath), beforeSchema);
  assert.deepEqual(fs.readdirSync(directory).sort(), beforeFiles);

  const verified = await runDerivedAccountIncomeMigration({
    action: 'verify',
    dbPath,
  });
  assert.equal(verified.read_only, true);
  assert.equal(verified.ok, false);
  assert.equal(fileHash(dbPath), beforeHash);
  assert.deepEqual(schemaState(dbPath), beforeSchema);
  assert.deepEqual(fs.readdirSync(directory).sort(), beforeFiles);
});

test('migration backs up source mismatches before opening the application database', async (t) => {
  const { repository, dbPath, close } = openTemp(t);
  repository.initializeCapital(30000, '2026-10-01');
  addProduct(repository, '120056A', 1.23);
  repository.db
    .prepare(
      `UPDATE daily_records
       SET source = 'manual'
       WHERE record_date = '2026-10-20'`,
    )
    .run();
  close();

  const { runDerivedAccountIncomeMigration } = await import(
    '../scripts/migrate-derived-account-income.mjs'
  );
  let backupPath = null;
  const applied = await runDerivedAccountIncomeMigration({
    action: 'apply',
    dbPath,
    openDatabaseFn(options) {
      const backups = fs
        .readdirSync(path.join(path.dirname(dbPath), 'backups'))
        .filter((name) => name.startsWith('pre-derived-account-income-'));
      assert.equal(backups.length, 1);
      backupPath = path.join(
        path.dirname(dbPath),
        'backups',
        backups[0],
      );
      assert.equal(readDailyRecord(backupPath, '2026-10-20').source, 'manual');
      return openDatabase(options);
    },
  });

  assert.equal(applied.backup_validated, true);
  assert.equal(applied.backup, backupPath);
  assert.equal(readDailyRecord(dbPath, '2026-10-20').source, 'product-income-summary');
  assert.equal(readDailyRecord(dbPath, '2026-10-20').daily_pnl, 1.23);
  const verified = await runDerivedAccountIncomeMigration({
    action: 'verify',
    dbPath,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.summary.source_normalizations, 0);
});

test('failed apply restores the pre-migration database and keeps the backup', async (t) => {
  const { repository, dbPath, close, directory } = openTemp(t);
  repository.initializeCapital(30000, '2026-10-01');
  addProduct(repository, '120056A', 1.23);
  close();
  const beforeRecord = readDailyRecord(dbPath, '2026-10-20');
  const beforeSchema = schemaState(dbPath);
  const { runDerivedAccountIncomeMigration } = await import(
    '../scripts/migrate-derived-account-income.mjs'
  );

  await assert.rejects(
    () =>
      runDerivedAccountIncomeMigration({
        action: 'apply',
        dbPath,
        openDatabaseFn() {
          throw new Error('simulated application open failure');
        },
      }),
    /迁移失败，已从备份恢复原状态/,
  );

  assert.deepEqual(readDailyRecord(dbPath, '2026-10-20'), beforeRecord);
  assert.deepEqual(schemaState(dbPath), beforeSchema);
  const backups = fs
    .readdirSync(path.join(directory, 'backups'))
    .filter((name) => name.startsWith('pre-derived-account-income-'));
  assert.equal(backups.length, 1);
});

test('derived income migration preflights, backs up, repairs and stays idempotent', async (t) => {
  const { repository, dbPath, close } = openTemp(t);
  repository.initializeCapital(30000, '2026-10-01');
  addProduct(repository, '120056A', 1.23);
  repository.db
    .prepare('UPDATE daily_records SET daily_pnl = 9 WHERE record_date = ?')
    .run('2026-10-20');
  repository.db
    .prepare(`
      INSERT INTO daily_records (
        record_date, principal, daily_pnl, action, notes, source,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      '2026-10-21',
      30000,
      0.5,
      '无操作',
      '历史手工记录',
      'manual',
      new Date().toISOString(),
      new Date().toISOString(),
    );
  close();

  const { runDerivedAccountIncomeMigration } = await import(
    '../scripts/migrate-derived-account-income.mjs'
  );
  const preflight = await runDerivedAccountIncomeMigration({
    action: 'preflight',
    dbPath,
  });
  assert.equal(preflight.changes.length, 1);
  assert.equal(preflight.changes[0].difference, -7.77);
  assert.equal(preflight.legacy.length, 1);

  const applied = await runDerivedAccountIncomeMigration({
    action: 'apply',
    dbPath,
  });
  assert.equal(applied.ok, true);
  assert.equal(fs.existsSync(applied.backup), true);
  assert.equal(readDailyRecord(dbPath, '2026-10-20').daily_pnl, 1.23);
  assert.equal(readDailyRecord(dbPath, '2026-10-21').daily_pnl, 0.5);

  const verified = await runDerivedAccountIncomeMigration({
    action: 'verify',
    dbPath,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.summary.projected_changes, 0);

  const repeated = await runDerivedAccountIncomeMigration({
    action: 'apply',
    dbPath,
  });
  assert.equal(
    repeated.after.summary.projected_changes,
    0,
  );
  assert.equal(repeated.after.legacy.length, 1);
});
