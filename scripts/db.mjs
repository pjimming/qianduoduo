#!/usr/bin/env node
/**
 * 本地账本备份工具：
 *   node scripts/db.mjs list
 *   node scripts/db.mjs backup
 *   node scripts/db.mjs restore <YYYY-MM-DD|文件名>
 *
 * 恢复会覆盖当前数据库，脚本会先做一份 pre-restore 快照；
 * 服务运行时拒绝恢复，请先执行 npm run prod:stop。
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const {
  createConsistentSnapshot,
  restoreDatabase,
  validateDatabase,
} = require('../server/infrastructure/backup/sqlite-backup')
const dbPath = path.resolve(
  process.env.R2_DB_PATH || path.join(root, 'data', 'r2_ledger.sqlite'),
)
const backupDir = path.join(path.dirname(dbPath), 'backups')

function todayStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function listBackups() {
  if (!existsSync(backupDir)) return []
  return readdirSync(backupDir)
    .filter((name) => /^r2_ledger-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name))
    .map((name) => {
      const file = path.join(backupDir, name)
      const stats = statSync(file)
      return { name, file, date: name.slice(10, 20), bytes: stats.size }
    })
    .sort((a, b) => b.date.localeCompare(a.date))
}

async function serverIsRunning() {
  const healthUrl =
    process.env.R2_HEALTH_URL || 'http://127.0.0.1:8765/api/health'
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(800),
    })
    return response.ok
  } catch {
    return false
  }
}

function commandList() {
  const backups = listBackups()
  if (!backups.length) {
    console.log(`还没有备份。备份目录：${backupDir}`)
    return
  }
  console.log(`备份目录：${backupDir}`)
  for (const item of backups) {
    console.log(`  ${item.date}  ${(item.bytes / 1024).toFixed(0)} KB  ${item.name}`)
  }
}

function commandBackup() {
  mkdirSync(backupDir, { recursive: true })
  const target = path.join(backupDir, `r2_ledger-${todayStamp()}.sqlite`)
  if (existsSync(target)) {
    console.log(`今天的备份已存在：${target}`)
    return
  }
  createConsistentSnapshot(dbPath, target)
  validateDatabase(target)
  console.log(`已备份：${target}`)
}

async function commandRestore(requested) {
  if (!requested) {
    throw new Error('用法：node scripts/db.mjs restore <YYYY-MM-DD|文件名>')
  }
  if (await serverIsRunning()) {
    throw new Error('服务仍在运行，请先执行 npm run prod:stop 再恢复')
  }
  const backups = listBackups()
  const match =
    backups.find((item) => item.name === requested) ||
    backups.find((item) => item.date === requested)
  if (!match) {
    throw new Error(`没有找到备份：${requested}（先运行 node scripts/db.mjs list）`)
  }

  const { safetyPath } = restoreDatabase({
    backupPath: match.file,
    dbPath,
    safetyDir: backupDir,
  })
  if (safetyPath) {
    console.log(`已保留恢复前快照：${safetyPath}`)
  }
  console.log(`已恢复 ${match.name} -> ${dbPath}`)
  console.log('现在可以执行 npm run prod:restart 启动服务。')
}

const [command, argument] = process.argv.slice(2)

try {
  if (command === 'list') commandList()
  else if (command === 'backup') commandBackup()
  else if (command === 'restore') await commandRestore(argument)
  else {
    console.log('用法：node scripts/db.mjs <list|backup|restore> [备份日期或文件名]')
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
