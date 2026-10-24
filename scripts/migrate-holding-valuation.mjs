#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const {
  HOLDING_VALUATION_MIGRATION_ID,
  HOLDING_VALUATION_SCHEMA,
} = require('../lib/holding-valuation-store.js')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultDbPath = path.join(root, 'data', 'r2_ledger.sqlite')
const action = process.argv[2] || 'status'
const dbIndex = process.argv.indexOf('--db')
const dbPath =
  dbIndex >= 0 && process.argv[dbIndex + 1]
    ? path.resolve(process.argv[dbIndex + 1])
    : (process.env.R2_DB_PATH || defaultDbPath)

if (!['status', 'apply', 'verify'].includes(action)) {
  console.error('用法：node scripts/migrate-holding-valuation.mjs status|apply|verify [--db path]')
  process.exit(2)
}
if (!fs.existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}`)
  process.exit(2)
}

const hash = crypto
  .createHash('sha256')
  .update(HOLDING_VALUATION_SCHEMA)
  .digest('hex')
const db = new DatabaseSync(dbPath)
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`)

function tableExists(name) {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name),
  )
}

function status() {
  const migrationTable = tableExists('schema_migrations')
  const snapshots = tableExists('holding_valuation_snapshots')
  const items = tableExists('holding_valuation_items')
  const migration = migrationTable
    ? db
        .prepare('SELECT * FROM schema_migrations WHERE id = ?')
        .get(HOLDING_VALUATION_MIGRATION_ID)
    : null
  return {
    db: dbPath,
    migration_id: HOLDING_VALUATION_MIGRATION_ID,
    schema: {
      holding_valuation_snapshots: snapshots,
      holding_valuation_items: items,
      complete: snapshots && items,
    },
    migration: migration
      ? {
          status: migration.status,
          script_sha256: migration.script_sha256,
          hash_match: migration.script_sha256 === hash,
          completed_at: migration.completed_at,
        }
      : null,
    counts: snapshots
      ? {
          snapshots: Number(
            db
              .prepare('SELECT COUNT(*) AS count FROM holding_valuation_snapshots')
              .get().count,
          ),
          items: items
            ? Number(
                db
                  .prepare('SELECT COUNT(*) AS count FROM holding_valuation_items')
                  .get().count,
              )
            : 0,
        }
      : null,
  }
}

function applyMigration() {
  const stamp = new Date().toISOString()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        script_sha256 TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT NOT NULL DEFAULT ''
      );
    `)
    db.exec(HOLDING_VALUATION_SCHEMA)
    db.prepare(`
      INSERT INTO schema_migrations (
        id, script_sha256, status, started_at, completed_at, error
      ) VALUES (?, ?, 'completed', ?, ?, '')
      ON CONFLICT(id) DO UPDATE SET
        script_sha256 = excluded.script_sha256,
        status = 'completed',
        completed_at = excluded.completed_at,
        error = ''
    `).run(
      HOLDING_VALUATION_MIGRATION_ID,
      hash,
      stamp,
      stamp,
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function verify() {
  const current = status()
  const quick = db.prepare('PRAGMA quick_check').all()
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all()
  return {
    ...current,
    ok:
      current.schema.complete &&
      current.migration?.status === 'completed' &&
      current.migration.hash_match &&
      quick.length === 1 &&
      quick[0].quick_check === 'ok' &&
      foreignKeys.length === 0,
    quick_check: quick,
    foreign_key_check: foreignKeys,
  }
}

try {
  if (action === 'apply') applyMigration()
  const report = action === 'verify' ? verify() : status()
  console.log(JSON.stringify(report, null, 2))
  if (action === 'verify' && !report.ok) process.exitCode = 1
} finally {
  db.close()
}
