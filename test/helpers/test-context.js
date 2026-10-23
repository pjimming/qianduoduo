'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../../lib/db');
const { createServer } = require('../../server');
const { productCsv } = require('../fixtures');

function removeDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

function createTestContext(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-refactor-test-'));
  const dbPath = path.join(directory, 'test.sqlite');
  const tradeInboxDir = path.join(directory, 'trade-inbox');
  const incomeInboxDir = path.join(directory, 'income-inbox');
  const repository = openDatabase({
    dbPath,
    productCsvPath: options.productCsvPath || productCsv,
    tradeInboxDir,
    incomeInboxDir,
    migrationPolicy: options.migrationPolicy,
    dataTrustMode: options.dataTrustMode,
    logger: options.logger || { warn() {}, info() {} },
  });

  t.after(() => {
    try {
      repository.close();
    } catch {
      // Some lifecycle tests close the repository explicitly.
    }
    removeDirectory(directory);
  });

  return {
    directory,
    dbPath,
    tradeInboxDir,
    incomeInboxDir,
    repository,
  };
}

async function startTestServer(t, options = {}) {
  const context = createTestContext(t, options);
  const server = createServer({ repository: context.repository });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(resolve);
      }),
  );
  const address = server.address();
  return {
    ...context,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

function initializeCapital(repository, options = {}) {
  repository.initializeCapital(
    options.principal ?? 100000,
    options.date ?? '2026-09-01',
    'test',
  );
}

module.exports = {
  createTestContext,
  initializeCapital,
  requestJson,
  startTestServer,
};
