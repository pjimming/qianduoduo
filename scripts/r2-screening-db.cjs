#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const { DEFAULT_SCREENING_DB, ROOT } = require('../server/config');
const { isolatedPath, openScreeningRepository, SCHEMA_VERSION } = require('../server/modules/r2-screening/repository');
const { createConsistentSnapshot } = require('../server/infrastructure/backup/sqlite-backup');
const { findBrowserExecutable } = require('../server/modules/r2-screening/product-list');
const { shanghaiTime, refreshCalendar, valuationCalendar } = require('../server/modules/r2-screening/calendar');

const DEFAULT_BACKUPS = path.join(ROOT, 'data', 'screening-backups');

function verify(file) {
  const store = openScreeningRepository(file, { readOnly: true });
  if (!store) throw new Error('初筛库不存在');
  try {
    return { ...store.verify(), current: store.current()?.id ?? null, bytes: fs.statSync(file).size };
  } finally {
    store.close();
  }
}

function backup(file, directory, label) {
  verify(file);
  const name = `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`;
  const dest = isolatedPath(path.join(directory, name));
  createConsistentSnapshot(file, dest);
  return { file: dest, ...verify(dest) };
}

function restore(file, source, directory) {
  const snapshot = isolatedPath(source);
  verify(snapshot);
  if (file === snapshot || ['-wal', '-shm', '-journal'].some(suffix => fs.existsSync(file + suffix))) {
    throw new Error('需要独立备份文件和已停止的初筛库');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const safety = fs.existsSync(file) ? backup(file, directory, 'pre-restore') : null;
  const staged = path.join(path.dirname(file), `.screening-restore-${randomUUID()}.sqlite`);
  try {
    createConsistentSnapshot(snapshot, staged);
    verify(staged);
    fs.renameSync(staged, file);
  } finally {
    fs.rmSync(staged, { force: true });
  }
  return { safety, restored: verify(file) };
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { db: { type: 'string' }, backup: { type: 'string' }, 'backup-dir': { type: 'string' }, offline: { type: 'boolean' } },
  });
  const [command] = positionals;
  const file = isolatedPath(values.db || process.env.R2_SCREENING_DB_PATH || DEFAULT_SCREENING_DB);
  const directory = path.resolve(values['backup-dir'] || DEFAULT_BACKUPS);
  let result;
  switch (command) {
    case 'preflight': {
      require('playwright-core');
      const date = shanghaiTime(new Date()).date;
      result = {
        file, exists: fs.existsSync(file), schema_version: SCHEMA_VERSION, browser: findBrowserExecutable(),
        refresh_calendar: refreshCalendar.version, valuation_calendar: valuationCalendar.version,
        calendar_gap: refreshCalendar.isOpen(date) === null,
      };
      if (result.exists) verify(file);
      break;
    }
    case 'init': {
      const store = openScreeningRepository(file, { initialize: true });
      store.close();
      result = verify(file);
      break;
    }
    case 'status':
      result = fs.existsSync(file) ? { availability: 'ready', ...verify(file) } : { availability: 'uninitialized' };
      break;
    case 'verify':
      result = verify(file);
      break;
    case 'backup':
      result = backup(file, directory, 'screening');
      break;
    case 'restore':
      if (!values.offline || !values.backup) throw new Error('停止初筛服务后指定 --offline --backup <文件>');
      result = restore(file, values.backup, directory);
      break;
    default:
      throw new Error('使用 preflight / init / status / verify / backup / restore');
  }
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { verify, backup, restore };
