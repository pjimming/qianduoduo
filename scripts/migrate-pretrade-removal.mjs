#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const META_KEY = 'pretrade_removal_v1';
const ARRIVAL_COLUMNS = ['arrival_date', 'arrival_verified_at'];

const quote = name => '"' + String(name).replaceAll('"', '""') + '"';
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`));
const tableExists = (db, name) => Boolean(db.prepare(
  "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name));
const tableColumns = (db, name) => new Set(db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(row => row.name));
const readTable = (db, name) => {
  if (!tableExists(db, name)) return { columns: [], rows: [] };
  const columns = [...tableColumns(db, name)];
  return { columns, rows: db.prepare(`SELECT * FROM ${quote(name)}`).all() };
};

function settlementFacts(rows) {
  const latest = new Map();
  for (const row of rows) {
    let facts;
    try { facts = JSON.parse(row.facts_json); } catch { continue; }
    if (facts?.kind !== 'trade_settlement' || facts.status !== 'verified') continue;
    const tradeId = Number(facts.trade_id);
    if (!Number.isSafeInteger(tradeId) || tradeId <= 0 || !isoDate(facts.arrival_date)) continue;
    const version = Number(row.version) || 0;
    const previous = latest.get(tradeId);
    if (!previous || version > previous.version) {
      latest.set(tradeId, { trade_id: tradeId, arrival_date: facts.arrival_date, version });
    }
  }
  return [...latest.values()].sort((a, b) => a.trade_id - b.trade_id);
}

function report(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const columns = tableColumns(db, 'trade_transactions');
    const metaRow = tableExists(db, 'app_meta')
      ? db.prepare('SELECT value FROM app_meta WHERE key = ?').get(META_KEY) : null;
    let meta = null;
    if (metaRow) { try { meta = JSON.parse(metaRow.value); } catch { meta = { malformed: true }; } }
    const checks = readTable(db, 'r2_pretrade_checks');
    return {
      database: dbPath,
      tables: { r2_share_mappings: tableExists(db, 'r2_share_mappings'), r2_pretrade_checks: tableExists(db, 'r2_pretrade_checks') },
      trade_columns: Object.fromEntries(ARRIVAL_COLUMNS.map(name => [name, columns.has(name)])),
      applied: Boolean(metaRow),
      meta,
      historical_settlements: settlementFacts(checks.rows).length,
      mapping_rows: readTable(db, 'r2_share_mappings').rows.length,
    };
  } finally { db.close(); }
}

function verify({ dbPath }) {
  const status = report(dbPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const arrivalRows = db.prepare("SELECT COUNT(*) AS n FROM trade_transactions WHERE trade_type = 'redeem' " +
      "AND status = 'confirmed' AND arrival_date IS NOT NULL AND arrival_verified_at IS NOT NULL").get().n;
    let historyMatched = null;
    const meta = status.meta;
    if (meta?.backup_file && fs.existsSync(meta.backup_file)) {
      const backup = JSON.parse(fs.readFileSync(meta.backup_file, 'utf8'));
      const expected = settlementFacts(backup.tables?.r2_pretrade_checks?.rows ?? []);
      historyMatched = expected.filter(fact => {
        const trade = db.prepare('SELECT arrival_date FROM trade_transactions WHERE id = ?').get(fact.trade_id);
        return trade?.arrival_date === fact.arrival_date;
      }).length;
      status.historical_settlements = expected.length;
    }
    const ok = !status.tables.r2_share_mappings && !status.tables.r2_pretrade_checks &&
      ARRIVAL_COLUMNS.every(name => status.trade_columns[name]) && status.applied &&
      Number.isInteger(meta?.historical_settlements) && meta.backfilled === meta.historical_settlements &&
      (historyMatched === null || historyMatched === meta.historical_settlements) &&
      arrivalRows >= (meta?.backfilled ?? 0);
    return { ...status, arrival_rows: arrivalRows, history_matched: historyMatched, ok };
  } finally { db.close(); }
}

function apply({ dbPath, backupDir, now = new Date() }) {
  if (!fs.existsSync(dbPath)) throw new Error('账本数据库不存在');
  const resolvedBackupDir = path.resolve(backupDir ?? path.join(root, 'data/backup'));
  fs.mkdirSync(resolvedBackupDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 2000; BEGIN IMMEDIATE');
    try {
      const before = report(dbPath);
      if (before.applied && !before.tables.r2_share_mappings && !before.tables.r2_pretrade_checks) {
        db.exec('ROLLBACK');
        return { changed: false, ...before };
      }
      const mappings = readTable(db, 'r2_share_mappings');
      const checks = readTable(db, 'r2_pretrade_checks');
      const historical = settlementFacts(checks.rows);
      const timestamp = now.toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(resolvedBackupDir, `pretrade-removal-${timestamp}.json`);
      fs.writeFileSync(backupFile, JSON.stringify({
        version: 1,
        created_at: now.toISOString(),
        database: dbPath,
        tables: { r2_share_mappings: mappings, r2_pretrade_checks: checks },
      }, null, 2), { flag: 'wx' });
      const columns = tableColumns(db, 'trade_transactions');
      for (const name of ARRIVAL_COLUMNS) {
        if (!columns.has(name)) db.exec(`ALTER TABLE trade_transactions ADD COLUMN ${name} TEXT`);
      }
      if (!tableExists(db, 'app_meta')) {
        db.exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT \'\', updated_at TEXT NOT NULL)');
      }
      const appliedAt = now.toISOString();
      let backfilled = 0;
      for (const fact of historical) {
        const trade = db.prepare('SELECT id, trade_type, status, confirm_date, trade_date FROM trade_transactions WHERE id = ?').get(fact.trade_id);
        if (!trade || trade.trade_type !== 'redeem' || trade.status !== 'confirmed') continue;
        const startsOn = trade.confirm_date || trade.trade_date;
        if (startsOn && fact.arrival_date < startsOn) continue;
        const result = db.prepare("UPDATE trade_transactions SET arrival_date = ?, " +
          "arrival_verified_at = COALESCE(NULLIF(arrival_verified_at, ''), ?) WHERE id = ?")
          .run(fact.arrival_date, appliedAt, fact.trade_id);
        if (result.changes > 0) backfilled += 1;
      }
      db.exec('DROP TABLE IF EXISTS r2_pretrade_checks');
      db.exec('DROP TABLE IF EXISTS r2_share_mappings');
      const meta = { version: 1, applied_at: appliedAt, historical_settlements: historical.length, backfilled, backup_file: backupFile };
      db.prepare('INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .run(META_KEY, JSON.stringify(meta), appliedAt);
      const integrity = db.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('数据库完整性校验失败');
      db.exec('COMMIT');
      return { changed: true, backup_file: backupFile, ...meta };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

const main = () => {
  const [action = 'status', ...args] = process.argv.slice(2);
  const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const dbPath = path.resolve(option('--db', path.join(root, 'data/r2_ledger.sqlite')));
  const backupDir = option('--backup-dir', path.join(root, 'data/backup'));
  if (action === 'status') return report(dbPath);
  if (action === 'verify') return verify({ dbPath });
  if (action === 'apply') return apply({ dbPath, backupDir });
  throw new Error(`未知操作: ${action}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] || 'status';
  try {
    const result = { ok: true, ...main() };
    console.log(JSON.stringify(result));
    if (action === 'verify' && result.ok === false) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export { apply, report, verify };
