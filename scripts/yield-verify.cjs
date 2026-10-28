#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXPECTED = Object.freeze({
  health_path: '/api/health',
  products_path: '/api/dashboard/products',
  overview_path: '/api/dashboard/sections?include=overview',
  evaluation_path: '/api/dashboard/sections?include=evaluation',
  selection_version: 'r2-dynamic-v4',
  yield_policy_version: 'r2-term-yield-v1',
  front_load_scheme: 'B',
  reference_weights: Object.freeze({
    cash: Object.freeze({ return_1m: 0.7, return_3m: 0.3 }),
    short: Object.freeze({
      return_1m: 0.2,
      return_3m: 0.5,
      return_6m: 0.3,
    }),
    medium: Object.freeze({
      return_3m: 0.5,
      return_6m: 0.3,
      return_1y: 0.2,
    }),
    long: Object.freeze({
      return_3m: 0.2,
      return_6m: 0.4,
      return_1y: 0.4,
    }),
  }),
  evidence_tiers: Object.freeze([
    'full_1y',
    'six_month',
    'three_month',
    'one_month',
    'no_data',
  ]),
  attribution_statuses: Object.freeze([
    'available',
    'partial',
    'insufficient',
  ]),
  attribution_reasons: Object.freeze([
    'complete_history',
    'partial_history',
    'no_available_horizons',
    'unknown_term',
    'no_product_snapshot',
  ]),
});

const USAGE = `用法:
  npm run yield:verify
  node scripts/yield-verify.cjs [--base-url URL] [--root PATH] [--timeout-ms N] [--json] [--verbose]

环境变量:
  R2_VERIFY_BASE_URL  默认 http://127.0.0.1:8765
  R2_VERIFY_ROOT      默认当前仓库根目录
  R2_VERIFY_TIMEOUT_MS 默认 10000

命令只执行 GET 请求和本地文件读取，不调用写接口、不打开数据库。`;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasExactKeys(value, expectedKeys) {
  if (!isObject(value)) return false;
  return sameJson(Object.keys(value).sort(), [...expectedKeys].sort());
}

function normalizedWeightsForHorizons(availableHorizons) {
  const keyByLabel = {
    '1m': 'return_1m',
    '3m': 'return_3m',
    '6m': 'return_6m',
    '1y': 'return_1y',
  };
  if (!Array.isArray(availableHorizons)) return null;
  const keys = availableHorizons.map((label) => keyByLabel[label]);
  return keys.every(Boolean) ? keys : null;
}

function validNormalizedWeights(availableHorizons, weights) {
  const expectedKeys = normalizedWeightsForHorizons(availableHorizons);
  if (!expectedKeys || !hasExactKeys(weights, expectedKeys)) return false;
  const values = Object.values(weights);
  return (
    values.every((value) => isFiniteNumber(value) && value >= 0) &&
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <=
      1e-9
  );
}

function firstInvalid(items, predicate) {
  return items.find((item) => !predicate(item)) || null;
}

function parseArgs(argv = []) {
  const options = {
    baseUrl:
      process.env.R2_VERIFY_BASE_URL || 'http://127.0.0.1:8765',
    root: process.env.R2_VERIFY_ROOT || path.resolve(__dirname, '..'),
    timeoutMs: Number(process.env.R2_VERIFY_TIMEOUT_MS || 10000),
    json: false,
    verbose: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--verbose') {
      options.verbose = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--base-url' || arg === '--root' || arg === '--timeout-ms') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} 缺少参数值`);
      }
      index += 1;
      if (arg === '--base-url') options.baseUrl = value;
      if (arg === '--root') options.root = value;
      if (arg === '--timeout-ms') options.timeoutMs = Number(value);
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  options.baseUrl = String(options.baseUrl).replace(/\/+$/, '');
  options.root = path.resolve(String(options.root));
  if (!/^https?:\/\//i.test(options.baseUrl)) {
    throw new Error('base URL 必须使用 http:// 或 https://');
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('timeout-ms 必须是正整数');
  }
  return options;
}

function createVerifier() {
  const checks = [];
  function check(name, passed, detail = '') {
    const item = {
      name,
      ok: Boolean(passed),
      detail: passed ? '' : String(detail || '断言失败'),
    };
    checks.push(item);
    return item.ok;
  }
  return {
    check,
    result() {
      const failures = checks.filter((item) => !item.ok);
      return {
        ok: failures.length === 0,
        checks,
        failures,
        summary: {
          checks: checks.length,
          passed: checks.length - failures.length,
          failed: failures.length,
        },
      };
    },
  };
}

function processIsAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readPidFile(filePath) {
  try {
    const value = Number(
      fs.readFileSync(filePath, 'utf8').trim().split(/\s+/)[0],
    );
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function latestErrorLog(root) {
  const logDir = path.join(root, 'logs');
  if (!fs.existsSync(logDir)) return null;
  const files = fs
    .readdirSync(logDir)
    .filter((name) => /^server-.*\.err\.log$/i.test(name))
    .map((name) => {
      const filePath = path.join(logDir, name);
      const stat = fs.statSync(filePath);
      return {
        name,
        path: filePath,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name),
    );
  return files[0] || null;
}

function evaluateRuntimeChecks(root, options = {}) {
  const verifier = createVerifier();
  const alive = options.isAlive || ((pid) => processIsAlive(pid));
  const daemonPidPath = path.join(root, 'run', 'daemon.pid');
  const serverPidPath = path.join(root, 'run', 'server.pid');
  const stopPath = path.join(root, 'run', 'server.stop');
  const daemonPid = readPidFile(daemonPidPath);
  const serverPid = readPidFile(serverPidPath);
  const errorLog = latestErrorLog(root);
  verifier.check('root 目录存在', fs.existsSync(root), root);
  verifier.check(
    'Supervisor PID 有效',
    Boolean(daemonPid) && alive(daemonPid),
    daemonPid ? `PID ${daemonPid}` : daemonPidPath,
  );
  verifier.check(
    'Server PID 有效',
    Boolean(serverPid) && alive(serverPid),
    serverPid ? `PID ${serverPid}` : serverPidPath,
  );
  verifier.check(
    'run/server.stop 不存在',
    !fs.existsSync(stopPath),
    stopPath,
  );
  verifier.check(
    '最新 stderr 为空',
    Boolean(errorLog) && errorLog.bytes === 0,
    errorLog
      ? `${errorLog.name} = ${errorLog.bytes} bytes`
      : '没有 server-*.err.log',
  );
  return {
    ...verifier.result(),
    runtime: {
      root,
      daemon_pid: daemonPid,
      server_pid: serverPid,
      latest_stderr: errorLog?.name || null,
      latest_stderr_bytes: errorLog?.bytes ?? null,
      stop_marker: fs.existsSync(stopPath),
    },
  };
}

function validateYieldEvidence(verifier, label, evidence) {
  verifier.check(`${label} 为对象`, isObject(evidence), label);
  if (!isObject(evidence)) return;
  verifier.check(
    `${label} 状态有效`,
    ['available', 'unavailable'].includes(evidence.status),
    String(evidence.status),
  );
  verifier.check(
    `${label} 原因有效`,
    evidence.reason === null ||
      EXPECTED.attribution_reasons.includes(evidence.reason),
    String(evidence.reason),
  );
  verifier.check(
    `${label} 可用窗口为数组`,
    Array.isArray(evidence.available_horizons),
    JSON.stringify(evidence.available_horizons),
  );
  verifier.check(
    `${label} 归一化权重为对象`,
    isObject(evidence.normalized_weights),
    JSON.stringify(evidence.normalized_weights),
  );
  verifier.check(
    `${label} 策略版本正确`,
    evidence.yield_policy_version === EXPECTED.yield_policy_version ||
      (evidence.reason === 'no_product_snapshot' &&
        evidence.yield_policy_version === null),
    String(evidence.yield_policy_version),
  );
  if (evidence.status === 'available') {
    verifier.check(
      `${label} 可用状态有数值`,
      isFiniteNumber(
        evidence.reference_yield_pct ?? evidence.yield_pct,
      ),
      JSON.stringify(evidence.reference_yield_pct ?? evidence.yield_pct),
    );
    verifier.check(
      `${label} 可用窗口与归一化权重一致`,
      validNormalizedWeights(
        evidence.available_horizons,
        evidence.normalized_weights,
      ),
      JSON.stringify({
        horizons: evidence.available_horizons,
        weights: evidence.normalized_weights,
      }),
    );
  } else {
    verifier.check(
      `${label} 不可用状态无数值`,
      (evidence.reference_yield_pct ?? evidence.yield_pct) === null,
      JSON.stringify(evidence.reference_yield_pct ?? evidence.yield_pct),
    );
    verifier.check(
      `${label} 不可用状态窗口和权重为空`,
      sameJson(evidence.available_horizons, []) &&
        sameJson(evidence.normalized_weights, {}),
      JSON.stringify({
        horizons: evidence.available_horizons,
        weights: evidence.normalized_weights,
      }),
    );
  }
}

function validateAttribution(verifier, label, attribution) {
  verifier.check(`${label} 为对象`, isObject(attribution), label);
  if (!isObject(attribution)) return;
  verifier.check(
    `${label} 状态有效`,
    EXPECTED.attribution_statuses.includes(attribution.status),
    String(attribution.status),
  );
  verifier.check(
    `${label} 周期覆盖率有效`,
    isFiniteNumber(attribution.period?.coverage_pct) &&
      attribution.period.coverage_pct >= 0 &&
      attribution.period.coverage_pct <= 100,
    JSON.stringify(attribution.period?.coverage_pct),
  );
  const evidence = attribution.product_evidence;
  verifier.check(
    `${label} 产品证据结构有效`,
    isObject(evidence) && Array.isArray(evidence.products),
    label,
  );
  if (!isObject(evidence) || !Array.isArray(evidence.products)) return;
  verifier.check(
    `${label} 账户收益与 daily_pnl 闭合`,
    isFiniteNumber(evidence.account_pnl) &&
      (attribution.actual?.observed_period_pnl === null
        ? evidence.account_pnl === 0
        : isFiniteNumber(attribution.actual?.observed_period_pnl) &&
          Math.abs(
            evidence.account_pnl -
              attribution.actual.observed_period_pnl,
          ) <= 0.01),
    `${evidence.account_pnl} vs ${attribution.actual?.observed_period_pnl}`,
  );
  verifier.check(
    `${label} 覆盖度与完整性字段有效`,
    isFiniteNumber(evidence.reference_yield_coverage_pct) &&
      evidence.reference_yield_coverage_pct >= 0 &&
      evidence.reference_yield_coverage_pct <= 100 &&
      typeof evidence.reference_yield_complete === 'boolean',
    `${evidence.reference_yield_coverage_pct}, ${evidence.reference_yield_complete}`,
  );
  for (const product of evidence.products) {
    const productLabel = `${label}/${product.product_code || '未知产品'}`;
    verifier.check(
      `${productLabel} 状态有效`,
      ['available', 'unavailable'].includes(
        product.reference_yield_status,
      ),
      String(product.reference_yield_status),
    );
    verifier.check(
      `${productLabel} 原因有效`,
      product.reference_yield_reason === null ||
        EXPECTED.attribution_reasons.includes(
          product.reference_yield_reason,
        ),
      String(product.reference_yield_reason),
    );
    verifier.check(
      `${productLabel} 可用窗口为数组`,
      Array.isArray(product.reference_available_horizons),
      JSON.stringify(product.reference_available_horizons),
    );
    verifier.check(
      `${productLabel} 归一化权重为对象`,
      isObject(product.reference_normalized_weights),
      JSON.stringify(product.reference_normalized_weights),
    );
    verifier.check(
      `${productLabel} 策略版本有效`,
      product.reference_yield_policy_version ===
        EXPECTED.yield_policy_version ||
        (product.reference_yield_reason === 'no_product_snapshot' &&
          product.reference_yield_policy_version === null),
      String(product.reference_yield_policy_version),
    );
    if (product.reference_yield_status === 'unavailable') {
      verifier.check(
        `${productLabel} 不可用时不回退数值`,
        product.reference_yield_pct === null &&
          product.reference_pnl === null &&
          product.selection_estimate_pnl === null &&
          product.actual_vs_reference_pnl === null,
        `${product.reference_yield_pct}, ${product.reference_pnl}, ${product.selection_estimate_pnl}, ${product.actual_vs_reference_pnl}`,
      );
    } else {
      verifier.check(
        `${productLabel} 可用状态有数值`,
        product.reference_yield_status === 'available' &&
          isFiniteNumber(product.reference_yield_pct),
        String(product.reference_yield_pct),
      );
      verifier.check(
        `${productLabel} 实际收益与期望收益差额正确`,
        isFiniteNumber(product.actual_vs_reference_pnl) &&
          Math.abs(
            product.actual_vs_reference_pnl -
              (product.recorded_product_pnl - product.reference_pnl),
          ) <= 0.01,
        `${product.recorded_product_pnl} - ${product.reference_pnl} vs ${product.actual_vs_reference_pnl}`,
      );
    }
    const hasHoldingPeriod =
      isFiniteNumber(product.holding_days_amount) &&
      product.holding_days_amount > 0;
    verifier.check(
      `${productLabel} 实际收益与3%目标差额正确`,
      hasHoldingPeriod
        ? isFiniteNumber(product.actual_vs_target_pnl) &&
            Math.abs(
              product.actual_vs_target_pnl -
                (product.recorded_product_pnl - product.target_pnl),
            ) <= 0.01
        : product.actual_vs_target_pnl === null,
      `${product.recorded_product_pnl} - ${product.target_pnl} vs ${product.actual_vs_target_pnl}`,
    );
  }
}

function evaluateApiPayloads({
  health,
  products,
  overview,
  evaluation,
}) {
  const verifier = createVerifier();
  verifier.check(
    'Health OK',
    health?.ok === true,
    JSON.stringify(health),
  );

  const productView = products?.products;
  verifier.check(
    'products 接口结构有效',
    isObject(productView) &&
      Array.isArray(productView.all) &&
      Array.isArray(productView.watchlist) &&
      Array.isArray(productView.observation_list) &&
      isObject(productView.selection) &&
      isObject(productView.stats),
    'products payload',
  );
  if (!isObject(productView) || !Array.isArray(productView.all)) {
    return verifier.result();
  }

  const selection = productView.selection;
  const stats = productView.stats;
  const all = productView.all;
  const watchlist = productView.watchlist;
  const observationList = productView.observation_list;
  const countedEvidence = Object.fromEntries(
    EXPECTED.evidence_tiers.map((tier) => [tier, 0]),
  );
  const countedReferenceStatus = { available: 0, unavailable: 0 };
  const countedBuckets = { cash: 0, short: 0, medium: 0, long: 0 };
  const countedScoredBuckets = { cash: 0, short: 0, medium: 0, long: 0 };
  for (const product of all) {
    if (Object.hasOwn(countedEvidence, product.evidence_tier)) {
      countedEvidence[product.evidence_tier] += 1;
    }
    if (Object.hasOwn(countedReferenceStatus, product.reference_yield_status)) {
      countedReferenceStatus[product.reference_yield_status] += 1;
    }
    if (Object.hasOwn(countedBuckets, product.bucket)) {
      countedBuckets[product.bucket] += 1;
    }
    if (product.observation_ready && Object.hasOwn(countedScoredBuckets, product.bucket)) {
      countedScoredBuckets[product.bucket] += 1;
    }
  }
  verifier.check(
    '选择版本 r2-dynamic-v4',
    selection.version === EXPECTED.selection_version,
    String(selection.version),
  );
  verifier.check(
    '收益策略版本 r2-term-yield-v1',
    selection.yield_policy_version === EXPECTED.yield_policy_version,
    String(selection.yield_policy_version),
  );
  verifier.check(
    '前视扣分方案 B',
    selection.front_load_scheme === EXPECTED.front_load_scheme,
    String(selection.front_load_scheme),
  );
  verifier.check(
    '四桶参考权重固定',
    sameJson(selection.reference_weights, EXPECTED.reference_weights),
    JSON.stringify(selection.reference_weights),
  );
  verifier.check(
    '产品总数与明细一致',
    isNonNegativeInteger(stats.total) &&
      stats.total === all.length &&
      stats.total > 0,
    `${stats.total} vs ${all.length}`,
  );
  verifier.check(
    '产品代码唯一',
    new Set(all.map((product) => product.code)).size === all.length,
    'duplicate product code',
  );
  verifier.check(
    '五档证据计数与产品明细一致',
    hasExactKeys(stats.evidence_counts, EXPECTED.evidence_tiers) &&
      sameJson(stats.evidence_counts, countedEvidence),
    JSON.stringify(stats.evidence_counts),
  );
  verifier.check(
    '参考状态计数与产品明细一致',
    hasExactKeys(stats.reference_status_counts, [
      'available',
      'unavailable',
    ]) &&
      sameJson(stats.reference_status_counts, countedReferenceStatus),
    JSON.stringify(stats.reference_status_counts),
  );
  verifier.check(
    '研究池期限计数与产品明细一致',
    hasExactKeys(stats.bucket_counts, [
      'cash',
      'short',
      'medium',
      'long',
    ]) &&
      sameJson(stats.bucket_counts, countedBuckets),
    JSON.stringify(stats.bucket_counts),
  );
  verifier.check(
    '可评分期限计数与产品明细一致',
    hasExactKeys(stats.scored_bucket_counts, [
      'cash',
      'short',
      'medium',
      'long',
    ]) &&
      sameJson(stats.scored_bucket_counts, countedScoredBuckets),
    JSON.stringify(stats.scored_bucket_counts),
  );
  verifier.check(
    '可评分总数与产品明细一致',
    isNonNegativeInteger(stats.observation_ready) &&
      all.filter((product) => product.observation_ready).length ===
        stats.observation_ready,
    `${stats.observation_ready}`,
  );
  const aliasMismatch = firstInvalid(
    all,
    (product) =>
      product.weighted_yield_pct === product.reference_yield_pct,
  );
  verifier.check(
    '兼容年化字段是参考年化 alias',
    !aliasMismatch,
    aliasMismatch
      ? `${aliasMismatch.code}: ${aliasMismatch.weighted_yield_pct} != ${aliasMismatch.reference_yield_pct}`
      : '',
  );
  const policyMismatch = firstInvalid(
    all,
    (product) =>
      product.yield_policy_version === selection.yield_policy_version,
  );
  verifier.check(
    '所有产品带同一收益策略版本',
    !policyMismatch,
    policyMismatch
      ? `${policyMismatch.code}: ${policyMismatch.yield_policy_version}`
      : '',
  );
  const statusMismatch = firstInvalid(all, (product) => {
    if (product.reference_yield_status === 'available') {
      return (
        isFiniteNumber(product.reference_yield_pct) &&
        Array.isArray(product.reference_available_horizons) &&
        product.reference_available_horizons.length > 0 &&
        validNormalizedWeights(
          product.reference_available_horizons,
          product.reference_normalized_weights,
        )
      );
    }
    return (
      product.reference_yield_pct === null &&
      product.observation_score === null &&
      product.selection_score === null &&
      product.observation_ready === false &&
      Array.isArray(product.reference_available_horizons) &&
      product.reference_available_horizons.length === 0 &&
      isObject(product.reference_normalized_weights) &&
      Object.keys(product.reference_normalized_weights).length === 0
    );
  });
  verifier.check(
    '可用/不可用产品字段语义一致',
    !statusMismatch,
    statusMismatch?.code || '',
  );

  const cashProducts = all.filter((product) => product.bucket === 'cash');
  const cashCodes = new Set(cashProducts.map((product) => product.code));
  const cashBad = firstInvalid(
    cashProducts,
    (product) =>
      product.term_days === 0 &&
      product.observation_ready === false &&
      product.evidence_automatic === false &&
      product.observation_score === null &&
      product.selection_score === null &&
      product.selected === false &&
      product.selection_rank === null &&
      product.target_amount === 0 &&
      product.target_pct === 0 &&
      product.allocation_bucket === null,
  );
  verifier.check(
    'cash 产品无评分、排名、目标和提案资格',
    !cashBad,
    cashBad?.code || '',
  );
  verifier.check(
    'cash 不进入 watchlist',
    watchlist.every((product) => !cashCodes.has(product.code)),
    watchlist
      .filter((product) => cashCodes.has(product.code))
      .map((product) => product.code)
      .join(','),
  );
  verifier.check(
    'cash 不进入观察名单',
    observationList.every((product) => !cashCodes.has(product.code)),
    observationList
      .filter((product) => cashCodes.has(product.code))
      .map((product) => product.code)
      .join(','),
  );
  verifier.check(
    'watchlist 标记、数量与目标金额一致',
    watchlist.length === stats.selected_count &&
      watchlist.every(
        (product) =>
          product.selected === true &&
          product.observation_ready === true &&
          product.target_amount > 0,
      ),
    `${watchlist.length} vs ${stats.selected_count}`,
  );
  const selectedProducts = all.filter((product) => product.selected);
  const watchlistCodes = new Set(watchlist.map((product) => product.code));
  verifier.check(
    '产品 selected 标记与 watchlist 完全一致',
    selectedProducts.length === watchlist.length &&
      selectedProducts.every((product) => watchlistCodes.has(product.code)) &&
      selectedProducts.every(
        (product) =>
          Number.isInteger(product.selection_rank) &&
          product.selection_rank > 0,
      ) &&
      all
        .filter((product) => !product.selected)
        .every((product) => product.selection_rank === null),
    `selected=${selectedProducts.length}, watchlist=${watchlist.length}`,
  );

  const holdingReviews = products?.workspace?.holding_reviews;
  verifier.check(
    '持仓复核结构有效',
    Array.isArray(holdingReviews) &&
      products.workspace?.holding_reviews_summary?.total ===
        holdingReviews.length,
    Array.isArray(holdingReviews)
      ? `${holdingReviews.length}`
      : 'not array',
  );
  if (Array.isArray(holdingReviews)) {
    for (const review of holdingReviews) {
      const label = `持仓复核/${review.product_code}`;
      verifier.check(
        `${label} 规则与策略版本正确`,
        review.review_version === 'r2-holding-review-v7' &&
          review.yield_policy_version === EXPECTED.yield_policy_version,
        `${review.review_version}, ${review.yield_policy_version}`,
      );
      validateYieldEvidence(verifier, `${label}/当前`, {
        ...review.current,
        reference_yield_pct: review.current?.yield_pct,
        available_horizons: review.current?.yield_available_horizons,
        normalized_weights: review.current?.yield_normalized_weights,
        status: review.current?.yield_status,
        reason: review.current?.yield_reason,
        yield_policy_version: review.current?.yield_policy_version,
      });
      for (const candidate of review.candidates || []) {
        verifier.check(
          `${label}/候选 ${candidate.code} 不是 cash`,
          candidate.bucket !== 'cash' &&
            !cashCodes.has(candidate.code),
          candidate.code,
        );
        validateYieldEvidence(verifier, `${label}/候选 ${candidate.code}`, {
          ...candidate,
          reference_yield_pct: candidate.yield_pct,
          available_horizons: candidate.yield_available_horizons,
          normalized_weights: candidate.yield_normalized_weights,
          status: candidate.yield_status,
          reason: candidate.yield_reason,
          yield_policy_version: candidate.yield_policy_version,
        });
      }
    }
  }

  const overviewAttribution =
    overview?.workspace?.return_attribution;
  const evaluationAttribution =
    evaluation?.workspace?.return_attribution;
  validateAttribution(verifier, 'overview 收益归因', overviewAttribution);
  validateAttribution(
    verifier,
    'evaluation 收益归因',
    evaluationAttribution,
  );
  verifier.check(
    'overview/evaluation 收益归因一致',
    isObject(overviewAttribution) &&
      isObject(evaluationAttribution) &&
      overviewAttribution.status === evaluationAttribution.status &&
      overviewAttribution.period?.coverage_pct ===
        evaluationAttribution.period?.coverage_pct &&
      overviewAttribution.product_evidence?.products?.length ===
        evaluationAttribution.product_evidence?.products?.length,
    `${overviewAttribution?.status} vs ${evaluationAttribution?.status}`,
  );

  const decisionProposals = evaluation?.decision_proposals;
  verifier.check(
    'evaluation/提案结构有效',
    Array.isArray(evaluation?.workspace?.decisions) &&
      isObject(evaluation?.automation) &&
      Array.isArray(evaluation?.automation?.pending_evaluations) &&
      isObject(decisionProposals) &&
      Array.isArray(decisionProposals.proposals) &&
      isObject(decisionProposals.summary),
    'evaluation payload',
  );
  const proposals = decisionProposals?.proposals || [];
  const activeProposals = proposals.filter((proposal) =>
    ['pending', 'accepted'].includes(proposal.status),
  );
  for (const proposal of activeProposals) {
    const label = `提案/${proposal.id}`;
    verifier.check(
      `${label} 策略版本正确`,
      proposal.yield_policy_version ===
        EXPECTED.yield_policy_version &&
        String(proposal.dedupe_key).includes(
          `yield-policy:${EXPECTED.yield_policy_version}`,
        ),
      `${proposal.yield_policy_version}, ${proposal.dedupe_key}`,
    );
    const policy = proposal.payload?.yield_policy;
    const evidence = [
      policy?.current,
      policy?.candidate,
      policy?.product,
    ].filter(Boolean);
    verifier.check(
      `${label} 冻结收益口径完整`,
      isObject(policy) &&
        policy.version === EXPECTED.yield_policy_version &&
        evidence.length > 0,
      JSON.stringify(policy),
    );
    for (const item of evidence) {
      validateYieldEvidence(verifier, `${label} 冻结收益口径`, item);
    }
  }
  const cashProposal = activeProposals.find(
    (proposal) =>
      cashCodes.has(proposal.product_code) ||
      cashCodes.has(proposal.target_product_code),
  );
  verifier.check(
    'cash 产品从不生成决策提案',
    !cashProposal,
    cashProposal
      ? `proposal ${cashProposal.id}: ${cashProposal.product_code}/${cashProposal.target_product_code}`
      : '',
  );

  return {
    ...verifier.result(),
    observability: {
      products: {
        total: stats.total,
        observation_ready: stats.observation_ready,
        selected_count: stats.selected_count,
        evidence_counts: stats.evidence_counts,
        reference_status_counts: stats.reference_status_counts,
      },
      holding_reviews: Array.isArray(holdingReviews)
        ? holdingReviews.length
        : null,
      return_attribution: {
        status: overviewAttribution?.status ?? null,
        product_count:
          overviewAttribution?.product_evidence?.products?.length ?? null,
        coverage_pct:
          overviewAttribution?.product_evidence
            ?.reference_yield_coverage_pct ?? null,
      },
      proposals: decisionProposals?.summary || null,
    },
  };
}

async function requestJson(
  baseUrl,
  requestPath,
  {
    fetchImpl = fetch,
    timeoutMs = 10000,
  } = {},
) {
  const url = new URL(requestPath, `${baseUrl}/`).toString();
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${requestPath} HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    return { url, body: text ? JSON.parse(text) : null };
  } catch {
    throw new Error(`${requestPath} 返回了非 JSON 内容`);
  }
}

async function verifyTarget(options, dependencies = {}) {
  const runtime = evaluateRuntimeChecks(options.root, {
    isAlive: dependencies.isAlive,
  });
  const fetchOptions = {
    fetchImpl: dependencies.fetchImpl || fetch,
    timeoutMs: options.timeoutMs,
  };
  const requests = {};
  const requestChecks = [];
  for (const [key, requestPath] of Object.entries({
    health: EXPECTED.health_path,
    products: EXPECTED.products_path,
    overview: EXPECTED.overview_path,
    evaluation: EXPECTED.evaluation_path,
  })) {
    try {
      const result = await requestJson(
        options.baseUrl,
        requestPath,
        fetchOptions,
      );
      requests[key] = result.body;
      requestChecks.push({
        name: `${requestPath} 可读取`,
        ok: true,
        detail: '',
      });
    } catch (error) {
      requestChecks.push({
        name: `${requestPath} 可读取`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const api = evaluateApiPayloads({
    health: requests.health,
    products: requests.products,
    overview: requests.overview,
    evaluation: requests.evaluation,
  });
  const checks = [...runtime.checks, ...requestChecks, ...api.checks];
  const failures = checks.filter((item) => !item.ok);
  return {
    ok: failures.length === 0,
    generated_at: new Date().toISOString(),
    base_url: options.baseUrl,
    root: options.root,
    checks,
    failures,
    summary: {
      checks: checks.length,
      passed: checks.length - failures.length,
      failed: failures.length,
    },
    runtime: runtime.runtime,
    observability: api.observability || null,
  };
}

function printHuman(result, options = {}) {
  if (options.verbose) {
    for (const item of result.checks) {
      const prefix = item.ok ? '[ok]' : '[FAIL]';
      console.log(
        `${prefix} ${item.name}${item.detail ? ` · ${item.detail}` : ''}`,
      );
    }
  } else if (result.failures.length) {
    for (const item of result.failures) {
      console.log(`[FAIL] ${item.name}${item.detail ? ` · ${item.detail}` : ''}`);
    }
  } else {
    console.log(`[ok] ${result.summary.checks} 项只读验收全部通过`);
  }
  const observation = result.observability;
  if (observation) {
    console.log(
      `产品：${observation.products.total} 只，可评分 ${observation.products.observation_ready} 只，观察 ${observation.products.selected_count} 只`,
    );
    console.log(
      `持仓复核：${observation.holding_reviews ?? 0} 条；收益归因：${observation.return_attribution.status || '无'}（${observation.return_attribution.product_count ?? 0} 个产品证据）`,
    );
  }
  console.log(
    `运行状态：Supervisor ${result.runtime.daemon_pid || '缺失'} · Server ${result.runtime.server_pid || '缺失'} · stderr ${result.runtime.latest_stderr_bytes ?? '缺失'} bytes · stop marker ${result.runtime.stop_marker ? '存在' : '不存在'}`,
  );
  console.log(
    `结果：${result.summary.passed}/${result.summary.checks} 通过，${result.summary.failed} 失败`,
  );
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const result = await verifyTarget(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result, options);
  }
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

module.exports = {
  EXPECTED,
  USAGE,
  createVerifier,
  evaluateApiPayloads,
  evaluateRuntimeChecks,
  main,
  parseArgs,
  processIsAlive,
  requestJson,
  validateAttribution,
  verifyTarget,
};
