'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('../helpers/test-context');
const {
  terminateOcrProcesses,
} = require('../../server/infrastructure/ocr');

test('startup recovery marks interrupted automation runs as failed', (t) => {
  const context = createTestContext(t);
  context.repository.db.prepare(`
    INSERT INTO automation_runs (
      trigger, status, started_at, summary_json, error
    ) VALUES ('interrupted', 'running', ?, '{}', '')
  `).run(new Date().toISOString());
  const recovered = context.repository.automationStore.recoverInterruptedRuns();
  assert.equal(recovered, 1);
  const run = context.repository.automationStore
    .listAutomationRuns(10)
    .find((item) => item.trigger === 'interrupted');
  assert.equal(run.status, 'failed');
  assert.match(run.error, /进程中断/);
  assert.ok(run.finished_at);
});

test('OCR shutdown hook is idempotent with no active processes', () => {
  assert.equal(terminateOcrProcesses(), 0);
  assert.equal(terminateOcrProcesses(), 0);
});
