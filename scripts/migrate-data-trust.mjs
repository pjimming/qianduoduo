#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.resolve(
  process.env.R2_DB_PATH || path.join(root, 'data', 'r2_ledger.sqlite'),
);
const tradeInboxDir = path.resolve(
  process.env.R2_TRADE_INBOX_DIR || path.join(path.dirname(dbPath), 'trade-inbox'),
);
const incomeInboxDir = path.resolve(
  process.env.R2_INCOME_INBOX_DIR ||
    path.join(path.dirname(dbPath), 'income-inbox'),
);
const {
  MIGRATION_ID,
  migrationStatus,
  preflightMigration,
  runDataTrustMigration,
  verifyMigration,
} = require('../lib/data-trust-migration');
const {
  createConsistentSnapshot,
  restoreDatabase,
  validateDatabase,
} = require('../server/infrastructure/backup/sqlite-backup');

function shanghaiStamp(date = new Date()) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}${values.month}${values.day}-${values.hour}${values.minute}${values.second}`;
}

async function serverIsRunning() {
  const healthUrl =
    process.env.R2_HEALTH_URL || 'http://127.0.0.1:8765/api/health';
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(800),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function withDatabase(callback, readOnly = false) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`数据库不存在：${dbPath}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly });
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function createPreMigrationBackup() {
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const file = path.join(
    backupDir,
    `pre-data-trust-v1-${shanghaiStamp()}.sqlite`,
  );
  if (fs.existsSync(file)) {
    throw new Error(`迁移备份已存在：${file}`);
  }
  createConsistentSnapshot(dbPath, file);
  validateDatabase(file);
  return file;
}

function latestPreMigrationBackup() {
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  if (!fs.existsSync(backupDir)) return null;
  return (
    fs
      .readdirSync(backupDir)
      .filter((name) =>
        /^pre-data-trust-v1-\d{8}-\d{6}\.sqlite$/.test(name),
      )
      .sort()
      .reverse()
      .map((name) => path.join(backupDir, name))
      .at(0) || null
  );
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

const [command = 'status', ...args] = process.argv.slice(2);
const allowRunning = args.includes('--allow-running');

try {
  if (command === 'status') {
    print(
      withDatabase((db) => ({
        migration_id: MIGRATION_ID,
        status: migrationStatus(db),
      }), true),
    );
  } else if (command === 'preflight') {
    print(
      withDatabase(
        (db) =>
          preflightMigration(db, {
            dbPath,
            tradeInboxDir,
            incomeInboxDir,
          }),
        true,
      ),
    );
  } else if (command === 'verify') {
    const report = withDatabase(
      (db) => verifyMigration(db, { throwOnError: false }),
      true,
    );
    print(report);
    if (!report.ok) process.exitCode = 1;
  } else if (command === 'rollback') {
    if (!allowRunning && (await serverIsRunning())) {
      throw new Error('服务仍在运行；请先执行 npm run prod:stop');
    }
    const backupFlag = args.findIndex((item) => item === '--backup');
    const requested =
      backupFlag >= 0 ? String(args[backupFlag + 1] || '') : '';
    const backupPath = requested
      ? path.resolve(requested)
      : latestPreMigrationBackup();
    if (!backupPath) {
      throw new Error('没有找到 pre-data-trust-v1 迁移前备份');
    }
    const result = restoreDatabase({
      backupPath,
      dbPath,
      safetyDir: path.join(path.dirname(dbPath), 'backups'),
    });
    print({
      restored_from: backupPath,
      pre_restore_safety: result.safetyPath,
      note: '已恢复迁移前数据库；请使用上一版代码或 R2_DATA_TRUST_MODE=off 启动',
    });
  } else if (command === 'apply') {
    if (!allowRunning && (await serverIsRunning())) {
      throw new Error('服务仍在运行；请先执行 npm run prod:stop');
    }
    const backup = createPreMigrationBackup();
    const result = withDatabase((db) =>
      runDataTrustMigration(db, {
        dbPath,
        tradeInboxDir,
        incomeInboxDir,
        apply: true,
      }),
    );
    print({ backup, ...result });
  } else {
    throw new Error(
      '用法：node scripts/migrate-data-trust.mjs <status|preflight|apply|verify|rollback> [--allow-running] [--backup path]',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
