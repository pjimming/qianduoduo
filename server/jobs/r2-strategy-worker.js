'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { openStrategyLedger } = require('../modules/r2-strategy/existing-ledger');
const { openScreeningRepository } = require('../modules/r2-screening/repository');
const { createStrategyService } = require('../modules/r2-strategy/service');
const { todayShanghai } = require('../../lib/metrics');
const { refreshHoldingMonitor } = require('./r2-holding-monitor');

async function execute() {
let ledger, screening, screeningError;
const controller = new AbortController();
parentPort.on('message', message => { if (message?.action === 'stop') controller.abort(new Error('策略worker已停止')); });
try {
  if (!['preview', 'recompute', 'status'].includes(workerData.action)) throw new Error('执行策略worker动作无效');
  ledger = openStrategyLedger(workerData.dbPath, { readOnly: workerData.action !== 'recompute' });
  try { screening = workerData.screeningPath ? openScreeningRepository(workerData.screeningPath, { ledgerPath: ledger.dbPath, readOnly: true }) : null; }
  catch (error) { screeningError = error; }
  const service = createStrategyService({ repository: ledger,
    screening: { executionSnapshot: () => { if (screeningError) throw screeningError; return screening?.readExecutionSnapshot() ?? null; } },
    ...(workerData.date ? { todayProvider: () => workerData.date } : {}) });
  const status = service.status();
  if (workerData.expectedSeq !== undefined && status.activation_seq !== workerData.expectedSeq) throw new Error('执行策略worker序号已失效');
  if (workerData.mode !== undefined && status.mode !== workerData.mode) throw new Error('执行策略worker模式已失效');
  if (workerData.refreshHoldings === true && ['shadow', 'v9'].includes(status.mode)) {
    let sourceSnapshot = null;
    try { sourceSnapshot = screening?.readExecutionSnapshot() ?? null; } catch { /* Independent holding evidence can still be collected. */ }
    await refreshHoldingMonitor({ ledger, sourceSnapshot,
      date: workerData.date ?? todayShanghai(), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]) });
  }
  controller.signal.throwIfAborted();
  const current = service.status();
  if (current.activation_seq !== status.activation_seq || current.mode !== status.mode) throw new Error('执行策略worker采集期间策略已变化');
  // Legacy/0 only previews. A recompute request must never persist a projection
  // or create proposals before the controlled activation.
  const action = workerData.action === 'recompute' && status.mode === 'legacy' ? 'preview' : workerData.action;
  const options = workerData.inputFingerprint ? { expectedInputFingerprint: workerData.inputFingerprint } : {};
  const result = action === 'status' ? status : service[action](options);
  parentPort.postMessage({ ok: true, result, action, mode: status.mode, activation_seq: status.activation_seq });
} catch (error) {
  parentPort.postMessage({ ok: false, code: error.code ?? 'strategy_worker_failed', error: error.message });
} finally {
  screening?.close(); ledger?.close(); parentPort.close();
}
}
void execute();
