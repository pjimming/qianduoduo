'use strict';

const fs = require('node:fs');
const { DEFAULT_SCREENING_DB, SCREENING_ENABLE_FILE } = require('../config');
const { createScreeningService } = require('../modules/r2-screening/service');
const { openScreeningRepository } = require('../modules/r2-screening/repository');

function createScreeningRuntime(options, ledgerPath, logger) {
  // Test and auxiliary servers opt in explicitly when they use an alternate ledger.
  const useEnvironment = !options.dbPath && options.maintenance !== false;
  const enabled = options.screeningEnabled ?? (useEnvironment && (process.env.R2_SCREENING_ENABLED === undefined
    ? fs.existsSync(SCREENING_ENABLE_FILE) : process.env.R2_SCREENING_ENABLED === '1'));
  const file = options.screeningDbPath ?? (useEnvironment ? process.env.R2_SCREENING_DB_PATH || DEFAULT_SCREENING_DB : null);
  const serviceOptions = { ...options.screeningOptions, enabled, logger };
  let warned = false;

  function open(readOnly) {
    try {
      return { repository: file ? openScreeningRepository(file, { ledgerPath, readOnly }) : null };
    } catch {
      if (!warned) logger.warn?.('R2 初筛库不可用，账本服务继续运行');
      warned = true;
      return { issue: 'store_unavailable' };
    }
  }

  if (enabled) return createScreeningService({ ...serviceOptions, ...open(false) });
  const paused = createScreeningService(serviceOptions);
  if (!file) return paused;
  // With the worker paused, no database handle survives an HTTP read. The ledger
  // can keep running while the operator replaces the independent screening file.
  const queries = ['status', 'runs', 'runDetail', 'results', 'detail', 'nav'];
  return {
    ...paused,
    ...Object.fromEntries(queries.map(method => [method, (...args) => {
      const service = createScreeningService({ ...serviceOptions, ...open(true) });
      try {
        return service[method](...args);
      } finally {
        service.close();
      }
    }])),
  };
}

module.exports = { createScreeningRuntime };
