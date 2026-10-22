'use strict';

const { todayShanghai } = require('../../lib/metrics');

function createAutomationScheduler({
  repository,
  logger = console,
  pollIntervalMs = 60 * 1000,
  startupDelayMs = 250,
  maxAttempts = 3,
  retryBaseDelayMs = 1000,
  taskTimeoutMs = 30000,
  now = Date.now,
}) {
  let interval = null;
  let startupTimer = null;
  let retryTimer = null;
  let lastCycleAt = 0;
  let running = false;
  let stopped = false;
  let status = {
    name: 'automation-cycle',
    running: false,
    attempts: 0,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    lastTrigger: null,
    lastResult: null,
    lastError: '',
    timedOut: false,
  };

  function scheduleRetry(trigger, attempts) {
    const delay = retryBaseDelayMs * 2 ** (attempts - 1);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (stopped) {
        running = false;
        return;
      }
      executeAttempt(trigger, attempts + 1);
    }, delay);
    retryTimer.unref?.();
  }

  function executeAttempt(trigger, attempt) {
    const startedAtMs = now();
    status = {
      ...status,
      running: true,
      attempts: attempt,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      lastTrigger: trigger,
      lastError: '',
      timedOut: false,
    };
    let result;
    try {
      result = repository.automationStore.runCycle({
        today: todayShanghai(),
        trigger,
      });
    } catch (error) {
      result = {
        ok: false,
        skipped: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const durationMs = Math.max(0, now() - startedAtMs);
    const timedOut = durationMs > taskTimeoutMs;
    lastCycleAt = now();
    status.durationMs = durationMs;
    status.finishedAt = new Date().toISOString();
    status.lastResult = result;
    status.timedOut = timedOut;
    if (timedOut) {
      logger.warn?.(
        `  自动化 ${trigger} 执行 ${durationMs}ms，超过诊断阈值 ${taskTimeoutMs}ms`,
      );
    }
    if (result.ok) {
      logger.log?.(
        `  自动化 ${trigger}：评估 ${result.summary.evaluations_created} 条，待处理 ${result.summary.pending_jobs} 项`,
      );
      running = false;
      status.running = false;
      return result;
    }
    if (result.skipped) {
      running = false;
      status.running = false;
      return result;
    }
    status.lastError = result.error || '自动化执行失败';
    logger.warn?.(
      `  自动化 ${trigger} 失败（${attempt}/${maxAttempts}）：${status.lastError}`,
    );
    if (attempt < maxAttempts && !stopped) {
      scheduleRetry(trigger, attempt);
    } else {
      running = false;
      status.running = false;
    }
    return result;
  }

  function run(trigger) {
    if (running || stopped) return null;
    running = true;
    return executeAttempt(trigger, 1);
  }

  function start() {
    if (stopped || interval) return;
    startupTimer = setTimeout(() => run('startup'), startupDelayMs);
    startupTimer.unref?.();
    interval = setInterval(() => {
      const settings = repository.automationStore.getSettings();
      if (!settings.automation_enabled) return;
      const minutes = Math.max(1, Number(settings.scheduler_minutes) || 5);
      if (now() - lastCycleAt < minutes * 60 * 1000) return;
      run('interval');
    }, pollIntervalMs);
    interval.unref?.();
  }

  function stop() {
    stopped = true;
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
      running = false;
      status.running = false;
    }
  }

  return {
    getStatus: () => ({ ...status }),
    run,
    start,
    stop,
    isRunning: () => running,
  };
}

module.exports = {
  createAutomationScheduler,
};
