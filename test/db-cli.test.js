'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { openDatabase } = require('../lib/db');

const { productCsv } = require('./fixtures');
const cliPath = path.join(__dirname, '..', 'scripts', 'db.mjs');

test('db CLI creates a backup and restores it with a safety snapshot', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-db-cli-'));
  const dbPath = path.join(directory, 'test.sqlite');
  const repository = openDatabase({
    dbPath,
    productCsvPath: productCsv,
    logger: { warn() {} },
  });
  repository.initializeCapital(10000, '2026-09-01');
  repository.createRecord({
    date: '2026-10-18',
    daily_pnl: 5,
    action: '无操作',
    notes: '备份测试',
  });
  repository.close();

  const env = {
    ...process.env,
    R2_DB_PATH: dbPath,
    R2_HEALTH_URL: 'http://127.0.0.1:9/api/health',
  };
  const run = (...args) =>
    spawnSync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8' });

  const backup = run('backup');
  assert.equal(backup.status, 0, backup.stderr);
  const backupDir = path.join(directory, 'backups');
  const files = fs
    .readdirSync(backupDir)
    .filter((name) => /^r2_ledger-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name));
  assert.equal(files.length, 1);

  const list = run('list');
  assert.match(list.stdout, /r2_ledger-\d{4}-\d{2}-\d{2}\.sqlite/);

  const mutated = openDatabase({
    dbPath,
    productCsvPath: productCsv,
    logger: { warn() {} },
  });
  mutated.db.exec('DELETE FROM daily_records');
  mutated.close();

  const date = files[0].replace('r2_ledger-', '').replace('.sqlite', '');
  const restore = run('restore', date);
  assert.equal(restore.status, 0, restore.stderr);
  assert.match(restore.stdout, /已恢复/);
  assert.ok(
    fs.readdirSync(backupDir).some((name) => name.startsWith('pre-restore-')),
    '恢复前应保留安全快照',
  );

  const restored = openDatabase({
    dbPath,
    productCsvPath: productCsv,
    logger: { warn() {} },
  });
  assert.equal(restored.listRecords().length, 1);
  assert.equal(restored.listRecords()[0].daily_pnl, 5);
  restored.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
