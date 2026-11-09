#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { openStrategyLedger } = require('../server/modules/r2-strategy/existing-ledger');
const { createStrategyRepository } = require('../server/modules/r2-strategy/repository');
const { CONTRACT, CONTRACT_HASH, PREVIOUS_CONTRACT_HASH } = require('../server/modules/r2-strategy/contract');
const { DEFAULT_DB } = require('../server/config');

function argument(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name}必须为非负安全整数`);
  return number;
}

function preflight(db) {
  const jobs = Object.fromEntries(db.prepare('SELECT status,count(*) n FROM r2_derivation_jobs GROUP BY status').all()
    .map(row => [row.status, row.n]));
  const legacyPending = db.prepare(`SELECT count(*) n FROM decision_proposals
    WHERE status='pending' AND coalesce(json_extract(payload_json,'$.execution_version'),'')<>?`)
    .get(CONTRACT.execution_version).n;
  return { jobs, legacy_pending_proposals: legacyPending };
}

function run(argv = process.argv.slice(2)) {
  const action = argv[0] ?? 'status';
  if (!['status', 'activate'].includes(action)) throw new Error('只支持status、activate');
  const destination = argument(argv, '--db', process.env.R2_DB_PATH ?? DEFAULT_DB);
  const dbPath = path.resolve(destination);
  const ledger = openStrategyLedger(dbPath, { readOnly: action === 'status' });
  try {
    const repository = createStrategyRepository(ledger.db, { transactionManager: ledger.transactionManager });
    const state = repository.state();
    if (!state) throw new Error('执行策略尚未迁移');
    const counts = preflight(ledger.db);
    if (action === 'status') {
      return {
        ok: true,
        db: dbPath,
        contract_hash: CONTRACT_HASH,
        contract_matches: state.contract_hash === CONTRACT_HASH,
        mode: state.mode,
        activation_seq: state.activation_seq,
        ...counts,
      };
    }

    const mode = argument(argv, '--mode', 'v9');
    if (!['legacy', 'shadow', 'v9'].includes(mode)) throw new Error('--mode只支持legacy、shadow、v9');
    const expectedSeq = positiveInteger(argument(argv, '--expected-seq', state.activation_seq), '--expected-seq');
    if (expectedSeq !== state.activation_seq) throw new Error(`策略序号已变化：当前${state.activation_seq}，传入${expectedSeq}`);
    if (mode === 'v9' && argument(argv, '--confirm') !== 'v9') throw new Error('切换v9必须显式传入--confirm v9');
    const operationKey = argument(argv, '--operation-key');
    if (!operationKey) throw new Error('必须传入稳定的--operation-key');
    const reason = argument(argv, '--reason', '生产执行层切换');
    if (reason.length > 500) throw new Error('--reason不得超过500字');
    const upgrade = state.contract_hash === PREVIOUS_CONTRACT_HASH && argv.includes('--upgrade-contract');
    if (state.contract_hash !== CONTRACT_HASH && !upgrade) throw new Error('契约不匹配，升级须指定 --upgrade-contract');
    if (state.mode === mode && counts.jobs.running && !upgrade) throw new Error('目标模式已生效但仍有运行中的派生任务');

    const dryRun = argv.includes('--dry-run');
    if (dryRun) return { ok: true, dry_run: true, target_mode: mode, ...counts };
    if (state.mode === mode && !upgrade) return { ok: true, existing: true, mode, activation_seq: state.activation_seq, ...counts };

    const result = repository.transition({
      operationKey,
      expectedSeq,
      mode,
      previousContractHash: upgrade ? PREVIOUS_CONTRACT_HASH : undefined,
      summary: {
        reason,
        from_mode: state.mode,
        contract_hash: CONTRACT_HASH,
        legacy_pending_proposals: counts.legacy_pending_proposals,
        queued_jobs: counts.jobs,
      },
    }, ({ before, activation_seq }) => {
      const stamp = new Date().toISOString();
      // Derivations are projections, not financial facts. Anything started under
      // the old activation is invalidated; the new scheduler will enqueue a fresh
      // latest-context job after it starts.
      ledger.db.prepare(`UPDATE r2_derivation_jobs SET status='superseded',lease_token=NULL,
        lease_until=NULL,error_code='activation_changed',updated_at=?
        WHERE status IN ('pending','running')`).run(stamp);
      // Legacy pending proposals were not written under the v9 execution contract
      // and cannot be adopted after activation. Preserve their original payload.
      ledger.db.prepare(`UPDATE decision_proposals SET status='expired',
        reject_reason='执行层切换，旧提案作废',updated_at=?
        WHERE status='pending' AND coalesce(json_extract(payload_json,'$.execution_version'),'')<>?`)
        .run(stamp, CONTRACT.execution_version);
      if (upgrade) ledger.db.prepare(`UPDATE decision_proposals SET status='expired',
        reject_reason='配置契约升级，请重新生成',updated_at=?
        WHERE status='pending' AND coalesce(json_extract(payload_json,'$.contract_hash'),'')<>?`)
        .run(stamp, CONTRACT_HASH);
      return { from_mode: before.mode, activation_seq, reason };
    });
    return { ok: true, db: dbPath, operation_key: operationKey, ...result, ...preflight(ledger.db) };
  } finally {
    ledger.close();
  }
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(run()));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.code ?? 'switch_failed', error: error.message }));
    process.exitCode = 1;
  }
}

module.exports = { run };
