#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { openDatabase } = require('../lib/db.js')
const {
  createConsistentSnapshot,
  restoreDatabase,
  validateDatabase,
} = require('../server/infrastructure/backup/sqlite-backup.js')
const { DatabaseSync } = require('node:sqlite')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultDbPath = path.join(root, 'data', 'r2_ledger.sqlite')

function parseArgs(argv) {
  const action = argv[0] || 'preflight'
  const dbIndex = argv.indexOf('--db')
  const dbPath =
    dbIndex >= 0 && argv[dbIndex + 1]
      ? path.resolve(argv[dbIndex + 1])
      : process.env.R2_DB_PATH || defaultDbPath
  return { action, dbPath }
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100
}

function buildDerivedAccountIncomeReport(db) {
  const rows = db
    .prepare(`
      SELECT
        v.yield_date AS date,
        COUNT(*) AS product_count,
        SUM(CAST(ROUND(v.daily_pnl * 100) AS INTEGER)) AS total_cents,
        d.daily_pnl AS daily_pnl,
        d.source AS source
      FROM product_daily_valuations v
      LEFT JOIN daily_records d ON d.record_date = v.yield_date
      GROUP BY v.yield_date
      ORDER BY v.yield_date ASC
    `)
    .all()
  const changes = rows.map((row) => {
    const derived = Number(row.total_cents || 0) / 100
    const current =
      row.daily_pnl === null || row.daily_pnl === undefined
        ? null
        : roundMoney(row.daily_pnl)
    const difference =
      current === null ? null : roundMoney(derived - current)
    const needsSourceNormalization =
      current !== null && row.source !== 'product-income-summary'
    const needsValueChange = current === null || difference !== 0
    return {
      date: row.date,
      product_count: Number(row.product_count || 0),
      product_total: derived,
      current_account_total: current,
      difference,
      current_source: row.source || null,
      needs_source_normalization: needsSourceNormalization,
      action:
        current === null
          ? 'create'
          : needsValueChange || needsSourceNormalization
            ? 'update'
            : 'none',
    }
  })
  const legacy = db
    .prepare(`
      SELECT d.record_date AS date, d.daily_pnl, d.source
      FROM daily_records d
      WHERE NOT EXISTS (
        SELECT 1
        FROM product_daily_valuations v
        WHERE v.yield_date = d.record_date
      )
      ORDER BY d.record_date ASC
    `)
    .all()
    .map((row) => ({
      date: row.record_date,
      current_account_total: roundMoney(row.daily_pnl),
      source: row.source || null,
      action: 'skip-legacy-without-products',
    }))
  return {
    changes,
    legacy,
    summary: {
      projected_dates: changes.length,
      projected_changes: changes.filter(
        (item) => item.action !== 'none',
      ).length,
      value_changes: changes.filter(
        (item) =>
          item.current_account_total === null ||
          item.difference !== 0,
      ).length,
      source_normalizations: changes.filter(
        (item) => item.needs_source_normalization,
      ).length,
      legacy_without_products: legacy.length,
    },
  }
}

function withReadOnlyDatabase(dbPath, callback) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return callback(db)
  } finally {
    db.close()
  }
}

function readDerivedAccountIncomeReport(dbPath) {
  return withReadOnlyDatabase(dbPath, buildDerivedAccountIncomeReport)
}

export function applyDerivedAccountIncomeMigration({
  dbPath,
  openDatabaseFn = openDatabase,
}) {
  if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`)
  const before = readDerivedAccountIncomeReport(dbPath)
  const backupDir = path.join(path.dirname(dbPath), 'backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const stamp = `${new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replaceAll('.', '-')}-${process.pid}`
  const backupFile = path.join(
    backupDir,
    `pre-derived-account-income-${stamp}.sqlite`,
  )
  createConsistentSnapshot(dbPath, backupFile)
  validateDatabase(backupFile)

  let repository = null
  try {
    repository = openDatabaseFn({
      dbPath,
      productCsvPath: null,
      logger: { warn() {} },
    })
    repository.transactionManager.run(() => {
      repository.syncAllAccountRecordsFromProducts({
        operationId: `migration-derived-account-income:${stamp}`,
        requestId: `migration-derived-account-income:${stamp}`,
      })
    })
    repository.close()
    repository = null
    const after = readDerivedAccountIncomeReport(dbPath)
    return {
      action: 'apply',
      backup: backupFile,
      backup_validated: true,
      before,
      after,
      ok: after.summary.projected_changes === 0,
    }
  } catch (error) {
    try {
      repository?.close()
    } catch {
      // 恢复仍以已校验备份为准。
    }
    try {
      restoreDatabase({
        backupPath: backupFile,
        dbPath,
        safetyDir: backupDir,
      })
    } catch (restoreError) {
      throw new Error(
        `迁移失败且自动恢复失败：${error.message}；备份：${backupFile}；恢复错误：${restoreError.message}`,
      )
    }
    throw new Error(
      `迁移失败，已从备份恢复原状态：${error.message}；备份：${backupFile}`,
    )
  }
}

export async function runDerivedAccountIncomeMigration({
  action = 'preflight',
  dbPath = defaultDbPath,
  openDatabaseFn = openDatabase,
} = {}) {
  if (!['preflight', 'verify', 'apply'].includes(action)) {
    throw new Error('action 必须是 preflight、verify 或 apply')
  }
  if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在：${dbPath}`)
  if (action === 'apply') {
    return applyDerivedAccountIncomeMigration({ dbPath, openDatabaseFn })
  }
  const report = readDerivedAccountIncomeReport(dbPath)
  if (action === 'verify') {
    return {
      action,
      read_only: true,
      ...report,
      ok: report.summary.projected_changes === 0,
    }
  }
  return { action, read_only: true, ...report }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  runDerivedAccountIncomeMigration(args)
    .then((report) => {
      console.log(JSON.stringify(report, null, 2))
      if (report.ok === false) process.exitCode = 1
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
