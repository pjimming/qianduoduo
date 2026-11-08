#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { openStrategyLedger } = require('../server/modules/r2-strategy/existing-ledger');
const { openScreeningRepository } = require('../server/modules/r2-screening/repository');
const { createStrategyService } = require('../server/modules/r2-strategy/service');
const { todayShanghai } = require('../lib/metrics');
const { DEFAULT_DB, DEFAULT_SCREENING_DB, ROOT } = require('../server/config');

function run(argv = process.argv.slice(2)) {
  const [action = 'status', ...args] = argv;
  if (!['status', 'preview', 'recompute'].includes(action)) throw new Error('只支持status、preview、recompute；策略激活必须通过完整切换用例');
  const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  let ledger, screening;
  try {
    ledger = openStrategyLedger(option('--db', process.env.R2_DB_PATH ?? DEFAULT_DB), { readOnly: action !== 'recompute' });
    screening = openScreeningRepository(option('--screening-db', process.env.R2_SCREENING_DB_PATH ?? DEFAULT_SCREENING_DB), { ledgerPath: ledger.dbPath, readOnly: true });
    const service = createStrategyService({ repository: ledger,
      screening: { executionSnapshot: () => screening?.readExecutionSnapshot() ?? null }, todayProvider: () => option('--date', todayShanghai()) });
    const result = action === 'status' ? service.status() : service[action]();
    const destination = option('--out', null);
    if (destination) {
      const target = path.resolve(destination), controlled = path.resolve(ROOT, 'run');
      const relative = path.relative(controlled, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('策略结果仅可输出到工作区run目录');
      const canonicalRoot = fs.realpathSync(controlled);
      let ancestor = path.dirname(target);
      while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
      const canonicalRelative = path.relative(canonicalRoot, fs.realpathSync(ancestor));
      if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) throw new Error('策略结果目录链接越过受控根');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(result, null, 2), { flag: 'wx' });
    }
    return result;
  } finally { screening?.close(); ledger?.close(); }
}

if (require.main === module) {
  try {
    const result = run();
    // Console output is operational only; financial details require an explicit
    // private --out artifact or are returned by the authenticated local API.
    console.log(JSON.stringify({ ok: true, mode: result.mode ?? result.result?.input?.mode,
      activation_seq: result.activation_seq ?? result.result?.input?.activation_seq,
      migrated: result.migrated, persisted: result.persisted, job_id: result.job_id,
      status: result.result?.allocation?.status, input_fingerprint: result.input_fingerprint }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { run };
