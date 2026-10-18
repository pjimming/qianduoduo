'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { todayShanghai } = require('./metrics');

const BACKUP_PATTERN = /^r2_ledger-(\d{4}-\d{2}-\d{2})\.sqlite$/;

function defaultBackupDir(dbPath) {
  return path.join(path.dirname(dbPath), 'backups');
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createDailyBackup(db, dbPath, options = {}) {
  const dir = options.dir || defaultBackupDir(dbPath);
  const today = options.today || todayShanghai();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `r2_ledger-${today}.sqlite`);

  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    return { file, date: today, created: false };
  }

  db.exec(`VACUUM INTO ${sqlLiteral(file)}`);
  return { file, date: today, created: true };
}

function listBackups(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => {
      const match = BACKUP_PATTERN.exec(name);
      if (!match) return null;
      const file = path.join(dir, name);
      const stats = fs.statSync(file);
      return {
        date: match[1],
        file: name,
        bytes: stats.size,
        modified_at: stats.mtime.toISOString(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date));
}

function pruneBackups(dir, keepDays = 45) {
  const backups = listBackups(dir);
  if (backups.length <= keepDays) return [];
  const removed = backups.slice(keepDays);
  for (const item of removed) {
    try {
      fs.rmSync(path.join(dir, item.file), { force: true });
    } catch {
      // 清理失败不阻塞启动，下一次启动会继续尝试。
    }
  }
  return removed.map((item) => item.file);
}

module.exports = {
  createDailyBackup,
  defaultBackupDir,
  listBackups,
  pruneBackups,
};
