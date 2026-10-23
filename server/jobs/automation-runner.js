'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const DEFAULT_WORKER = path.join(__dirname, 'automation-worker.js');

function createAutomationRunner({
  repository,
  logger = console,
  workerPath = DEFAULT_WORKER,
  workerFactory = (file, options) => new Worker(file, options),
  timeoutMs = 30000,
  dataTrustMode = 'shadow',
  migrationPolicy = 'require',
  now = Date.now,
}) {
  if (!repository?.dbPath) {
    throw new Error('automation runner 需要包含 dbPath 的 repository');
  }
  let worker = null;
  let settleActive = null;
  let stopping = false;
  let timer = null;
  let stopped = false;
  let status = {
    running: false,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    lastResult: null,
    lastError: '',
    timedOut: false,
    stopReason: '',
  };

  function clearTimer() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  function recoverInterruptedRuns() {
    try {
      repository.automationStore?.recoverInterruptedRuns?.();
    } catch (error) {
      logger.warn?.(
        `  自动化中断状态恢复失败：${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  function finish(next) {
    clearTimer();
    worker = null;
    settleActive = null;
    status = {
      ...status,
      ...next,
      finishedAt: new Date().toISOString(),
      running: false,
    };
    return status.lastResult;
  }

  function run({ today, trigger = 'manual', timeout = timeoutMs } = {}) {
    if (stopped) {
      return Promise.resolve({
        ok: false,
        skipped: true,
        reason: '自动化运行器已停止',
      });
    }
    if (worker) {
      return Promise.resolve({
        ok: false,
        skipped: true,
        reason: '自动化任务正在运行',
      });
    }
    if (!today) {
      return Promise.reject(new Error('automation runner 需要 today'));
    }

    const startedAtMs = now();
    status = {
      ...status,
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      lastResult: null,
      lastError: '',
      timedOut: false,
      stopReason: '',
    };

    return new Promise((resolve) => {
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        settleActive = null;
        const durationMs = Math.max(0, now() - startedAtMs);
        finish({
          durationMs,
          lastResult: result,
          lastError: result.ok ? '' : result.error || '',
          timedOut: Boolean(result.timed_out),
        });
        resolve(result);
      };
      settleActive = settle;

      try {
        worker = workerFactory(workerPath, {
          workerData: {
            dbPath: repository.dbPath,
            productCsvPath: repository.productCsvPath || null,
            tradeInboxDir: repository.tradeInboxDir || null,
            incomeInboxDir: repository.incomeInboxDir || null,
            dataTrustMode,
            migrationPolicy,
            today,
            trigger,
          },
        });
      } catch (error) {
        settle({
          ok: false,
          skipped: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      timer = setTimeout(async () => {
        if (settled) return;
        const active = worker;
        stopping = true;
        const terminate = active?.terminate?.();
        status.stopReason = 'timeout';
        logger.warn?.(
          `  自动化 ${trigger} 超过硬超时 ${timeout}ms，正在终止 worker`,
        );
        try {
          await terminate;
        } catch (error) {
          logger.warn?.(
            `  自动化 worker 终止失败：${
              error instanceof Error ? error.message : error
            }`,
          );
        }
        recoverInterruptedRuns();
        stopping = false;
        settle({
          ok: false,
          skipped: false,
          timed_out: true,
          error: `自动化执行超过 ${timeout}ms，已终止`,
        });
      }, Math.max(1, Number(timeout) || timeoutMs));
      timer.unref?.();

      worker.once('message', (message) => {
        if (!message?.ok) {
          settle({
            ok: false,
            skipped: false,
            error: message?.error || '自动化 worker 执行失败',
          });
          return;
        }
        settle(message.result);
      });
      worker.once('error', (error) => {
        recoverInterruptedRuns();
        settle({
          ok: false,
          skipped: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      worker.once('exit', (code) => {
        if (settled || stopping || code === 0) return;
        recoverInterruptedRuns();
        settle({
          ok: false,
          skipped: false,
          error: `自动化 worker 异常退出，退出码 ${code}`,
        });
      });
    });
  }

  async function stop(reason = 'runtime-stop') {
    stopped = true;
    clearTimer();
    status.stopReason = reason;
    const active = worker;
    stopping = true;
    worker = null;
    status.running = false;
    if (!active) {
      settleActive?.({
        ok: false,
        skipped: true,
        error: '自动化运行器已停止',
      });
      settleActive = null;
      return;
    }
    try {
      await active.terminate?.();
    } catch (error) {
      logger.warn?.(
        `  automation runner 终止 worker 失败：${
          error instanceof Error ? error.message : error
        }`,
      );
    }
    recoverInterruptedRuns();
    settleActive?.({
      ok: false,
      skipped: true,
      error: '自动化运行器已停止',
    });
    settleActive = null;
    stopping = false;
  }

  return {
    run,
    stop,
    getStatus: () => ({ ...status }),
    isRunning: () => Boolean(worker),
  };
}

module.exports = {
  createAutomationRunner,
};
