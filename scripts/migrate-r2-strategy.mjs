#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const { createConsistentSnapshot, validateDatabase } = require('../server/infrastructure/backup/sqlite-backup');
const { openScreeningRepository, isolatedPath } = require('../server/modules/r2-screening/repository');
const { CONTRACT_HASH } = require('../server/modules/r2-strategy/contract');
const schema = fs.readFileSync(new URL('../server/modules/r2-strategy/schema.sql', import.meta.url), 'utf8');
const tables = [...schema.matchAll(/CREATE TABLE (\w+)/g)].map(match => match[1]);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function withReadOnly(file, work) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return work(db); } finally { db.close(); }
}
function integrity(db) {
  const check = db.prepare('PRAGMA integrity_check').all();
  if (check.length !== 1 || check[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) {
    throw new Error('数据库完整性校验失败');
  }
}
// Every pre-existing application table, not just the four financial fact tables.
// Hashes remain in the local manifest; no rows or amounts are printed.
function legacySignature(db) {
  const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'r2_%' AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  return { schema_hash: digest(objects), tables: Object.fromEntries(objects.filter(row => row.type === 'table').map(row => {
    const name = '"' + row.name.replaceAll('"', '""') + '"';
    const rows = db.prepare(`SELECT * FROM ${name}`).all().map(item => JSON.stringify(item)).sort();
    return [row.name, { count: rows.length, hash: digest(rows) }];
  })) };
}
function inspect(db) {
  integrity(db);
  const existing = tables.filter(name => db.prepare('SELECT 1 FROM sqlite_schema WHERE name = ?').get(name));
  if (existing.length && existing.length !== tables.length) throw new Error('策略 schema 不完整，停止迁移');
  let state = null;
  if (existing.length) {
    state = db.prepare('SELECT * FROM r2_strategy_state WHERE singleton = 1').get();
    if (!state || state.schema_version !== 1) throw new Error('策略 schema 版本不匹配');
    // Compare exact DDL with a fresh schema, detecting drift instead of trusting a version integer.
    const expected = new DatabaseSync(':memory:');
    try {
      expected.exec(schema);
      const query = "SELECT type,name,sql FROM sqlite_schema WHERE name LIKE 'r2_%' ORDER BY type,name";
      if (digest(db.prepare(query).all()) !== digest(expected.prepare(query).all())) throw new Error('策略 schema 定义不匹配');
    } finally { expected.close(); }
  }
  return { installed: Boolean(state), mode: state?.mode ?? 'legacy', activation_seq: state?.activation_seq ?? 0,
    schema_version: state?.schema_version ?? null, legacy: legacySignature(db) };
}

export function preflight({ dbPath, screeningPath }) {
  validateDatabase(dbPath);
  isolatedPath(screeningPath, dbPath);
  const source = openScreeningRepository(screeningPath, { ledgerPath: dbPath, readOnly: true });
  if (!source) throw new Error('初筛库不存在');
  try { source.verify(); } finally { source.close(); }
  return withReadOnly(dbPath, inspect);
}

export function applyMigration({ dbPath, screeningPath, backupDir, now = new Date(), beforeCommit = () => {} }) {
  if (!backupDir) throw new Error('必须指定受控备份目录');
  const before = preflight({ dbPath, screeningPath });
  if (before.installed) return { changed: false, report: before };
  const checkpoint = `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const directory = path.join(backupDir, checkpoint);
  fs.mkdirSync(directory, { recursive: true });
  const ledgerBackup = path.join(directory, 'ledger.sqlite');
  const screeningBackup = path.join(directory, 'screening.sqlite');
  createConsistentSnapshot(dbPath, ledgerBackup);
  createConsistentSnapshot(screeningPath, screeningBackup);
  preflight({ dbPath: ledgerBackup, screeningPath: screeningBackup });
  const manifest = { checkpoint, created_at: now.toISOString(), contract_hash: CONTRACT_HASH,
    ledger: { file: 'ledger.sqlite', sha256: hashFile(ledgerBackup) },
    screening: { file: 'screening.sqlite', sha256: hashFile(screeningBackup) },
    before };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000; BEGIN IMMEDIATE');
    try {
      const locked = inspect(db);
      if (locked.installed) {
        db.exec('ROLLBACK');
        return { changed: false, report: locked };
      }
      // Abort if facts changed since the WAL-consistent backup. Never restore an old
      // backup over a live ledger on failure: transactional DDL is rolled back instead.
      const backedUp = withReadOnly(ledgerBackup, legacySignature);
      if (digest(locked.legacy) !== digest(backedUp)) throw new Error('备份后账本已变化，请停止写入后重试');
      db.exec(schema);
      db.prepare('INSERT INTO r2_strategy_state VALUES (1,1,?,0,\'legacy\',?,?)')
        .run(randomUUID(), CONTRACT_HASH, now.toISOString());
      beforeCommit(db);
      integrity(db);
      if (digest(legacySignature(db)) !== digest(backedUp)) throw new Error('迁移改变了既有数据或 schema');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { changed: true, backup_manifest: path.join(directory, 'manifest.json'), report: inspect(db) };
  } finally { db.close(); }
}

export function rollbackEmptyMigration({ dbPath }) {
  validateDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000; BEGIN IMMEDIATE');
    try {
      const report = inspect(db);
      if (!report.installed) { db.exec('ROLLBACK'); return { changed: false }; }
      const state = db.prepare('SELECT * FROM r2_strategy_state').get();
      if (state.activation_seq !== 0 || state.mode !== 'legacy' || tables.slice(1).some(name => db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get())) {
        throw new Error('策略对象已有业务记录，禁止删除；请停用推荐并保留审计数据');
      }
      for (const name of [...tables].reverse()) db.exec(`DROP TABLE ${name}`);
      if (digest(legacySignature(db)) !== digest(report.legacy)) throw new Error('回滚改变了既有数据');
      db.exec('COMMIT');
      return { changed: true };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action = 'preflight', ...args] = process.argv.slice(2);
  const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const options = { dbPath: path.resolve(option('--db', path.join(root, 'data/r2_ledger.sqlite'))),
    screeningPath: path.resolve(option('--screening-db', path.join(root, 'data/r2_screening.sqlite'))),
    backupDir: option('--backup-dir', null) };
  try {
    const result = action === 'apply' ? applyMigration(options) : action === 'rollback-empty' ? rollbackEmptyMigration(options)
      : ['preflight', 'verify'].includes(action) ? preflight(options) : (() => { throw new Error('未知操作'); })();
    const report = result.report ?? result;
    // Keep financial hashes and local backup paths out of routine command output.
    console.log(JSON.stringify({ ok: true, changed: result.changed, installed: report.installed,
      mode: report.mode, activation_seq: report.activation_seq, schema_version: report.schema_version }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
