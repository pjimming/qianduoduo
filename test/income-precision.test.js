'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { toIncomeUnits, fromIncomeUnits, roundIncomeUnitsToCents,
  effectiveIncomeUnits, sumIncomeUnits } = require('../lib/income-precision');

test('income precision parses four decimals exactly and rounds signed half cents away from zero', () => {
  for (const [input, expected] of [['0.9827', 9827], ['-3.2221', -32221], ['0.0000', 0], [1.23, 12300]]) {
    assert.equal(toIncomeUnits(input), expected);
    assert.equal(fromIncomeUnits(expected), Number(input));
  }
  assert.equal(roundIncomeUnitsToCents(50), 1);
  assert.equal(roundIncomeUnitsToCents(-50), -1);
  assert.equal(roundIncomeUnitsToCents(-49), 0);
  assert.equal(roundIncomeUnitsToCents(-149), -1);
  assert.equal(roundIncomeUnitsToCents(-150), -2);
  for (const input of [null, undefined, '', true, NaN, Infinity, '0.00001', '900719925474.0992']) {
    assert.throws(() => toIncomeUnits(input));
  }
  assert.throws(() => sumIncomeUnits([{ daily_pnl_1e4: Number.MAX_SAFE_INTEGER }, { daily_pnl_1e4: 1 }]));
});

test('income precision sums original units before rounding and retains legacy cent fallback', () => {
  const rows = [{ daily_pnl: 0.54, daily_pnl_1e4: 5370 }, { daily_pnl: 0.54, daily_pnl_1e4: 5370 }];
  assert.equal(roundIncomeUnitsToCents(sumIncomeUnits(rows)), 107);
  assert.equal(effectiveIncomeUnits({ daily_pnl: -1.23 }), -12300);
  assert.equal(sumIncomeUnits([...rows, { daily_pnl: 0.01, daily_pnl_1e4: null }]), 10840);
});

test('precision migration is explicit, idempotent and rolls back interrupted DDL without backfill', async (t) => {
  const { applyPrecisionMigration, precisionMigrationStatus, verifyPrecisionMigration } =
    await import('../scripts/migrate-income-precision.mjs');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE product_daily_valuations(id INTEGER PRIMARY KEY, daily_pnl REAL NOT NULL);
    CREATE TABLE daily_records(id INTEGER PRIMARY KEY, daily_pnl REAL NOT NULL);
    INSERT INTO product_daily_valuations VALUES(1,0.54); INSERT INTO daily_records VALUES(1,0.54)`);
  assert.equal(precisionMigrationStatus(db).enabled, false);
  assert.throws(() => applyPrecisionMigration(db, { afterAlter() { throw Error('interrupt'); } }), /interrupt/);
  assert.equal(precisionMigrationStatus(db).missing.length, 3);
  assert.equal(applyPrecisionMigration(db).changed, true);
  assert.equal(applyPrecisionMigration(db).changed, false);
  assert.equal(db.prepare('SELECT daily_pnl_1e4 FROM product_daily_valuations').get().daily_pnl_1e4, null);
  assert.equal(db.prepare('SELECT daily_pnl FROM daily_records').get().daily_pnl, 0.54);
  assert.equal(verifyPrecisionMigration(db).ok, true);
  db.prepare('UPDATE product_daily_valuations SET daily_pnl_1e4=5370,daily_pnl_precision=4').run();
  assert.equal(verifyPrecisionMigration(db).ok, true);
  db.prepare('UPDATE product_daily_valuations SET daily_pnl_1e4=5300').run();
  assert.equal(verifyPrecisionMigration(db).ok, false);
});

test('precision migration CLI keeps read-only status intact and backs up before a repeatable apply', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-income-precision-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'ledger.sqlite');
  const backup = path.join(directory, 'before.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE product_daily_valuations(id INTEGER PRIMARY KEY,daily_pnl REAL NOT NULL);
    CREATE TABLE daily_records(id INTEGER PRIMARY KEY,daily_pnl REAL NOT NULL);
    INSERT INTO product_daily_valuations VALUES(1,0.54); INSERT INTO daily_records VALUES(1,0.54)`);
  db.close();
  const fingerprint = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  const original = fingerprint(dbPath);
  const run = action => spawnSync(process.execPath,
    ['scripts/migrate-income-precision.mjs', action, '--db', dbPath, '--backup', backup], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  const status = run('status');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).enabled, false);
  assert.equal(fingerprint(dbPath), original);
  assert.equal(fs.existsSync(backup), false);
  const applied = run('apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).changed, true);
  const snapshot = new DatabaseSync(backup, { readOnly: true });
  assert.equal(snapshot.prepare('PRAGMA table_info(product_daily_valuations)').all().some(row => row.name === 'daily_pnl_1e4'), false);
  assert.equal(snapshot.prepare('SELECT daily_pnl FROM product_daily_valuations').get().daily_pnl, 0.54);
  snapshot.close();
  const beforeRepeat = fingerprint(dbPath);
  const repeated = run('apply');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).changed, false);
  assert.equal(fingerprint(dbPath), beforeRepeat);
  const verified = run('verify');
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).ok, true);
  assert.equal(fingerprint(dbPath), beforeRepeat);
});
