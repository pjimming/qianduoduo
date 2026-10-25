'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { openDatabase } = require('../../lib/db');
const {
  createAutomationRunner,
} = require('../../server/jobs/automation-runner');

function openTemp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-runner-'));
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: null,
    dataTrustMode: 'off',
    logger: { warn() {} },
  });
  t.after(() => {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return repository;
}

test('automation runner executes the cycle in a worker and rejects reentry', async (t) => {
  const repository = openTemp(t);
  const runner = createAutomationRunner({
    repository,
    timeoutMs: 5000,
    dataTrustMode: 'off',
    migrationPolicy: 'auto',
    logger: { warn() {} },
  });
  t.after(() => runner.stop('test-cleanup'));

  const first = runner.run({
    today: '2026-10-23',
    trigger: 'test-worker',
  });
  const second = await runner.run({
    today: '2026-10-23',
    trigger: 'test-reentry',
  });
  assert.equal(second.skipped, true);
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(result.run_id > 0, true);
  assert.equal(runner.isRunning(), false);
  assert.ok(
    repository.automationStore
      .listAutomationRuns()
      .some((run) => run.trigger === 'test-worker' && run.status === 'done'),
  );
});

test('automation runner terminates a worker at the hard timeout', async (t) => {
  const repository = openTemp(t);
  let terminated = false;
  const runner = createAutomationRunner({
    repository,
    timeoutMs: 30,
    workerFactory: () => {
      const worker = new Worker('setInterval(() => {}, 1000)', {
        eval: true,
      });
      const originalTerminate = worker.terminate.bind(worker);
      worker.terminate = () => {
        terminated = true;
        return originalTerminate();
      };
      return worker;
    },
    logger: { warn() {} },
  });
  t.after(() => runner.stop('test-cleanup'));

  const result = await runner.run({
    today: '2026-10-23',
    trigger: 'test-timeout',
  });
  assert.equal(result.ok, false);
  assert.equal(result.timed_out, true);
  assert.match(result.error, /已终止/);
  assert.equal(terminated, true);
  assert.equal(runner.isRunning(), false);
  assert.equal(runner.getStatus().timedOut, true);
});

test('automation runner stop terminates an active worker and releases the caller', async (t) => {
  const repository = openTemp(t);
  let terminated = false;
  const runner = createAutomationRunner({
    repository,
    timeoutMs: 5000,
    workerFactory: () => {
      const worker = new Worker('setInterval(() => {}, 1000)', {
        eval: true,
      });
      const originalTerminate = worker.terminate.bind(worker);
      worker.terminate = () => {
        terminated = true;
        return originalTerminate();
      };
      return worker;
    },
    logger: { warn() {} },
  });

  const active = runner.run({
    today: '2026-10-23',
    trigger: 'test-stop',
  });
  await runner.stop('shutdown');
  const result = await active;
  assert.equal(result.skipped, true);
  assert.equal(terminated, true);
  assert.equal(runner.isRunning(), false);
  assert.equal(runner.getStatus().stopReason, 'shutdown');
});

test('automation runner can start a fresh cycle after a timeout', async (t) => {
  const repository = openTemp(t);
  let attempt = 0;
  const runner = createAutomationRunner({
    repository,
    timeoutMs: 500,
    workerFactory: () => {
      attempt += 1;
      if (attempt === 1) {
        return new Worker('setInterval(() => {}, 1000)', { eval: true });
      }
      return new Worker(
        `
          const { parentPort } = require('node:worker_threads');
          parentPort.postMessage({
            ok: true,
            result: {
              ok: true,
              run_id: 2,
              summary: { evaluations_created: 0, pending_jobs: 0 }
            }
          });
          parentPort.close();
        `,
        { eval: true },
      );
    },
    logger: { warn() {} },
  });
  t.after(() => runner.stop('test-cleanup'));

  const timedOut = await runner.run({
    today: '2026-10-23',
    trigger: 'timeout-first',
  });
  assert.equal(timedOut.timed_out, true);
  const recovered = await runner.run({
    today: '2026-10-23',
    trigger: 'timeout-retry',
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.run_id, 2);
  assert.equal(runner.getStatus().timedOut, false);
});
