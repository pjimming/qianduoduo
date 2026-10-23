'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const {
  createDailyBackup,
  pruneBackups,
} = require('../lib/backup');
const { todayShanghai } = require('../lib/metrics');
const {
  DEFAULT_PRODUCT_CSV,
  createServer,
} = require('./app');
const { DATA_TRUST_MODE, DEFAULT_DB } = require('./config');
const {
  createDashboardQueryService,
} = require('./modules/dashboard/service');
const {
  createAutomationRunner,
} = require('./jobs/automation-runner');
const { createAutomationScheduler } = require('./jobs/automation-scheduler');
const { createSafeLogger } = require('./infrastructure/logging/logger');
const {
  terminateOcrProcesses,
} = require('./infrastructure/ocr');

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function runStartupMaintenance(repository, logger) {
  try {
    const backup = createDailyBackup(repository.db, repository.dbPath, {
      dir: repository.backupDir,
    });
    pruneBackups(repository.backupDir, 45);
    if (backup.created) logger.log?.(`  每日备份：${backup.file}`);
  } catch (error) {
    logger.warn?.(`  每日备份失败：${error instanceof Error ? error.message : error}`);
  }
  try {
    const pruned = repository.tradeStore.pruneScreenshots({
      today: todayShanghai(),
      olderThanDays: 180,
    });
    if (pruned.removed > 0) {
      logger.log?.(`  已清理 ${pruned.removed} 张超过 180 天的成交截图原图`);
    }
  } catch (error) {
    logger.warn?.(`  截图清理失败：${error instanceof Error ? error.message : error}`);
  }
}

function startServer(options = {}) {
  const logger = createSafeLogger(options.logger || console);
  const repository = openDatabase({
    dbPath: options.dbPath || process.env.R2_DB_PATH || DEFAULT_DB,
    productCsvPath: options.productCsvPath || DEFAULT_PRODUCT_CSV,
    tradeInboxDir:
      options.tradeInboxDir || process.env.R2_TRADE_INBOX_DIR || undefined,
    dataTrustMode: options.dataTrustMode || DATA_TRUST_MODE,
    migrationPolicy: options.migrationPolicy || 'auto',
    logger,
  });
  const recoveredRuns = repository.automationStore.recoverInterruptedRuns();
  if (recoveredRuns > 0) {
    logger.warn?.(`  已标记 ${recoveredRuns} 条中断的自动任务为失败`);
  }

  if (options.maintenance !== false) {
    runStartupMaintenance(repository, logger);
  }

  const pidFile =
    options.pidFile || process.env.R2_SERVER_PID_FILE || '';
  if (pidFile) {
    try {
      fs.mkdirSync(path.dirname(pidFile), { recursive: true });
      fs.writeFileSync(pidFile, String(process.pid), 'ascii');
    } catch (error) {
      logger.warn?.(
        `  Server PID 文件写入失败：${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  const automationRunner =
    options.automationRunner ||
    createAutomationRunner({
      repository,
      logger,
      timeoutMs: options.automationTimeoutMs || 30000,
      dataTrustMode: options.dataTrustMode || DATA_TRUST_MODE,
      migrationPolicy: options.migrationPolicy || 'auto',
    });
  const dashboardQuery = createDashboardQueryService(repository, {
    automationRunner,
  });
  try {
    dashboardQuery.projectDashboard();
  } catch (error) {
    logger.warn?.(
      `  启动状态投影失败：${error instanceof Error ? error.message : error}`,
    );
  }
  const scheduler = createAutomationScheduler({
    repository,
    runner: automationRunner,
    logger,
    taskTimeoutMs: options.automationTimeoutMs || 30000,
    onCycleComplete: () => dashboardQuery.projectDashboard(),
  });
  if (options.automation !== false) scheduler.start();

  const server = createServer({
    repository,
    dashboardQuery,
    automationRunner,
  });
  const host = options.host || process.env.HOST || '127.0.0.1';
  const port = Number(options.port ?? process.env.PORT ?? 8765);
  let closing = null;
  let stopFileTimer = null;
  const stopFile = options.stopFile || process.env.R2_STOP_FILE || '';

  function stop({ exitProcess = false, exitCode = 0 } = {}) {
    if (closing) return closing;
    closing = Promise.resolve(scheduler.stop())
      .then(() => {
        terminateOcrProcesses();
        return closeServer(server);
      })
      .catch((error) => {
        logger.error?.(error);
      })
      .then(() => {
        if (stopFileTimer) {
          clearInterval(stopFileTimer);
          stopFileTimer = null;
        }
        if (stopFile) {
          try {
            fs.rmSync(stopFile, { force: true });
          } catch {
            // The supervisor removes the marker as a fallback.
          }
        }
        try {
          repository.close();
        } catch (error) {
          logger.error?.(error);
        }
        if (options.installSignalHandlers !== false) {
          process.off('SIGINT', onSigint);
          process.off('SIGTERM', onSigterm);
        }
        if (exitProcess) process.exit(exitCode);
      });
    return closing;
  }

  const onSigint = () => stop({ exitProcess: true });
  const onSigterm = () => stop({ exitProcess: true });
  if (options.installSignalHandlers !== false) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  }
  if (stopFile) {
    stopFileTimer = setInterval(() => {
      if (!fs.existsSync(stopFile)) return;
      stop({
        exitProcess: options.stopFileExitProcess !== false,
      });
    }, 250);
    stopFileTimer.unref?.();
  }

  const ready = new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      const actualPort =
        address && typeof address === 'object' ? address.port : port;
      logger.log?.('');
      logger.log?.('  钱多多已启动');
      logger.log?.(`  打开：http://${host}:${actualPort}`);
      logger.log?.(`  数据库：${repository.dbPath}`);
      logger.log?.('  按 Ctrl+C 停止服务');
      logger.log?.('');
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      logger.error?.(`端口 ${port} 已被占用。可设置 PORT=其他端口后重试。`);
    } else {
      logger.error?.(error);
    }
  });

  return {
    server,
    repository,
    ready,
    stop,
    scheduler,
    getStatus: () => ({
      listening: server.listening,
      closing: Boolean(closing),
      scheduler: scheduler.getStatus(),
    }),
  };
}

module.exports = {
  closeServer,
  runStartupMaintenance,
  startServer,
};
