#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { createConsistentSnapshot } = require('../server/infrastructure/backup/sqlite-backup');
const { assertIncomeUnits, toIncomeUnits, roundIncomeUnitsToCents } = require('../lib/income-precision');
export const VERSION = 'income-precision-v1';
const fields = [
  ['product_daily_valuations', 'daily_pnl_1e4', 'INTEGER'],
  ['product_daily_valuations', 'daily_pnl_precision', 'INTEGER CHECK (daily_pnl_precision IN (2, 4))'],
  ['daily_records', 'daily_pnl_1e4', 'INTEGER'],
];

export function precisionMigrationStatus(db) {
  const missing = fields.filter(([table, name]) => !db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === name))
    .map(([table, column]) => ({ table, column }));
  return { version: VERSION, enabled: missing.length === 0, missing };
}

export function applyPrecisionMigration(db, { afterAlter } = {}) {
  const before = precisionMigrationStatus(db);
  if (before.enabled) return { ...before, changed: false };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [table, name, type] of fields) {
      if (before.missing.some(item => item.table === table && item.column === name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
        afterAlter?.({ table, column: name });
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ...precisionMigrationStatus(db), changed: true };
}

export function verifyPrecisionMigration(db) {
  const status = precisionMigrationStatus(db);
  const integrity = db.prepare('PRAGMA quick_check').get().quick_check;
  const invalid = [];
  if (status.enabled) {
    for (const row of db.prepare('SELECT id,daily_pnl,daily_pnl_1e4,daily_pnl_precision FROM product_daily_valuations').all()) {
      if (row.daily_pnl_1e4 == null) {
        if (row.daily_pnl_precision != null) invalid.push({ id: row.id, reason: 'precision_without_raw' });
        continue;
      }
      try {
        assertIncomeUnits(row.daily_pnl_1e4);
        if (![2, 4].includes(row.daily_pnl_precision)) throw Error('invalid_source_precision');
        if (row.daily_pnl_precision === 2 && row.daily_pnl_1e4 % 100 !== 0) throw Error('two_digit_precision_conflict');
        if (roundIncomeUnitsToCents(row.daily_pnl_1e4) !== roundIncomeUnitsToCents(toIncomeUnits(row.daily_pnl))) throw Error('cent_projection_conflict');
      } catch (error) { invalid.push({ id: row.id, reason: error.message }); }
    }
    for (const row of db.prepare('SELECT id,daily_pnl_1e4 FROM daily_records WHERE daily_pnl_1e4 IS NOT NULL').all()) {
      try { assertIncomeUnits(row.daily_pnl_1e4); }
      catch (error) { invalid.push({ account_record_id: row.id, reason: error.message }); }
    }
  }
  return { ...status, integrity, invalid, ok: status.enabled && integrity === 'ok' && invalid.length === 0 };
}

function main() {
  const args = process.argv.slice(2);
  const action = args[0] || 'status';
  if (!['status', 'apply', 'verify'].includes(action)) throw Error('action must be status, apply or verify');
  const dbIndex = args.indexOf('--db');
  const dbPath = path.resolve(dbIndex < 0 ? 'data/r2_ledger.sqlite' : args[dbIndex + 1]);
  if (!fs.existsSync(dbPath)) throw Error('数据库不存在');
  let backup = null;
  if (action === 'apply') {
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    let current;
    try { current = precisionMigrationStatus(probe); } finally { probe.close(); }
    if (current.enabled) {
      console.log(JSON.stringify({ ...current, changed: false, db_path: dbPath, backup: null }, null, 2));
      return;
    }
    const backupIndex = args.indexOf('--backup');
    backup = path.resolve(backupIndex < 0 ? `${dbPath}.income-precision-${Date.now()}.backup` : args[backupIndex + 1]);
    if (backup === dbPath || fs.existsSync(backup)) throw Error('备份路径不可覆盖现有文件或源数据库');
    createConsistentSnapshot(dbPath, backup);
    const check = new DatabaseSync(backup, { readOnly: true });
    try { if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('备份完整性检查失败'); }
    finally { check.close(); }
  }
  const db = new DatabaseSync(dbPath, { readOnly: action !== 'apply' });
  try {
    const result = action === 'apply' ? applyPrecisionMigration(db) :
      action === 'verify' ? verifyPrecisionMigration(db) : precisionMigrationStatus(db);
    console.log(JSON.stringify({ ...result, db_path: dbPath, backup }, null, 2));
    if (action === 'verify' && !result.ok) process.exitCode = 1;
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
