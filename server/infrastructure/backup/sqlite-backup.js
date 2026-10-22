'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const REQUIRED_TABLES = [
  'daily_records',
  'capital_settings',
  'trade_transactions',
  'decision_log',
  'evaluation_runs',
];

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createConsistentSnapshot(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`数据库不存在：${sourcePath}`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.${process.pid}.tmp`;
  fs.rmSync(temporary, { force: true });
  const db = new DatabaseSync(sourcePath);
  try {
    db.exec(`VACUUM INTO ${sqlLiteral(temporary)}`);
  } finally {
    db.close();
  }
  fs.renameSync(temporary, targetPath);
  return targetPath;
}

function validateDatabase(filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    throw new Error(`备份文件不存在或为空：${filePath}`);
  }
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const check = db.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || check[0].quick_check !== 'ok') {
      throw new Error(`SQLite quick_check 失败：${filePath}`);
    }
    const tables = new Set(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
        .all()
        .map((row) => row.name),
    );
    const missing = REQUIRED_TABLES.filter((name) => !tables.has(name));
    if (missing.length) {
      throw new Error(`备份缺少关键表：${missing.join(', ')}`);
    }
  } finally {
    db.close();
  }
  return true;
}

function restoreDatabase({
  backupPath,
  dbPath,
  safetyDir,
  now = new Date(),
}) {
  validateDatabase(backupPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(safetyDir, { recursive: true });
  let safetyPath = null;
  if (fs.existsSync(dbPath)) {
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    safetyPath = path.join(safetyDir, `pre-restore-${stamp}.sqlite`);
    createConsistentSnapshot(dbPath, safetyPath);
    validateDatabase(safetyPath);
  }
  const stagedPath = path.join(
    path.dirname(dbPath),
    `.restore-${process.pid}-${Date.now()}.sqlite`,
  );
  try {
    fs.copyFileSync(backupPath, stagedPath);
    validateDatabase(stagedPath);
    fs.copyFileSync(stagedPath, dbPath);
    for (const suffix of ['-wal', '-shm']) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  } finally {
    fs.rmSync(stagedPath, { force: true });
  }
  return { safetyPath };
}

module.exports = {
  REQUIRED_TABLES,
  createConsistentSnapshot,
  restoreDatabase,
  validateDatabase,
};
