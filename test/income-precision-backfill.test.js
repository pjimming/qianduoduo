'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

test('backfill refuses a different same-cent raw fact and permits exact replay without writing', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'income-precision-backfill-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'test.sqlite');
  const source = Buffer.from('controlled-source');
  const sha = crypto.createHash('sha256').update(source).digest('hex');
  fs.writeFileSync(path.join(dir, 'source.jpg'), source);
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE product_daily_valuations(id INTEGER PRIMARY KEY,product_code TEXT,yield_date TEXT,daily_pnl REAL,daily_pnl_1e4 INTEGER,daily_pnl_precision INTEGER); CREATE TABLE income_inbox(id INTEGER PRIMARY KEY,sha256 TEXT,stored_name TEXT)');
  db.exec("INSERT INTO product_daily_valuations VALUES(1,'AA0001','2026-11-19',.98,9828,4)");
  db.prepare('INSERT INTO income_inbox VALUES(1,?,?)').run(sha, 'source.jpg'); db.close();
  const manifest = { income_inbox_dir: dir, records: [{ id: 1, product_code: 'AA0001', yield_date: '2026-11-19',
    expected_daily_pnl: .98, expected_daily_pnl_1e4: null, expected_source_precision: null,
    daily_pnl_1e4: 9827, screenshot_id: 1, source_sha256: sha }] };
  const manifestPath = path.join(dir, 'manifest.json'); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const run = () => spawnSync(process.execPath, [path.resolve('scripts/restore-income-precision.mjs'), '--db', dbPath, '--manifest', manifestPath], { encoding: 'utf8' });
  const conflict = run(); assert.notEqual(conflict.status, 0); assert.match(conflict.stderr, /精度变化/);
  const check = new DatabaseSync(dbPath); assert.equal(check.prepare('SELECT daily_pnl_1e4 FROM product_daily_valuations').get().daily_pnl_1e4, 9828);
  check.exec('UPDATE product_daily_valuations SET daily_pnl_1e4=9827'); check.close();
  const before = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
  assert.equal(run().status, 0);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex'), before);
});
