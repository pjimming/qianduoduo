'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const {
  evaluateApiPayloads,
  evaluateRuntimeChecks,
  parseArgs,
  processIsAlive,
  requestJson,
} = require('../scripts/yield-verify.cjs');
const {
  requestJson: fetchJson,
  startTestServer,
} = require('./helpers/test-context');

const execFileAsync = promisify(execFile);

function databaseSnapshot(repository) {
  const tables = repository.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  return Object.fromEntries(
    tables.map((table) => [
      table,
      repository.db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );
}

function createRuntimeFixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'r2-yield-verify-runtime-'),
  );
  fs.mkdirSync(path.join(root, 'run'), { recursive: true });
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'run', 'daemon.pid'), `${process.pid}\n`);
  fs.writeFileSync(path.join(root, 'run', 'server.pid'), `${process.pid}\n`);
  fs.writeFileSync(
    path.join(root, 'logs', 'server-20261025-120000.err.log'),
    '',
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('yield verifier arguments and HTTP helper are read-only', async () => {
  const options = parseArgs([
    '--base-url',
    'http://127.0.0.1:8765/',
    '--root',
    '.',
    '--timeout-ms',
    '2500',
    '--verbose',
    '--json',
  ]);
  assert.equal(options.baseUrl, 'http://127.0.0.1:8765');
  assert.equal(options.timeoutMs, 2500);
  assert.equal(options.json, true);
  assert.equal(options.verbose, true);
  assert.throws(() => parseArgs(['--unknown']), /未知参数/);

  const calls = [];
  const result = await requestJson(
    'http://127.0.0.1:9',
    '/api/health',
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          async text() {
            return '{"ok":true}';
          },
        };
      },
    },
  );
  assert.deepEqual(result.body, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].url, 'http://127.0.0.1:9/api/health');
});

test('runtime checks reject stale or dirty production markers', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'r2-yield-verify-dirty-'),
  );
  fs.mkdirSync(path.join(root, 'run'), { recursive: true });
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'run', 'daemon.pid'), `${process.pid}\n`);
  fs.writeFileSync(path.join(root, 'run', 'server.pid'), '999999\n');
  fs.writeFileSync(path.join(root, 'run', 'server.stop'), '');
  fs.writeFileSync(
    path.join(root, 'logs', 'server-20261025-120000.err.log'),
    'error\n',
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = evaluateRuntimeChecks(root);
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((item) => item.name === 'Server PID 有效'),
  );
  assert.ok(
    result.failures.some(
      (item) => item.name === 'run/server.stop 不存在',
    ),
  );
  assert.ok(
    result.failures.some((item) => item.name === '最新 stderr 为空'),
  );
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(0), false);
});

test('yield verifier rejects alias and cash target regressions', async (t) => {
  const context = await startTestServer(t);
  const health = await fetchJson(`${context.baseUrl}/api/health`);
  const products = await fetchJson(
    `${context.baseUrl}/api/dashboard/products`,
  );
  const overview = await fetchJson(
    `${context.baseUrl}/api/dashboard/sections?include=overview`,
  );
  const evaluation = await fetchJson(
    `${context.baseUrl}/api/dashboard/sections?include=evaluation`,
  );
  const payloads = {
    health: health.body,
    products: products.body,
    overview: overview.body,
    evaluation: evaluation.body,
  };
  assert.equal(evaluateApiPayloads(payloads).ok, true);

  const aliasBroken = structuredClone(payloads);
  const scored = aliasBroken.products.products.all.find(
    (product) => product.reference_yield_pct !== null,
  );
  assert.ok(scored);
  scored.weighted_yield_pct = scored.reference_yield_pct + 1;
  const aliasResult = evaluateApiPayloads(aliasBroken);
  assert.equal(aliasResult.ok, false);
  assert.ok(
    aliasResult.failures.some(
      (item) => item.name === '兼容年化字段是参考年化 alias',
    ),
  );

  const cashBroken = structuredClone(payloads);
  const cash = cashBroken.products.products.all.find(
    (product) => product.bucket === 'cash',
  );
  assert.ok(cash);
  cash.selected = true;
  cash.target_amount = 1000;
  const cashResult = evaluateApiPayloads(cashBroken);
  assert.equal(cashResult.ok, false);
  assert.ok(
    cashResult.failures.some(
      (item) => item.name === 'cash 产品无评分、排名、目标和提案资格',
    ),
  );

  const cashProposalBroken = structuredClone(payloads);
  const cashForProposal = cashProposalBroken.products.products.all.find(
    (item) => item.bucket === 'cash',
  );
  assert.ok(cashForProposal);
  cashProposalBroken.evaluation.decision_proposals.proposals.push({
    id: 999,
    status: 'pending',
    proposal_type: 'cash_allocation',
    product_code: cashForProposal.code,
    target_product_code: '',
    yield_policy_version: 'r2-term-yield-v1',
    dedupe_key: `allocation:${cashForProposal.code}:2026-10-25:1:yield-policy:r2-term-yield-v1`,
    payload: {
      yield_policy: {
        version: 'r2-term-yield-v1',
        product: {
          product_code: cashForProposal.code,
          product_name: cashForProposal.name,
          yield_policy_version: 'r2-term-yield-v1',
          status: cashForProposal.reference_yield_status,
          reason: cashForProposal.reference_yield_reason,
          available_horizons:
            cashForProposal.reference_available_horizons,
          normalized_weights:
            cashForProposal.reference_normalized_weights,
        },
      },
    },
  });
  const cashProposalResult = evaluateApiPayloads(cashProposalBroken);
  assert.equal(cashProposalResult.ok, false);
  assert.ok(
    cashProposalResult.failures.some(
      (item) => item.name === 'cash 产品从不生成决策提案',
    ),
  );

  const countsBroken = structuredClone(payloads);
  const brokenEvidence = countsBroken.products.products.stats.evidence_counts;
  const fromTier = Object.keys(brokenEvidence).find(
    (tier) => brokenEvidence[tier] > 0,
  );
  const toTier = Object.keys(brokenEvidence).find(
    (tier) => tier !== fromTier,
  );
  assert.ok(fromTier);
  assert.ok(toTier);
  brokenEvidence[fromTier] -= 1;
  brokenEvidence[toTier] += 1;
  const countsResult = evaluateApiPayloads(countsBroken);
  assert.equal(countsResult.ok, false);
  assert.ok(
    countsResult.failures.some(
      (item) => item.name === '五档证据计数与产品明细一致',
    ),
  );

  const selectedBroken = structuredClone(payloads);
  const hiddenSelected = selectedBroken.products.products.all.find(
    (product) => !product.selected && product.bucket !== 'cash',
  );
  assert.ok(hiddenSelected);
  hiddenSelected.selected = true;
  hiddenSelected.selection_rank = 99;
  hiddenSelected.target_amount = 1000;
  const selectedResult = evaluateApiPayloads(selectedBroken);
  assert.equal(selectedResult.ok, false);
  assert.ok(
    selectedResult.failures.some(
      (item) => item.name === '产品 selected 标记与 watchlist 完全一致',
    ),
  );

  const weightsBroken = structuredClone(payloads);
  const weightedProduct = weightsBroken.products.products.all.find(
    (product) =>
      product.reference_yield_status === 'available' &&
      Object.keys(product.reference_normalized_weights || {}).length > 0,
  );
  assert.ok(weightedProduct);
  const firstWeightKey = Object.keys(
    weightedProduct.reference_normalized_weights,
  )[0];
  weightedProduct.reference_normalized_weights[firstWeightKey] = -1;
  const weightsResult = evaluateApiPayloads(weightsBroken);
  assert.equal(weightsResult.ok, false);
  assert.ok(
    weightsResult.failures.some(
      (item) => item.name === '可用/不可用产品字段语义一致',
    ),
  );

  const unavailableBroken = structuredClone(payloads);
  const unavailable = unavailableBroken.products.products.all.find(
    (product) => product.reference_yield_status === 'unavailable',
  );
  assert.ok(unavailable);
  unavailable.reference_yield_pct = 9;
  unavailable.observation_score = 9;
  unavailable.selection_score = 9;
  const unavailableResult = evaluateApiPayloads(unavailableBroken);
  assert.equal(unavailableResult.ok, false);
  assert.ok(
    unavailableResult.failures.some(
      (item) => item.name === '可用/不可用产品字段语义一致',
    ),
  );
});

test('npm-compatible verifier passes against an isolated read-only server', async (t) => {
  const context = await startTestServer(t);
  const runtimeRoot = createRuntimeFixture(t);
  const before = databaseSnapshot(context.repository);
  const scriptPath = path.resolve(__dirname, '../scripts/yield-verify.cjs');
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      scriptPath,
      '--base-url',
      context.baseUrl,
      '--root',
      runtimeRoot,
      '--json',
    ],
    {
      cwd: path.resolve(__dirname, '..'),
      timeout: 20000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.summary.failed, 0);
  assert.equal(result.runtime.stop_marker, false);
  assert.equal(result.runtime.latest_stderr_bytes, 0);
  assert.ok(result.observability.products.total > 0);
  assert.deepEqual(databaseSnapshot(context.repository), before);
});
