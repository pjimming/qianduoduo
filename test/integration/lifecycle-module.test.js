'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../../server/lifecycle');
const { productCsv } = require('../fixtures');

test('lifecycle starts the app without installing process handlers and stops cleanly', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-lifecycle-test-'));
  const logger = {
    log() {},
    warn() {},
    error() {},
  };
  const beforeSigint = process.listenerCount('SIGINT');
  const beforeSigterm = process.listenerCount('SIGTERM');
  let runtime = null;

  t.after(async () => {
    if (runtime) await runtime.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  runtime = startServer({
    dbPath: path.join(directory, 'lifecycle.sqlite'),
    productCsvPath: productCsv,
    tradeInboxDir: path.join(directory, 'trade-inbox'),
    host: '127.0.0.1',
    port: 0,
    automation: false,
    maintenance: false,
    installSignalHandlers: false,
    logger,
  });
  await runtime.ready;

  assert.equal(runtime.server.listening, true);
  assert.equal(process.listenerCount('SIGINT'), beforeSigint);
  assert.equal(process.listenerCount('SIGTERM'), beforeSigterm);

  const address = runtime.server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  assert.equal(response.status, 200);
  const automationRun = await fetch(
    `http://127.0.0.1:${address.port}/api/automation/run`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  assert.equal(automationRun.status, 200);
  const automationPayload = await automationRun.json();
  assert.equal(automationPayload.ok, true);
  assert.equal(automationPayload.automation.runner.running, false);
  assert.equal(automationPayload.automation.runner.timedOut, false);

  await runtime.stop();
  assert.equal(runtime.server.listening, false);
});

test('lifecycle observes the supervisor stop marker and shuts down gracefully', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-lifecycle-stop-'));
  const stopFile = path.join(directory, 'server.stop');
  const logger = { log() {}, warn() {}, error() {} };
  const runtime = startServer({
    dbPath: path.join(directory, 'lifecycle.sqlite'),
    productCsvPath: productCsv,
    tradeInboxDir: path.join(directory, 'trade-inbox'),
    host: '127.0.0.1',
    port: 0,
    automation: false,
    maintenance: false,
    installSignalHandlers: false,
    stopFile,
    stopFileExitProcess: false,
    logger,
  });
  t.after(async () => {
    await runtime.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await runtime.ready;
  fs.writeFileSync(stopFile, 'stop');
  for (let attempt = 0; attempt < 40 && runtime.server.listening; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await runtime.stop();
  assert.equal(runtime.server.listening, false);
  assert.equal(fs.existsSync(stopFile), false);
  assert.equal(runtime.getStatus().closing, true);
});
