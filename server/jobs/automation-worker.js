'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { openDatabase } = require('../../lib/db');

let repository = null;
try {
  repository = openDatabase({
    dbPath: workerData.dbPath,
    productCsvPath: workerData.productCsvPath || null,
    tradeInboxDir: workerData.tradeInboxDir || undefined,
    incomeInboxDir: workerData.incomeInboxDir || undefined,
    dataTrustMode: workerData.dataTrustMode,
    migrationPolicy: workerData.migrationPolicy || 'require',
    logger: {
      log() {},
      warn() {},
      error() {},
    },
  });
  const result = repository.automationStore.runCycle({
    today: workerData.today,
    trigger: workerData.trigger,
  });
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  if (repository) {
    try {
      repository.close();
    } catch {
      // The result has already been posted; closing is best effort.
    }
  }
  parentPort.close();
}
