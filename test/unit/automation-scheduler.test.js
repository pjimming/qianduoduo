'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAutomationScheduler,
} = require('../../server/jobs/automation-scheduler');

test('automation scheduler starts once, stops cleanly and runs the cycle', async () => {
  let cycleCount = 0;
  let clock = 0;
  const repository = {
    automationStore: {
      getSettings: () => ({
        automation_enabled: true,
        scheduler_minutes: 1,
      }),
      runCycle: ({ trigger }) => {
        cycleCount += 1;
        return {
          ok: true,
          skipped: false,
          summary: {
            evaluations_created: 0,
            pending_jobs: 0,
          },
          trigger,
        };
      },
    },
  };
  const scheduler = createAutomationScheduler({
    repository,
    logger: { log() {}, warn() {} },
    startupDelayMs: 1,
    pollIntervalMs: 5,
    now: () => {
      clock += 10 * 60 * 1000;
      return clock;
    },
  });

  scheduler.start();
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  scheduler.stop();

  assert.equal(cycleCount >= 2, true);
  assert.equal(scheduler.isRunning(), false);
  assert.equal(scheduler.getStatus().name, 'automation-cycle');
  assert.equal(scheduler.getStatus().lastResult.ok, true);
});

test('automation scheduler retries failed cycles and records final status', async () => {
  let cycleCount = 0;
  const repository = {
    automationStore: {
      getSettings: () => ({
        automation_enabled: true,
        scheduler_minutes: 1,
      }),
      runCycle: ({ trigger }) => {
        cycleCount += 1;
        if (cycleCount < 3) {
          return { ok: false, skipped: false, error: `failure-${cycleCount}` };
        }
        return {
          ok: true,
          skipped: false,
          summary: { evaluations_created: 0, pending_jobs: 0 },
          trigger,
        };
      },
    },
  };
  const scheduler = createAutomationScheduler({
    repository,
    logger: { log() {}, warn() {} },
    startupDelayMs: 1,
    pollIntervalMs: 1000,
    retryBaseDelayMs: 1,
    maxAttempts: 3,
  });
  const first = scheduler.run('manual');
  assert.equal(first.ok, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = scheduler.getStatus();
  assert.equal(cycleCount, 3);
  assert.equal(status.running, false);
  assert.equal(status.attempts, 3);
  assert.equal(status.lastResult.ok, true);
  assert.equal(status.lastError, '');
});

test('stopping scheduler cancels a pending retry', async () => {
  let cycleCount = 0;
  const repository = {
    automationStore: {
      getSettings: () => ({
        automation_enabled: true,
        scheduler_minutes: 1,
      }),
      runCycle: () => {
        cycleCount += 1;
        return { ok: false, skipped: false, error: 'failed' };
      },
    },
  };
  const scheduler = createAutomationScheduler({
    repository,
    logger: { log() {}, warn() {} },
    retryBaseDelayMs: 10,
    maxAttempts: 3,
  });
  scheduler.run('manual');
  scheduler.stop();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(cycleCount, 1);
  assert.equal(scheduler.getStatus().running, false);
});
