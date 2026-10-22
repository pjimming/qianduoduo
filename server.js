'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const { URL } = require('node:url');
const { openDatabase } = require('./lib/db');
const {
  createDailyBackup,
  defaultBackupDir,
  listBackups,
  pruneBackups,
} = require('./lib/backup');
const {
  TARGET_ANNUALIZED,
  buildReview,
  buildWindows,
  enrichRecords,
  parseYmd,
  shiftDate,
  summarize,
  todayShanghai,
} = require('./lib/metrics');
const { buildProductView } = require('./lib/products');
const {
  DAILY_OPEN_TARGET_PCT,
  TARGET3_STRATEGY_VERSION,
  normalizeDecisionBucketPlan,
  validateDecisionBucketPolicy,
} = require('./lib/r2-policy');
const { buildHoldingReviews } = require('./lib/holdings-review');
const { shiftMonth } = require('./lib/review-store');
const { parseTradeText } = require('./lib/trade-parser');
const { parseIncomeText } = require('./lib/income-parser');
const { ocrImage } = require('./lib/ocr');

const ROOT = __dirname;
const DIST_DIR = path.join(ROOT, 'dist');
const PUBLIC_DIR = path.join(ROOT, 'public');
const STATIC_DIR = fs.existsSync(path.join(DIST_DIR, 'index.html')) ? DIST_DIR : PUBLIC_DIR;
const DEFAULT_DB = path.join(ROOT, 'data', 'r2_ledger.sqlite');
const ACTIONS = new Set(['无操作', '买入', '赎回', '切换']);
const DECISION_ACTIONS = new Set(['买入', '赎回', '切换', '观察']);
const DECISION_RATINGS = new Set([
  '待评估',
  '流程正确，结果好',
  '流程正确，结果差',
  '流程错误，结果好',
  '流程错误，结果差',
]);
const EVENT_TYPES = new Set(['费率', '经理', '底层', '赎回规则', '额度', '其他']);
const EVENT_IMPACTS = new Set(['低', '中', '高']);
const EVENT_STATUSES = new Set(['待复核', '已处理']);
const TRADE_TYPES = new Set(['buy', 'redeem', 'switch']);
const TRADE_STATUSES = new Set(['pending', 'confirmed', 'cancelled']);
const IMAGE_MIME_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
};

const HTML_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/**
 * 产品候选池按文件名中的日期自动取最新一份；也可以用 R2_PRODUCT_CSV 指定。
 * 优先读取普通可买 universe，旧版精选 products 文件作为回退。
 */
function resolveProductCsv(rootDir = ROOT) {
  if (process.env.R2_PRODUCT_CSV) {
    return path.resolve(process.env.R2_PRODUCT_CSV);
  }
  const dataDir = path.join(rootDir, 'data');
  if (!fs.existsSync(dataDir)) {
    return path.join(dataDir, 'cmb_r2_universe.csv');
  }
  const newest = (pattern) =>
    fs
      .readdirSync(dataDir)
      .filter((name) => pattern.test(name))
      .map((name) => {
        const filePath = path.join(dataDir, name);
        const match = /(\d{4}-\d{2}-\d{2})/.exec(name);
        return {
          filePath,
          date: match ? match[1] : '',
          mtime: fs.statSync(filePath).mtimeMs,
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date) || b.mtime - a.mtime)[0]?.filePath;

  return (
    newest(/^cmb_r2_universe.*\.csv$/i) ||
    newest(/^cmb_r2_products.*\.csv$/i) ||
    path.join(dataDir, 'cmb_r2_universe.csv')
  );
}

const DEFAULT_PRODUCT_CSV = resolveProductCsv(ROOT);

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  response.end(body);
}

function sendError(response, statusCode, message, details = null) {
  sendJson(response, statusCode, {
    error: message,
    ...(details ? { details } : {}),
  });
}

function readJsonBody(request, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const contentType = String(request.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      request.resume();
      const error = new Error('请求需要 application/json');
      error.statusCode = 415;
      reject(error);
      return;
    }
    let body = '';
    let size = 0;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        const error = new Error('请求内容过大');
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('请求不是有效的 JSON'));
      }
    });
    request.on('error', reject);
  });
}

/**
 * 本地服务仍然会暴露给浏览器里的任意页面：写请求必须来自同源页面，
 * 否则一个外部网页就能借用户浏览器改动账本。
 */
function isAllowedOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}

function validateRecordPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '记录格式不正确' };
  }
  const today = options.today || todayShanghai();
  const date = String(payload.date ?? options.date ?? '').trim();
  if (!parseYmd(date)) {
    return { error: '日期格式应为 YYYY-MM-DD' };
  }
  if (date > today) {
    return { error: '不能记录未来日期' };
  }
  if (date < '2000-01-01') {
    return { error: '日期过早，请检查是否填写正确' };
  }

  const dailyPnl = Number(payload.daily_pnl);
  if (!Number.isFinite(dailyPnl) || Math.abs(dailyPnl) > 1e9) {
    return { error: '当日收益需要是有效数字，亏损请填负数' };
  }

  const action = String(payload.action || '无操作').trim();
  if (!ACTIONS.has(action)) {
    return { error: '操作类型不在允许范围内' };
  }

  const notes = String(payload.notes || '').trim();
  if (notes.length > 500) {
    return { error: '备注不能超过 500 个字符' };
  }

  return {
    value: {
      date,
      daily_pnl: Math.round(dailyPnl * 100) / 100,
      action,
      notes,
    },
  };
}

function validateCapitalInitPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '本金初始化格式不正确' };
  }
  const today = todayShanghai();
  const date = String(payload.initial_date || '').trim();
  if (!parseYmd(date)) return { error: '起始日期格式应为 YYYY-MM-DD' };
  if (date > today) return { error: '起始日期不能晚于今天' };
  const amount = Number(payload.initial_principal);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) {
    return { error: '起始本金需要是大于 0 的数字' };
  }
  return {
    value: {
      initial_principal: Math.round(amount * 100) / 100,
      initial_date: date,
    },
  };
}

function validateCapitalEventPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '资金变动格式不正确' };
  }
  const today = todayShanghai();
  const date = String(payload.event_date || '').trim();
  if (!parseYmd(date)) return { error: '转入/转出日期格式应为 YYYY-MM-DD' };
  if (date > today) return { error: '不能记录未来的转入/转出' };
  const type = String(payload.event_type || '').trim();
  if (!['deposit', 'withdraw'].includes(type)) {
    return { error: '资金变动类型必须是转入或转出' };
  }
  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) {
    return { error: '转入/转出金额需要是大于 0 的数字' };
  }
  const note = String(payload.note || '').trim();
  if (note.length > 200) return { error: '本金变动备注不能超过 200 个字符' };
  return {
    value: {
      date,
      type,
      amount: Math.round(amount * 100) / 100,
      note,
    },
  };
}

function validateDecisionPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '决策日志格式不正确' };
  }
  const today = options.today || todayShanghai();
  const date = String(payload.date ?? options.date ?? '').trim();
  if (!parseYmd(date)) return { error: '决策日期格式应为 YYYY-MM-DD' };
  if (date > today) return { error: '不能记录未来日期' };
  const productName = String(payload.product_name || '').trim();
  if (!productName) return { error: '请填写产品名称' };
  if (productName.length > 100) return { error: '产品名称不能超过 100 个字符' };
  const action = String(payload.action || '').trim();
  if (!DECISION_ACTIONS.has(action)) {
    return { error: '动作必须是买入、赎回、切换或观察' };
  }
  const reason = String(payload.reason || '').trim();
  if (!reason) return { error: '请填写当时的理由' };
  if (reason.length > 1000) return { error: '理由不能超过 1000 个字符' };
  const expectation = String(payload.expectation || '').trim();
  if (!expectation) return { error: '请填写收益、流动性或风险预期' };
  if (expectation.length > 1000) return { error: '预期不能超过 1000 个字符' };
  const invalidationCondition = String(
    payload.invalidation_condition || '',
  ).trim();
  if (!invalidationCondition) {
    return { error: '请填写失效条件，明确什么变化会推翻这次决策' };
  }
  if (invalidationCondition.length > 1000) {
    return { error: '失效条件不能超过 1000 个字符' };
  }
  const actualResult = String(payload.actual_result || '').trim();
  if (actualResult.length > 1000) return { error: '实际结果不能超过 1000 个字符' };
  const rating = String(payload.rating || '待评估').trim();
  if (!DECISION_RATINGS.has(rating)) {
    return { error: '事后评价不在允许范围内' };
  }
  const strategyVersion = String(
    payload.strategy_version || TARGET3_STRATEGY_VERSION,
  ).trim();
  if (!strategyVersion || strategyVersion.length > 60) {
    return { error: '策略版本需要填写，且不能超过 60 个字符' };
  }
  const targetAnnualized = Number(payload.target_annualized ?? 3);
  if (
    !Number.isFinite(targetAnnualized) ||
    targetAnnualized <= 0 ||
    targetAnnualized > 20
  ) {
    return { error: '目标年化需要是 0–20 之间的数字' };
  }
  let bucketPlanInput = payload.bucket_plan ?? {};
  if (typeof bucketPlanInput === 'string') {
    try {
      bucketPlanInput = JSON.parse(bucketPlanInput);
    } catch {
      return { error: '期限桶计划不是有效的 JSON' };
    }
  }
  if (
    !bucketPlanInput ||
    typeof bucketPlanInput !== 'object' ||
    Array.isArray(bucketPlanInput)
  ) {
    return { error: '期限桶计划格式不正确' };
  }
  const policyError = validateDecisionBucketPolicy(bucketPlanInput, {
    strategyVersion,
    targetAnnualized,
  });
  if (policyError) return { error: policyError };
  if (
    /r2-3pct|target3/i.test(strategyVersion) &&
    Math.abs(targetAnnualized - 3) > 0.0001
  ) {
    return { error: `${TARGET3_STRATEGY_VERSION} 的目标年化固定为 3.00%` };
  }
  const bucketPlan = {};
  for (const key of ['short', 'medium', 'long', 'max_single']) {
    if (
      bucketPlanInput[key] === null ||
      bucketPlanInput[key] === undefined ||
      bucketPlanInput[key] === ''
    ) {
      continue;
    }
    const value = Number(bucketPlanInput[key]);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return { error: '期限桶比例需要是 0–100 的数字' };
    }
    bucketPlan[key] = value;
  }
  Object.assign(
    bucketPlan,
    normalizeDecisionBucketPlan(bucketPlan, {
      strategyVersion,
      targetAnnualized,
    }),
  );
  const evaluationInput = Array.isArray(payload.evaluation_at)
    ? payload.evaluation_at
    : String(payload.evaluation_at || 'buy_day,holding,maturity').split(',');
  const allowedStages = new Set(['buy_day', 'holding', 'maturity']);
  const evaluationAt = evaluationInput
    .map((item) => String(item).trim())
    .filter(Boolean);
  if (
    !evaluationAt.length ||
    evaluationAt.some((item) => !allowedStages.has(item))
  ) {
    return { error: '评估时点必须是 buy_day、holding 或 maturity' };
  }
  const evidenceDate = String(payload.evidence_date || '').trim();
  if (!evidenceDate) return { error: '请填写证据日期' };
  if (!parseYmd(evidenceDate)) {
    return { error: '证据日期格式应为 YYYY-MM-DD' };
  }
  if (evidenceDate > today) {
    return { error: '证据日期不能晚于今天' };
  }
  const verifyDate = String(payload.verify_date || '').trim();
  if (!verifyDate) return { error: '请填写事后验证日期' };
  if (!parseYmd(verifyDate)) {
    return { error: '事后验证日期格式应为 YYYY-MM-DD' };
  }
  if (verifyDate < evidenceDate) {
    return { error: '事后验证日期不能早于证据日期' };
  }
  let reviewMeta = payload.review_meta ?? {};
  if (typeof reviewMeta === 'string') {
    try {
      reviewMeta = JSON.parse(reviewMeta);
    } catch {
      return { error: '替换测算不是有效的 JSON' };
    }
  }
  if (
    !reviewMeta ||
    typeof reviewMeta !== 'object' ||
    Array.isArray(reviewMeta)
  ) {
    return { error: '替换测算格式不正确' };
  }
  if (JSON.stringify(reviewMeta).length > 8000) {
    return { error: '替换测算内容过长' };
  }
  return {
    value: {
      date,
      product_name: productName,
      action,
      reason,
      expectation,
      invalidation_condition: invalidationCondition,
      actual_result: actualResult,
      strategy_version: strategyVersion,
      target_annualized: Math.round(targetAnnualized * 100) / 100,
      bucket_plan: bucketPlan,
      evaluation_at: [...new Set(evaluationAt)],
      evidence_date: evidenceDate,
      verify_date: verifyDate,
      review_meta: reviewMeta,
      rating,
    },
  };
}

function validateHoldingPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '持仓格式不正确' };
  }
  const today = todayShanghai();
  const productName = String(payload.product_name || '').trim();
  if (!productName) return { error: '请填写产品名称' };
  if (productName.length > 100) return { error: '产品名称不能超过 100 个字符' };
  const productCode = String(payload.product_code || '').trim();
  if (productCode.length > 50) return { error: '产品代码不能超过 50 个字符' };
  const issuer = String(payload.issuer || '').trim();
  if (issuer.length > 100) return { error: '发行方不能超过 100 个字符' };
  const riskRaw = String(payload.risk_level || 'R2').trim().toUpperCase();
  const riskLevel = riskRaw === 'R2' || riskRaw === 'PR2' ? riskRaw : null;
  if (!riskLevel) return { error: '风险等级只能是 R2 或 PR2' };
  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) {
    return { error: '买入金额需要是大于 0 的数字' };
  }
  const purchaseDate = String(payload.purchase_date || '').trim();
  if (!parseYmd(purchaseDate)) return { error: '买入日期格式应为 YYYY-MM-DD' };
  if (purchaseDate > today) return { error: '买入日期不能晚于今天' };
  let termDays = null;
  const rawTerm = payload.term_days;
  if (rawTerm !== '' && rawTerm !== null && rawTerm !== undefined) {
    const parsed = Number(rawTerm);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650) {
      return { error: '期限需要是 0–3650 的整数天，0 表示日开' };
    }
    termDays = parsed;
  }
  const maturityRaw = String(payload.maturity_date || '').trim();
  let maturityDate = null;
  if (maturityRaw) {
    if (!parseYmd(maturityRaw)) {
      return { error: '到期日格式应为 YYYY-MM-DD' };
    }
    if (maturityRaw < purchaseDate) {
      return { error: '到期日不能早于买入日' };
    }
    maturityDate = maturityRaw;
  }
  const notes = String(payload.notes || '').trim();
  if (notes.length > 500) return { error: '持仓备注不能超过 500 个字符' };
  return {
    value: {
      product_name: productName,
      product_code: productCode,
      issuer,
      risk_level: riskLevel,
      amount: Math.round(amount * 100) / 100,
      purchase_date: purchaseDate,
      term_days: termDays,
      maturity_date: maturityDate,
      notes,
    },
  };
}

function validateProductEventPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '产品事件格式不正确' };
  }
  const today = todayShanghai();
  const date = String(payload.date || '').trim();
  if (!parseYmd(date)) return { error: '事件日期格式应为 YYYY-MM-DD' };
  if (date > today) return { error: '不能记录未来日期' };
  const productName = String(payload.product_name || '').trim();
  if (!productName) return { error: '请填写产品名称' };
  if (productName.length > 100) return { error: '产品名称不能超过 100 个字符' };
  const eventType = String(payload.event_type || '').trim();
  if (!EVENT_TYPES.has(eventType)) {
    return { error: '事件类型不在允许范围内' };
  }
  const description = String(payload.description || '').trim();
  if (!description) return { error: '请填写事件说明' };
  if (description.length > 1000) return { error: '事件说明不能超过 1000 个字符' };
  const impact = String(payload.impact || '中').trim();
  if (!EVENT_IMPACTS.has(impact)) return { error: '影响程度只能是低、中、高' };
  const status = String(payload.status || '待复核').trim();
  if (!EVENT_STATUSES.has(status)) {
    return { error: '事件状态只能是待复核或已处理' };
  }
  return {
    value: {
      date,
      product_name: productName,
      event_type: eventType,
      description,
      impact,
      status,
    },
  };
}

function validateTradePayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '交易格式不正确' };
  }
  const today = options.today || todayShanghai();
  const tradeDate = String(payload.trade_date || '').trim();
  if (!parseYmd(tradeDate)) return { error: '交易日期格式应为 YYYY-MM-DD' };
  if (tradeDate > today) return { error: '交易日期不能晚于今天' };
  if (tradeDate < '2000-01-01') return { error: '交易日期过早' };

  const tradeType = String(payload.trade_type || '').trim();
  if (!TRADE_TYPES.has(tradeType)) {
    return { error: '交易类型必须是买入、赎回或切换' };
  }
  const status = String(payload.status || 'pending').trim();
  if (!TRADE_STATUSES.has(status)) {
    return { error: '交易状态必须是待确认、已确认或已撤销' };
  }

  const productCode = String(payload.product_code || '').trim();
  if (!productCode) return { error: '请填写产品代码' };
  if (productCode.length > 50) return { error: '产品代码不能超过 50 个字符' };
  const productName = String(payload.product_name || '').trim();
  if (!productName) return { error: '请填写产品名称' };
  if (productName.length > 120) return { error: '产品名称不能超过 120 个字符' };

  const issuer = String(payload.issuer || '').trim();
  if (issuer.length > 100) return { error: '发行方不能超过 100 个字符' };
  const riskRaw = String(payload.risk_level || 'R2').trim().toUpperCase();
  const riskLevel = riskRaw === 'R2' || riskRaw === 'PR2' ? riskRaw : null;
  if (!riskLevel) return { error: '风险等级只能是 R2 或 PR2' };

  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) {
    return { error: '交易金额需要是大于 0 的数字' };
  }
  let settlementAmount = null;
  if (
    payload.settlement_amount !== '' &&
    payload.settlement_amount !== null &&
    payload.settlement_amount !== undefined
  ) {
    settlementAmount = Number(payload.settlement_amount);
    if (
      !Number.isFinite(settlementAmount) ||
      settlementAmount <= 0 ||
      settlementAmount > 1e12
    ) {
      return { error: '到账金额需要是大于 0 的数字' };
    }
  }
  let shares = null;
  if (
    payload.shares !== '' &&
    payload.shares !== null &&
    payload.shares !== undefined
  ) {
    shares = Number(payload.shares);
    if (!Number.isFinite(shares) || shares <= 0 || shares > 1e15) {
      return { error: '份额需要是大于 0 的数字' };
    }
  }
  let termDays = null;
  if (
    payload.term_days !== '' &&
    payload.term_days !== null &&
    payload.term_days !== undefined
  ) {
    termDays = Number(payload.term_days);
    if (!Number.isInteger(termDays) || termDays < 0 || termDays > 3650) {
      return { error: '期限需要是 0–3650 的整数天，0 表示日开' };
    }
  }
  const maturityRaw = String(payload.maturity_date || '').trim();
  let maturityDate = null;
  if (maturityRaw) {
    if (!parseYmd(maturityRaw)) return { error: '到期日格式应为 YYYY-MM-DD' };
    if (maturityRaw < tradeDate) return { error: '到期日不能早于交易日期' };
    maturityDate = maturityRaw;
  }
  const confirmRaw = String(payload.confirm_date || '').trim();
  let confirmDate = null;
  if (confirmRaw) {
    if (!parseYmd(confirmRaw)) return { error: '确认日期格式应为 YYYY-MM-DD' };
    if (confirmDateIsFuture(confirmRaw, today)) {
      return { error: '确认日期不能晚于今天' };
    }
    if (confirmRaw < tradeDate) return { error: '确认日期不能早于交易日期' };
    confirmDate = confirmRaw;
  }
  if (status === 'confirmed' && !confirmDate) confirmDate = tradeDate;
  if (status !== 'confirmed') confirmDate = null;

  let targetCode = String(payload.target_product_code || '').trim();
  let targetName = String(payload.target_product_name || '').trim();
  let targetTermDays = null;
  let targetMaturityDate = null;
  if (tradeType === 'switch') {
    if (!targetCode) return { error: '切换交易请填写目标产品代码' };
    if (!targetName) return { error: '切换交易请填写目标产品名称' };
    if (targetName.length > 120) return { error: '目标产品名称不能超过 120 个字符' };
    if (
      payload.target_term_days !== '' &&
      payload.target_term_days !== null &&
      payload.target_term_days !== undefined
    ) {
      targetTermDays = Number(payload.target_term_days);
      if (
        !Number.isInteger(targetTermDays) ||
        targetTermDays < 0 ||
        targetTermDays > 3650
      ) {
        return { error: '目标产品期限需要是 0–3650 的整数天' };
      }
    }
    const targetMaturityRaw = String(payload.target_maturity_date || '').trim();
    if (targetMaturityRaw) {
      if (!parseYmd(targetMaturityRaw)) {
        return { error: '目标产品到期日格式应为 YYYY-MM-DD' };
      }
      if (targetMaturityRaw < tradeDate) {
        return { error: '目标产品到期日不能早于交易日期' };
      }
      targetMaturityDate = targetMaturityRaw;
    }
  }

  let decisionId = null;
  if (
    payload.decision_id !== '' &&
    payload.decision_id !== null &&
    payload.decision_id !== undefined
  ) {
    decisionId = Number(payload.decision_id);
    if (!Number.isInteger(decisionId) || decisionId <= 0) {
      return { error: '关联决策编号不正确' };
    }
  }
  const notes = String(payload.notes || '').trim();
  if (notes.length > 500) return { error: '交易备注不能超过 500 个字符' };

  return {
    value: {
      trade_date: tradeDate,
      confirm_date: confirmDate,
      trade_type: tradeType,
      status,
      product_code: productCode,
      product_name: productName,
      issuer,
      risk_level: riskLevel,
      target_product_code: targetCode,
      target_product_name: targetName,
      target_term_days: targetTermDays,
      target_maturity_date: targetMaturityDate,
      amount: Math.round(amount * 100) / 100,
      settlement_amount:
        settlementAmount === null
          ? null
          : Math.round(settlementAmount * 100) / 100,
      shares: shares === null ? null : Math.round(shares * 10000) / 10000,
      term_days: termDays,
      maturity_date: maturityDate,
      decision_id: decisionId,
      notes,
    },
  };
}

function confirmDateIsFuture(date, today) {
  return date > today;
}

function validateInboxOverridePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '收件箱校正内容格式不正确' };
  }
  const allowed = [
    'trade_date',
    'confirm_date',
    'trade_type',
    'status',
    'product_code',
    'product_name',
    'issuer',
    'risk_level',
    'amount',
    'settlement_amount',
    'shares',
    'term_days',
    'maturity_date',
    'target_product_code',
    'target_product_name',
    'target_term_days',
    'target_maturity_date',
    'decision_id',
    'decision_reason',
    'decision_expectation',
    'decision_invalidation_condition',
    'decision_evidence_date',
    'decision_verify_date',
    'confidence',
    'notes',
  ];
  const value = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      value[key] = payload[key];
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(value, 'notes') &&
    String(value.notes || '').length > 500
  ) {
    return { error: '收件箱备注不能超过 500 个字符' };
  }
  return { value };
}

function decodeImagePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { error: '图片格式不正确' };
  }
  const raw = String(payload.data || payload.image || '');
  if (!raw) return { error: '请选择成交截图' };
  const dataUrl = raw.match(
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/,
  );
  const mime = String(payload.mime || dataUrl?.[1] || '').toLowerCase();
  if (!IMAGE_MIME_EXTENSIONS[mime]) {
    return { error: '只支持 PNG、JPEG 或 WebP 截图' };
  }
  const base64 = dataUrl ? dataUrl[2] : raw;
  let buffer;
  try {
    buffer = Buffer.from(base64.replace(/\s/g, ''), 'base64');
  } catch {
    return { error: '图片编码不正确' };
  }
  if (!buffer.length) return { error: '图片内容为空' };
  if (buffer.length > 10 * 1024 * 1024) {
    return { error: '单张截图不能超过 10 MB' };
  }
  const isPng =
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer.subarray(1, 4).toString('ascii') === 'PNG';
  const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8;
  const isWebp =
    buffer.length > 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (
    (mime === 'image/png' && !isPng) ||
    (mime === 'image/jpeg' && !isJpeg) ||
    (mime === 'image/webp' && !isWebp)
  ) {
    return { error: '图片内容和文件类型不一致' };
  }
  return {
    value: {
      buffer,
      mime,
      original_name: String(payload.filename || payload.original_name || '')
        .trim()
        .slice(0, 200),
    },
  };
}

function validateReviewNotePayload(payload, period, count, label) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: `${label}格式不正确` };
  }
  const answers = Array.isArray(payload.answers)
    ? payload.answers.map((item) => String(item ?? '').trim())
    : [];
  while (answers.length < count) answers.push('');
  if (answers.length > count) answers.length = count;
  for (const answer of answers) {
    if (answer.length > 2000) {
      return { error: `${label}单条回答不能超过 2000 个字符` };
    }
  }
  const conclusion = String(payload.conclusion || '').trim();
  if (conclusion.length > 4000) {
    return { error: `${label}结论不能超过 4000 个字符` };
  }
  return { value: { period, answers, conclusion } };
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function buildCsv(records) {
  const lines = ['date,principal,daily_pnl,action,notes'];
  for (const record of records) {
    lines.push(
      [
        record.date,
        record.principal,
        record.daily_pnl,
        record.action,
        record.notes,
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function markdownCell(value) {
  const text = String(value ?? '')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
  return text || '—';
}

function moneyText(value) {
  const number = Number(value || 0);
  const prefix = number < 0 ? '−' : '';
  return `${prefix}¥${Math.abs(number).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pctText(value, digits = 3, signed = false) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return '—';
  }
  const number = Number(value);
  const prefix = signed && number > 0 ? '+' : number < 0 ? '−' : '';
  return `${prefix}${Math.abs(number).toFixed(digits)}%`;
}

function ppText(value, digits = 2, signed = false) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return '—';
  }
  const number = Number(value);
  const prefix = signed && number > 0 ? '+' : number < 0 ? '−' : '';
  return `${prefix}${Math.abs(number).toFixed(digits)}pp`;
}

function buildMonthlyReviewMarkdown({
  month,
  review,
  decisions,
  events,
  note,
  holdings,
  holdingsSummary,
  generatedAt,
}) {
  const row = review.monthly.find((item) => item.month === month) || null;
  const lines = [];
  lines.push(`# R2 月度复盘 ${month}`);
  lines.push('');
  lines.push(
    `> 生成时间：${generatedAt}；数据来源：钱多多 R2 收益账本；币种：人民币。`,
  );
  lines.push('> R2 不保本，以下为个人复盘记录，不构成投资建议。');
  lines.push('');
  lines.push('## 一、月度指标');
  lines.push('');
  if (!row) {
    lines.push('该月没有收益记录。');
  } else {
    lines.push('| 指标 | 数值 |');
    lines.push('| --- | ---: |');
    lines.push(`| 月收益 | ${moneyText(row.pnl)} |`);
    lines.push(`| 月均本金 | ${moneyText(row.avg_principal)} |`);
    lines.push(`| 月收益率 | ${pctText(row.return_pct, 3, true)} |`);
    lines.push(`| 年化参考 | ${pctText(row.annualized_pct, 2, true)} |`);
    lines.push(`| 最大回撤 | ${pctText(row.max_drawdown_pct, 3)} |`);
    lines.push(`| 负收益天数占比 | ${pctText(row.negative_day_ratio_pct, 1)} |`);
    lines.push(`| 最好单日 | ${moneyText(row.best_day)} |`);
    lines.push(`| 最差单日 | ${moneyText(row.worst_day)} |`);
    lines.push(`| 目标缺口 | ${ppText(row.target_gap_pct, 2, true)} |`);
    lines.push(
      `| 记录完整度 | ${row.record_days}/${row.elapsed_days} 天，缺记 ${row.missing_days} 天 |`,
    );
    lines.push(`| 评级 | ${row.grade_display} |`);
  }
  lines.push('');
  lines.push('## 二、目标进度');
  lines.push('');
  if (!row) {
    lines.push('该月没有收益记录。');
  } else {
    lines.push(`- 按天折算目标：${pctText(row.target_mtd_pct, 3)}`);
    lines.push(`- 当前月收益率：${pctText(row.return_pct, 3, true)}`);
    lines.push(`- 完成进度：${pctText(row.target_progress_pct, 1)}`);
    lines.push(
      `- 按当前速度月底预估：${pctText(row.projected_pct, 3, true)}（短样本仅参考）`,
    );
  }
  lines.push('');
  lines.push('## 三、环比');
  lines.push('');
  if (!row) {
    lines.push('该月没有收益记录。');
  } else if (row.compare) {
    lines.push(`对比 ${row.compare.prev_month_label}：`);
    lines.push('');
    lines.push(`- 收益变化：${moneyText(row.compare.pnl_delta)}`);
    lines.push(`- 收益率变化：${ppText(row.compare.return_delta_pp, 3, true)}`);
    lines.push(`- 回撤变化：${ppText(row.compare.drawdown_delta_pp, 3, true)}`);
    lines.push(
      `- 负收益天数占比变化：${ppText(
        row.compare.negative_ratio_delta_pp,
        1,
        true,
      )}`,
    );
    lines.push(
      `- 操作次数变化：${row.compare.action_delta > 0 ? '+' : ''}${row.compare.action_delta}`,
    );
  } else {
    lines.push('首月记录，暂无环比。');
  }
  lines.push('');
  lines.push('## 四、决策日志');
  lines.push('');
  if (!decisions.length) {
    lines.push('本月没有决策记录。');
  } else {
    lines.push('| 日期 | 产品 | 动作 | 理由 | 预期 | 实际结果 | 事后评价 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const item of decisions) {
      lines.push(
        `| ${markdownCell(item.date)} | ${markdownCell(item.product_name)} | ${markdownCell(
          item.action,
        )} | ${markdownCell(item.reason)} | ${markdownCell(
          item.expectation,
        )} | ${markdownCell(item.actual_result)} | ${markdownCell(item.rating)} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 五、产品事件');
  lines.push('');
  if (!events.length) {
    lines.push('本月没有产品事件记录。');
  } else {
    lines.push('| 日期 | 产品 | 类型 | 影响 | 状态 | 说明 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const item of events) {
      lines.push(
        `| ${markdownCell(item.date)} | ${markdownCell(item.product_name)} | ${markdownCell(
          item.event_type,
        )} | ${markdownCell(item.impact)} | ${markdownCell(
          item.status,
        )} | ${markdownCell(item.description)} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 六、月度五问');
  lines.push('');
  if (!note) {
    lines.push('本月五问尚未填写。');
  } else {
    const questions = [
      '这个月有没有按计划执行？哪一次偏离了，为什么？',
      '哪笔操作真正增加了收益，哪笔只是增加了忙碌？',
      '闲置资金拖累是否接近 0？近 3M/6M/1Y 年化离 3% 差多少？',
      '有没有产品触发风险、流动性或费率红线？',
      '下个月只改一件事，改什么？',
    ];
    questions.forEach((question, index) => {
      lines.push(`${index + 1}. ${question}`);
      lines.push(`   答：${markdownCell(note.answers[index])}`);
    });
  }
  lines.push('');
  lines.push('## 七、当月结论与下月只改一件事');
  lines.push('');
  lines.push(`- 当月结论：${markdownCell(note?.conclusion)}`);
  lines.push(`- 下月只改一件事：${markdownCell(note?.answers?.[4])}`);
  lines.push('');
  lines.push('## 八、当前持仓快照');
  lines.push('');
  lines.push('> 这是导出时的当前持仓，不是月末持仓快照。');
  lines.push('');
  lines.push(`- 未赎回成本本金：${moneyText(holdingsSummary.total_amount)}`);
  lines.push(
    `- 最大单只成本占比：${
      holdingsSummary.max_product
        ? `${holdingsSummary.max_product.name} ${pctText(holdingsSummary.max_product.pct, 1)}`
        : '—'
    }`,
  );
  lines.push(
    `- 短期 7–30 天成本占比：${pctText(holdingsSummary.short_ratio_pct, 1)}`,
  );
  lines.push(
    `- 现有日开金额与占比：${moneyText(holdingsSummary.buckets.liquid)}，${pctText(
      holdingsSummary.daily_open_ratio_pct,
      1,
    )}（新增目标固定 0%）`,
  );
  lines.push(
    `- 已到期持仓：${holdingsSummary.overdue_count} 笔，${moneyText(
      holdingsSummary.overdue_amount,
    )}`,
  );
  lines.push('');
  if (!holdings.length) {
    lines.push('尚未录入持仓。');
  } else {
    lines.push('| 产品 | 金额 | 确认起持日 | 期限 | 到期日 | 发行方 | 风险 |');
    lines.push('| --- | ---: | --- | ---: | --- | --- | --- |');
    for (const item of holdings) {
      lines.push(
        `| ${markdownCell(item.product_name)} | ${moneyText(item.amount)} | ${markdownCell(
          item.purchase_date,
        )} | ${item.term_days === 0 ? '日开' : item.term_days ? `${item.term_days} 天` : '未填'} | ${markdownCell(
          item.maturity_date,
        )} | ${markdownCell(item.issuer)} | ${markdownCell(item.risk_level)} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 九、复盘口径');
  lines.push('');
  lines.push(
    '- 月收益率 = 月收益 ÷ 月均本金；评级：0.16% 及格、0.20% 良好、0.25% 优秀、0.30% 卓越。',
  );
  lines.push(
    '- 当前月份只显示进度和参考区间；月末且满 28 天、20 条记录后才落最终评级。',
  );
  lines.push('- 年化、回撤和环比只用于个人复盘，不代表未来收益。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function syncTradeDecisionAndEvaluate(repository, trade, trigger) {
  const today = todayShanghai();
  const matched = repository.decisionProposalStore.matchTrade(trade, today);
  if (matched?.trade) trade = matched.trade;
  repository.decisionProposalStore.reconcileExecutionStatuses(today);
  repository.automationStore.ensureTradeDecisions();
  repository.automationStore.runCycle({
    today,
    trigger,
  });
  repository.decisionProposalStore.reconcileExecutionStatuses(today);
  return trade?.id ? repository.tradeStore.getTrade(trade.id) : trade;
}

function evaluateDecisionChanges(repository, trigger) {
  repository.automationStore.runCycle({
    today: todayShanghai(),
    trigger,
  });
}

function dashboardPayload(repository) {
  const rawRecords = repository.listRecords();
  const records = enrichRecords(rawRecords);
  const today = todayShanghai();
  const tradeOverview = repository.tradeStore.getOverview(today);
  const incomeDisclosurePolicy =
    repository.productValuationStore.getDisclosurePolicy(
      today,
      tradeOverview.holdings,
    );
  const reportingDate = shiftDate(today, -1);
  const todayRecord = rawRecords.find((record) => record.date === today) || null;
  const reportingRecord =
    rawRecords.find((record) => record.date === reportingDate) || null;
  const capital = repository.getCapitalState(today);
  const allocationSettings = repository.getAllocationSettings();
  const principal =
    allocationSettings.principal_override ??
    (Number.isFinite(capital.current_principal) ? capital.current_principal : 0);
  const decisions = repository.listDecisions();
  const productView = buildProductView(repository.listProducts(), {
    principal,
    settings: allocationSettings,
    decisions,
    holdings: tradeOverview.holdings,
    pending_trades: tradeOverview.trades.filter((item) => item.status === 'pending'),
  });
  const snapshotDate =
    productView.all
      .map((product) => product.data_date)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
  const historyDate =
    productView.all
      .filter((product) => product.return_1y !== null)
      .map((product) => product.data_date)
      .filter(Boolean)
      .sort()
      .at(-1) || snapshotDate;
  const backups = repository.backupDir ? listBackups(repository.backupDir) : [];
  const review = buildReview(records, today, {
    initialDate: capital.initial_date,
    reportingDate,
    reportingLagDays: 1,
  });
  const holdingReviewSettings = Object.fromEntries(
    repository
      .listHoldingReviewSettings()
      .map((setting) => [setting.product_code, setting]),
  );
  const holdingReviews = buildHoldingReviews({
    holdings: tradeOverview.holdings,
    products: productView.all,
    universe: repository.listProducts(),
    settingsByCode: holdingReviewSettings,
    quotaByCode: allocationSettings.quota_by_code || {},
    today,
    snapshotDate: snapshotDate || '',
    decisions,
  });
  const workspace = repository.getReviewWorkspace({
    today,
    reportingDate,
    records,
    review,
    trades: tradeOverview,
  });
  workspace.holding_reviews = holdingReviews;
  workspace.holding_reviews_summary = {
    total: holdingReviews.length,
    replace: holdingReviews.filter((item) => item.verdict === 'replace').length,
    watch: holdingReviews.filter((item) => item.verdict === 'watch').length,
    hold: holdingReviews.filter((item) => item.verdict === 'hold').length,
    window: holdingReviews.filter((item) => item.reminder.level !== 'none').length,
  };
  workspace.income_inbox = repository.listIncomeScreenshots();
  workspace.income_summary = {
    pending: workspace.income_inbox.filter((item) => item.status === 'pending')
      .length,
    applied: workspace.income_inbox.filter((item) => item.status === 'applied')
      .length,
    latest_date:
      workspace.income_inbox
        .filter((item) => item.status === 'applied' && item.record_date)
        .map((item) => item.record_date)
        .sort()
        .at(-1) || null,
  };
  Object.assign(
    workspace,
    repository.productValuationStore.getWorkspace(today, tradeOverview.holdings),
  );
  for (const item of holdingReviews) {
    if (item.reminder.level === 'none') continue;
    workspace.holdings_summary.alerts.push({
      level: item.reminder.level === 'urgent' ? 'warn' : 'info',
      code: `review-${item.product_code}`,
      text: `${item.product_name}：${item.reminder.text}`,
    });
  }

  const automation = repository.automationStore.getWorkspace(today);
  const payload = {
    meta: {
      today,
      reporting_date: reportingDate,
      reporting_lag_days: 1,
      recording_date_source: 'user-provided',
      income_disclosure_policy: incomeDisclosurePolicy,
      target_annualized: TARGET_ANNUALIZED,
      has_today_record: Boolean(todayRecord),
      today_record: todayRecord,
      has_reporting_record: Boolean(reportingRecord),
      reporting_record: reportingRecord,
      product_snapshot_date: snapshotDate,
      product_history_date: historyDate,
      product_csv: repository.productCsvPath ? path.basename(repository.productCsvPath) : null,
      latest_backup: backups[0]
        ? { date: backups[0].date, bytes: backups[0].bytes }
        : null,
      storage: 'SQLite · 本地',
    },
    records,
    summary: summarize(records),
    windows: buildWindows(records),
    review,
    workspace,
    automation,
    capital,
    products: productView,
  };
  repository.decisionProposalStore.sync(payload);
  payload.decision_proposals = repository.decisionProposalStore.getWorkspace(today);
  payload.inbox_center = repository.inboxCenter.sync(payload);
  return payload;
}

function serveStatic(request, response, pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    sendError(response, 400, '路径格式不正确');
    return;
  }
  const filePath = path.resolve(STATIC_DIR, `.${relative}`);
  const expectedPrefix = `${path.resolve(STATIC_DIR)}${path.sep}`;
  if (!filePath.startsWith(expectedPrefix)) {
    sendError(response, 403, '禁止访问');
    return;
  }
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      if (!path.extname(filePath) && (request.method === 'GET' || request.method === 'HEAD')) {
        sendStaticFile(path.join(STATIC_DIR, 'index.html'), response, request);
        return;
      }
      sendError(response, 404, '页面不存在');
      return;
    }
    sendStaticFile(filePath, response, request, stats);
  });
}

function sendStaticFile(filePath, response, request, knownStats = null) {
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      sendError(response, 404, '页面不存在');
      return;
    }
    const finalStats = knownStats || stats;
    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || 'application/octet-stream';
    const isHashedAsset =
      filePath.includes(`${path.sep}assets${path.sep}`) ||
      filePath.includes(`${path.sep}research${path.sep}media${path.sep}`);
    const compressible = /^(text\/|application\/(json|javascript|xml)|image\/svg)/.test(
      contentType,
    );
    const useGzip =
      compressible && /\bgzip\b/.test(String(request.headers['accept-encoding'] || ''));
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': isHashedAsset
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
      ...SECURITY_HEADERS,
      ...(compressible ? { Vary: 'Accept-Encoding' } : {}),
      ...(useGzip ? { 'Content-Encoding': 'gzip' } : { 'Content-Length': finalStats.size }),
      ...(extension === '.html' ? { 'Content-Security-Policy': HTML_CSP } : {}),
    };
    response.writeHead(200, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    if (useGzip) {
      stream.pipe(zlib.createGzip()).pipe(response);
    } else {
      stream.pipe(response);
    }
  });
}

function createServer(options = {}) {
  const repository = options.repository;
  if (!repository) throw new Error('createServer 需要 repository');

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    const { pathname } = requestUrl;

    try {
      if (
        !['GET', 'HEAD'].includes(request.method || '') &&
        !isAllowedOrigin(request)
      ) {
        sendError(response, 403, '拒绝跨站写入请求');
        return;
      }

      if (pathname === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }

      if (pathname === '/api/health' && request.method === 'GET') {
        sendJson(response, 200, { ok: true, time: new Date().toISOString() });
        return;
      }

      if (pathname === '/api/backups' && request.method === 'GET') {
        const dir = repository.backupDir || defaultBackupDir(repository.dbPath);
        sendJson(response, 200, { dir, backups: listBackups(dir) });
        return;
      }

      if (pathname === '/api/backups' && request.method === 'POST') {
        const dir = repository.backupDir || defaultBackupDir(repository.dbPath);
        const result = createDailyBackup(repository.db, repository.dbPath, { dir });
        sendJson(response, 201, { ...result, backups: listBackups(dir) });
        return;
      }

      if (pathname === '/api/dashboard' && request.method === 'GET') {
        sendJson(response, 200, dashboardPayload(repository));
        return;
      }

      if (pathname === '/api/capital/init' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const validation = validateCapitalInitPayload(body);
        if (validation.error) {
          sendError(response, 400, validation.error);
          return;
        }
        if (repository.getCapitalState().initialized) {
          sendError(response, 409, '本金账户已经初始化，如需调整请使用修改接口');
          return;
        }
        repository.initializeCapital(
          validation.value.initial_principal,
          validation.value.initial_date,
          '页面首次初始化',
        );
        sendJson(response, 201, { dashboard: dashboardPayload(repository) });
        return;
      }

      if (pathname === '/api/capital/init' && request.method === 'PUT') {
        const body = await readJsonBody(request);
        const validation = validateCapitalInitPayload(body);
        if (validation.error) {
          sendError(response, 400, validation.error);
          return;
        }
        if (!repository.getCapitalState().initialized) {
          sendError(response, 404, '本金账户尚未初始化');
          return;
        }
        try {
          repository.updateCapitalInitial(
            validation.value.initial_principal,
            validation.value.initial_date,
          );
        } catch (error) {
          sendError(response, 400, error.message);
          return;
        }
        sendJson(response, 200, { dashboard: dashboardPayload(repository) });
        return;
      }

      if (pathname === '/api/capital/events' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const validation = validateCapitalEventPayload(body);
        if (validation.error) {
          sendError(response, 400, validation.error);
          return;
        }
        let event;
        try {
          event = repository.createCapitalEvent(validation.value);
        } catch (error) {
          sendError(response, 400, error.message);
          return;
        }
        sendJson(response, 201, { event, dashboard: dashboardPayload(repository) });
        return;
      }

      const capitalEventMatch = pathname.match(/^\/api\/capital\/events\/(\d+)$/);
      if (capitalEventMatch && request.method === 'DELETE') {
        try {
          const deleted = repository.deleteCapitalEvent(Number(capitalEventMatch[1]));
          if (!deleted) {
            sendError(response, 404, '没有找到这笔本金变动');
            return;
          }
        } catch (error) {
          sendError(response, 400, error.message);
          return;
        }
        sendJson(response, 200, { deleted: true, dashboard: dashboardPayload(repository) });
        return;
      }

      if (pathname === '/api/products/refresh' && request.method === 'POST') {
        const refreshed = repository.refreshProducts(resolveProductCsv(ROOT));
        sendJson(response, 200, {
          refreshed,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      if (pathname === '/api/products/allocation' && request.method === 'PUT') {
        const body = await readJsonBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendError(response, 400, '分配设置格式不正确');
          return;
        }
        if (
          body.principal_override !== null &&
          body.principal_override !== undefined &&
          body.principal_override !== ''
        ) {
          const principal = Number(body.principal_override);
          if (!Number.isFinite(principal) || principal < 0 || principal > 1e12) {
            sendError(response, 400, '可投资本金需要是 0 以上的数字');
            return;
          }
        }
        if (
          body.daily_open_target_pct !== undefined &&
          Number(body.daily_open_target_pct) !== DAILY_OPEN_TARGET_PCT
        ) {
          sendError(
            response,
            400,
            `本项目新增日开额度固定为 ${DAILY_OPEN_TARGET_PCT}%`,
          );
          return;
        }
        const ranges = {
          liquidity_floor_pct: [0, 100],
          max_single_pct: [25, 30],
          max_issuer_pct: [40, 100],
          target_slice_pct: [5, 25],
          cashflow_0_3: [0, 1e12],
          cashflow_3_6: [0, 1e12],
          cashflow_6_12: [0, 1e12],
        };
        for (const [key, [min, max]] of Object.entries(ranges)) {
          if (body[key] === undefined || body[key] === null || body[key] === '') continue;
          const value = Number(body[key]);
          if (!Number.isFinite(value) || value < min || value > max) {
            sendError(response, 400, `${key} 需要在 ${min}–${max} 之间`);
            return;
          }
        }
        const targets = body.bucket_targets;
        if (targets !== undefined) {
          if (!targets || typeof targets !== 'object' || Array.isArray(targets)) {
            sendError(response, 400, '期限桶目标格式不正确');
            return;
          }
          let total = 0;
          for (const key of ['short', 'medium', 'long']) {
            const value = Number(targets[key] ?? 0);
            if (!Number.isFinite(value) || value < 0 || value > 100) {
              sendError(response, 400, '期限桶目标需要是 0–100 的数字');
              return;
            }
            total += value;
          }
          if (total > 100.001) {
            sendError(response, 400, '期限桶目标合计不能超过 100%');
            return;
          }
        }
        if (body.quota_by_code !== undefined) {
          if (
            !body.quota_by_code ||
            typeof body.quota_by_code !== 'object' ||
            Array.isArray(body.quota_by_code)
          ) {
            sendError(response, 400, '产品额度格式不正确');
            return;
          }
          for (const [code, quota] of Object.entries(body.quota_by_code)) {
            if (!code || code.length > 80) {
              sendError(response, 400, '产品代码格式不正确');
              return;
            }
            if (!quota || typeof quota !== 'object' || Array.isArray(quota)) {
              sendError(response, 400, '单只产品额度格式不正确');
              return;
            }
            for (const key of ['available', 'max_order']) {
              if (quota[key] === null || quota[key] === undefined || quota[key] === '') continue;
              const value = Number(quota[key]);
              if (!Number.isFinite(value) || value < 0 || value > 1e12) {
                sendError(response, 400, '产品额度需要是 0 以上的数字');
                return;
              }
            }
          }
        }
        const settings = repository.saveAllocationSettings(body);
        sendJson(response, 200, {
          settings,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      const holdingReviewMatch = pathname.match(
        /^\/api\/holding-reviews\/([^/]+)$/,
      );
      if (holdingReviewMatch && request.method === 'PUT') {
        const productCode = decodeURIComponent(holdingReviewMatch[1]).trim();
        if (!productCode || productCode.length > 80) {
          sendError(response, 400, '产品代码格式不正确');
          return;
        }
        const body = await readJsonBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendError(response, 400, '持仓复核口径格式不正确');
          return;
        }
        const deprecatedFields = [
          'idle_days',
          'compare_horizon_days',
          'min_gain_amount',
        ];
        const deprecatedField = deprecatedFields.find((key) =>
          Object.prototype.hasOwnProperty.call(body, key),
        );
        if (deprecatedField) {
          sendError(
            response,
            400,
            `${deprecatedField} 已停用，请使用统一期限和动态门槛`,
          );
          return;
        }
        const integerRanges = {
          redemption_days: [0, 30],
          arrival_days: [0, 30],
          purchase_confirm_days: [0, 30],
        };
        for (const [key, [min, max]] of Object.entries(integerRanges)) {
          if (body[key] === undefined) continue;
          if (body[key] === null || body[key] === '') continue;
          const value = Number(body[key]);
          if (!Number.isInteger(value) || value < min || value > max) {
            sendError(response, 400, `${key} 需要是 ${min}–${max} 的整数`);
            return;
          }
        }
        const feeRanges = {
          redemption_fee_bps: [0, 500],
          purchase_fee_bps: [0, 500],
        };
        for (const [key, [min, max]] of Object.entries(feeRanges)) {
          if (body[key] === undefined || body[key] === null || body[key] === '') continue;
          const value = Number(body[key]);
          if (!Number.isFinite(value) || value < min || value > max) {
            sendError(response, 400, `${key} 需要在 ${min}–${max} 之间`);
            return;
          }
        }
        const notes = body.notes === undefined ? undefined : String(body.notes);
        if (notes !== undefined && notes.length > 1000) {
          sendError(response, 400, '赎回规则备注不能超过 1000 个字符');
          return;
        }
        const verifiedAt =
          body.verified_at === undefined ? undefined : String(body.verified_at).trim();
        if (verifiedAt) {
          if (!parseYmd(verifiedAt)) {
            sendError(response, 400, '核验日期格式应为 YYYY-MM-DD');
            return;
          }
          if (verifiedAt > todayShanghai()) {
            sendError(response, 400, '核验日期不能晚于今天');
            return;
          }
        }
        const redeemOpenDate =
          body.next_redeem_open_date === undefined
            ? undefined
            : String(body.next_redeem_open_date).trim();
        if (redeemOpenDate && !parseYmd(redeemOpenDate)) {
          sendError(response, 400, '下一赎回开放日格式应为 YYYY-MM-DD');
          return;
        }
        const setting = repository.saveHoldingReviewSetting({
          ...body,
          product_code: productCode,
          notes,
          verified_at: verifiedAt,
          next_redeem_open_date: redeemOpenDate,
        });
        sendJson(response, 200, {
          setting,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      if (pathname === '/api/review/workspace' && request.method === 'GET') {
        sendJson(response, 200, {
          workspace: dashboardPayload(repository).workspace,
        });
        return;
      }

      if (pathname === '/api/inbox' && request.method === 'GET') {
        const dashboard = dashboardPayload(repository);
        sendJson(response, 200, {
          inbox_center: dashboard.inbox_center,
        });
        return;
      }

      if (
        pathname === '/api/inbox/confirmations' &&
        request.method === 'POST'
      ) {
        const body = await readJsonBody(request);
        const dedupeKey = String(body.dedupe_key || '').trim();
        const title = String(body.title || '').trim();
        const message = String(body.message || body.summary || '').trim();
        const category = String(body.category || 'action').trim();
        const level = String(body.level || 'warn').trim();
        const severity = String(body.severity || level).trim();
        const actionLabel = String(body.action_label || '查看详情').trim();
        const actionUrl = String(body.action_url || '/ledger/overview').trim();
        const dueAt = String(body.due_at || '').trim();
        if (!/^[A-Za-z0-9:_-]{3,160}$/.test(dedupeKey)) {
          sendError(
            response,
            400,
            'dedupe_key 需为 3–160 位字母、数字、冒号、下划线或连字符',
          );
          return;
        }
        if (!title || title.length > 100) {
          sendError(response, 400, 'title 不能为空或超过 100 个字符');
          return;
        }
        if (!message || message.length > 1200) {
          sendError(response, 400, 'message 不能为空或超过 1200 个字符');
          return;
        }
        if (!['action', 'reminder', 'system'].includes(category)) {
          sendError(response, 400, 'category 必须是 action、reminder 或 system');
          return;
        }
        if (!['info', 'warn'].includes(level)) {
          sendError(response, 400, 'level 必须是 info 或 warn');
          return;
        }
        if (!['info', 'warn', 'urgent'].includes(severity)) {
          sendError(response, 400, 'severity 必须是 info、warn 或 urgent');
          return;
        }
        if (!actionLabel || actionLabel.length > 40) {
          sendError(response, 400, 'action_label 不能为空或超过 40 个字符');
          return;
        }
        if (
          !actionUrl.startsWith('/') ||
          actionUrl.startsWith('//') ||
          /[\r\n]/.test(actionUrl)
        ) {
          sendError(response, 400, 'action_url 必须是以 / 开头的站内地址');
          return;
        }
        if (dueAt && !parseYmd(dueAt)) {
          sendError(response, 400, 'due_at 格式应为 YYYY-MM-DD');
          return;
        }
        const notification = repository.automationStore.saveNotification({
          dedupe_key: dedupeKey,
          kind: 'agent_confirmation',
          level,
          title,
          message,
          data: {
            category,
            severity,
            action_label: actionLabel,
            action_url: actionUrl,
            due_at: dueAt || null,
            source: 'codex-r2-review',
          },
        });
        const dashboard = dashboardPayload(repository);
        sendJson(response, 201, {
          notification,
          inbox_center: dashboard.inbox_center,
          dashboard,
        });
        return;
      }

      if (pathname === '/api/inbox/read-all' && request.method === 'POST') {
        repository.inboxCenter.markAllRead();
        const dashboard = dashboardPayload(repository);
        sendJson(response, 200, {
          inbox_center: dashboard.inbox_center,
          dashboard,
        });
        return;
      }

      const inboxActionMatch = pathname.match(
        /^\/api\/inbox\/(\d+)\/(read|unread|snooze|unsnooze)$/,
      );
      if (inboxActionMatch && request.method === 'POST') {
        const body = await readJsonBody(request);
        let item;
        try {
          item = repository.inboxCenter.mark(
            Number(inboxActionMatch[1]),
            inboxActionMatch[2],
            body,
          );
        } catch (error) {
          sendError(response, 400, error.message);
          return;
        }
        if (!item) {
          sendError(response, 404, '没有找到这条消息');
          return;
        }
        const dashboard = dashboardPayload(repository);
        sendJson(response, 200, {
          item,
          inbox_center: dashboard.inbox_center,
          dashboard,
        });
        return;
      }

      if (pathname === '/api/automation/workspace' && request.method === 'GET') {
        sendJson(response, 200, {
          automation: repository.automationStore.getWorkspace(todayShanghai()),
        });
        return;
      }

      if (pathname === '/api/decision-proposals' && request.method === 'GET') {
        const dashboard = dashboardPayload(repository);
        sendJson(response, 200, {
          decision_proposals: dashboard.decision_proposals,
          dashboard,
        });
        return;
      }

      const proposalActionMatch = pathname.match(
        /^\/api\/decision-proposals\/(\d+)\/(adopt|reject)$/,
      );
      if (proposalActionMatch && request.method === 'POST') {
        const id = Number(proposalActionMatch[1]);
        const action = proposalActionMatch[2];
        const body = await readJsonBody(request);
        let result;
        try {
          result =
            action === 'adopt'
              ? repository.decisionProposalStore.adoptProposal(id, {
                  today: todayShanghai(),
                })
              : {
                  proposal: repository.decisionProposalStore.rejectProposal(id, {
                    reason: body.reason,
                  }),
                };
        } catch (error) {
          sendError(response, 400, error.message);
          return;
        }
        if (!result?.proposal) {
          sendError(response, 404, '没有找到这条决策提案');
          return;
        }
        sendJson(response, 200, {
          result,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      if (pathname === '/api/automation/run' && request.method === 'POST') {
        const result = repository.automationStore.runCycle({
          today: todayShanghai(),
          trigger: 'manual',
        });
        sendJson(response, result.ok ? 200 : 500, {
          ...result,
          automation: repository.automationStore.getWorkspace(todayShanghai()),
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      if (pathname === '/api/automation/settings' && request.method === 'PUT') {
        const body = await readJsonBody(request);
        if (
          body.daily_open_target_pct !== undefined &&
          Number(body.daily_open_target_pct) !== DAILY_OPEN_TARGET_PCT
        ) {
          sendError(
            response,
            400,
            `本项目新增日开额度固定为 ${DAILY_OPEN_TARGET_PCT}%`,
          );
          return;
        }
        const numericRules = {
          target_annualized: [0.1, 20],
          hurdle_short: [0, 20],
          hurdle_medium: [0, 20],
          hurdle_long: [0, 20],
          liquidity_floor_pct: [0, 100],
          single_product_cap_pct: [0, 100],
          bucket_tolerance_pp: [0, 100],
          auto_confidence_threshold: [0, 100],
          scheduler_minutes: [1, 1440],
        };
        const patch = {};
        for (const [key, range] of Object.entries(numericRules)) {
          if (body[key] === undefined) continue;
          const value = Number(body[key]);
          if (
            !Number.isFinite(value) ||
            value < range[0] ||
            value > range[1]
          ) {
            sendError(
              response,
              400,
              `${key} 需要在 ${range[0]}–${range[1]} 之间`,
            );
            return;
          }
          patch[key] = value;
        }
        for (const key of [
          'automation_enabled',
          'notifications_enabled',
          'auto_confirm_reviews',
        ]) {
          if (body[key] !== undefined) patch[key] = Boolean(body[key]);
        }
        for (const key of ['rule_version', 'strategy_version']) {
          if (body[key] !== undefined) {
            const value = String(body[key]).trim();
            if (!value || value.length > 60) {
              sendError(response, 400, `${key} 不能为空或超过 60 个字符`);
              return;
            }
            patch[key] = value;
          }
        }
        const settings = repository.automationStore.updateSettings(patch);
        sendJson(response, 200, {
          settings,
          automation: repository.automationStore.getWorkspace(todayShanghai()),
        });
        return;
      }

      const evaluationApplyMatch = pathname.match(
        /^\/api\/evaluations\/(\d+)\/apply$/,
      );
      if (evaluationApplyMatch && request.method === 'POST') {
        const body = await readJsonBody(request);
        let rating = null;
        if (body.rating !== undefined) {
          rating = String(body.rating).trim();
          if (!DECISION_RATINGS.has(rating)) {
            sendError(response, 400, '评估结论不在允许范围内');
            return;
          }
        }
        let evaluation;
        try {
          evaluation = repository.automationStore.forceApplyRun(
            Number(evaluationApplyMatch[1]),
            {
              rating,
              summary: body.summary ? String(body.summary) : null,
            },
          );
        } catch (error) {
          sendError(response, 400, error.message);
          return;
        }
        if (!evaluation) {
          sendError(response, 404, '没有找到这条评估');
          return;
        }
        sendJson(response, 200, {
          evaluation,
          automation: repository.automationStore.getWorkspace(todayShanghai()),
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      const evaluationUndoMatch = pathname.match(
        /^\/api\/evaluations\/(\d+)\/undo$/,
      );
      if (evaluationUndoMatch && request.method === 'POST') {
        let evaluation;
        try {
          evaluation = repository.automationStore.undoRun(
            Number(evaluationUndoMatch[1]),
          );
        } catch (error) {
          sendError(response, 400, error.message);
          return;
        }
        if (!evaluation) {
          sendError(response, 404, '没有找到这条评估');
          return;
        }
        sendJson(response, 200, {
          evaluation,
          automation: repository.automationStore.getWorkspace(todayShanghai()),
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      if (pathname === '/api/notifications/read-all' && request.method === 'POST') {
        const notifications =
          repository.automationStore.markAllNotificationsRead();
        sendJson(response, 200, { notifications });
        return;
      }

      const notificationMatch = pathname.match(
        /^\/api\/notifications\/(\d+)\/(read|unread|resolve)$/,
      );
      if (notificationMatch && request.method === 'POST') {
        const notification = repository.automationStore.markNotification(
          Number(notificationMatch[1]),
          notificationMatch[2],
        );
        if (!notification) {
          sendError(response, 404, '没有找到这条提醒');
          return;
        }
        sendJson(response, 200, { notification });
        return;
      }

      const jobResolveMatch = pathname.match(
        /^\/api\/automation\/jobs\/(\d+)\/resolve$/,
      );
      if (jobResolveMatch && request.method === 'POST') {
        const body = await readJsonBody(request);
        let job;
        try {
          job = repository.automationStore.resolveJob(
            Number(jobResolveMatch[1]),
            {
              status: body.status || 'done',
              result: body.result || {},
              note: body.note || '',
            },
          );
        } catch (error) {
          sendError(response, 400, error.message);
          return;
        }
        if (!job) {
          sendError(response, 404, '没有找到这个任务');
          return;
        }
        sendJson(response, 200, {
          job,
          automation: repository.automationStore.getWorkspace(todayShanghai()),
        });
        return;
      }

      const draftMatch = pathname.match(
        /^\/api\/review\/drafts\/(monthly|quarterly)\/(\d{4}-(?:\d{2}|Q[1-4]))(?:\/(generate|confirm))?$/,
      );
      if (draftMatch) {
        const [, periodType, period, action] = draftMatch;
        const validPeriod =
          periodType === 'monthly'
            ? /^\d{4}-(0[1-9]|1[0-2])$/.test(period)
            : /^\d{4}-Q[1-4]$/.test(period);
        if (!validPeriod) {
          sendError(response, 400, '复盘周期格式不正确');
          return;
        }
        if (!action && request.method === 'GET') {
          const draft = repository.automationStore.getDraft(periodType, period);
          sendJson(response, 200, { draft });
          return;
        }
        if (action === 'generate' && request.method === 'POST') {
          const draft = repository.automationStore.generateDraft(
            periodType,
            period,
          );
          sendJson(response, 200, {
            draft,
            automation: repository.automationStore.getWorkspace(todayShanghai()),
          });
          return;
        }
        if (action === 'confirm' && request.method === 'POST') {
          const body = await readJsonBody(request);
          let result;
          try {
            result = repository.automationStore.confirmDraft(
              periodType,
              period,
              {
                answers: body.answers,
                conclusion: body.conclusion,
              },
            );
          } catch (error) {
            sendError(response, 400, error.message);
            return;
          }
          sendJson(response, 200, {
            ...result,
            dashboard: dashboardPayload(repository),
          });
          return;
        }
      }

      if (pathname === '/api/income/inbox' && request.method === 'GET') {
        sendJson(response, 200, {
          inbox: repository.listIncomeScreenshots(),
        });
        return;
      }

      if (pathname === '/api/income/inbox/prune' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const olderThanDays = Number(body.olderThanDays || 180);
        if (
          !Number.isInteger(olderThanDays) ||
          olderThanDays < 30 ||
          olderThanDays > 3650
        ) {
          sendError(response, 400, '保留天数需要是 30–3650 的整数');
          return;
        }
        const result = repository.incomeStore.pruneScreenshots({
          today: todayShanghai(),
          olderThanDays,
        });
        sendJson(response, 200, result);
        return;
      }

      if (pathname === '/api/income/inbox' && request.method === 'POST') {
        const body = await readJsonBody(request, 20 * 1024 * 1024);
        const decoded = decodeImagePayload(body);
        if (decoded.error) {
          sendError(response, 400, decoded.error);
          return;
        }
        const saved = repository.incomeStore.saveInboxImage({
          buffer: decoded.value.buffer,
          mime: decoded.value.mime,
          originalName: decoded.value.original_name,
        });
        if (saved.duplicate) {
          const dashboard = dashboardPayload(repository);
          sendJson(response, 200, {
            inbox: saved.item,
            duplicate: true,
            saved_valuations: [],
            valuation_conflicts: [],
            missing_product_codes: [],
            reconciliation: null,
            dashboard,
          });
          return;
        }
        const storedPath = path.join(
          repository.incomeInboxDir,
          saved.item.stored_name,
        );
        const ocr = await ocrImage(storedPath);
        const today = todayShanghai();
        const holdings = repository.tradeStore.getPortfolio();
        const parsed = parseIncomeText(ocr.text, {
          today,
          reportingDate: shiftDate(today, -1),
          products: holdings,
        });
        let item = repository.incomeStore.addInbox({
          original_name: saved.item.original_name,
          stored_name: saved.item.stored_name,
          mime: saved.item.mime,
          bytes: saved.item.bytes,
          sha256: saved.sha256,
          ocr_text: ocr.text,
          parsed,
          parse_confidence: parsed.confidence,
          record_date: parsed.date,
          error: ocr.ok ? '' : ocr.error,
        });
        let record = null;
        let autoApplied = false;
        let applyError = '';
        let savedValuations = [];
        let valuationConflicts = [];
        let missingProductCodes = parsed.missing_product_codes || [];
        let reconciliation = null;
        let incomeConflict = null;
        let incomeIgnored = false;
        const threshold = Number(
          repository.automationStore.getSettings().auto_confidence_threshold,
        );
        if (
          ocr.ok &&
          parsed.daily_pnl !== null &&
          parsed.confidence >= threshold
        ) {
          try {
            const applied = repository.applyIncomeScreenshot(item.id, parsed, {
              today,
            });
            item = applied.inbox;
            record = applied.conflict ? null : applied.record;
            savedValuations = applied.saved_valuations || [];
            valuationConflicts = applied.valuation_conflicts || [];
            missingProductCodes = applied.missing_product_codes || [];
            reconciliation = applied.reconciliation || null;
            incomeConflict = applied.conflict || null;
            incomeIgnored = Boolean(applied.ignored);
            autoApplied = !applied.conflict;
            applyError = applied.conflict
              ? '该日期已有不同收益，平台未覆盖；请在消息中心核对后人工修改。'
              : '';
          } catch (error) {
            applyError =
              error instanceof Error ? error.message : String(error);
            item = repository.incomeStore.updateInbox(item.id, {
              error: applyError,
            });
          }
        }
        const dashboard = dashboardPayload(repository);
        sendJson(response, 201, {
          inbox: item,
          record,
          duplicate: false,
          auto_applied: autoApplied,
          apply_error: applyError,
          saved_valuations: savedValuations,
          valuation_conflicts: valuationConflicts,
          missing_product_codes: missingProductCodes,
          reconciliation,
          income_conflict: incomeConflict,
          income_ignored: incomeIgnored,
          ocr: {
            ok: ocr.ok,
            language: ocr.language,
            error: ocr.error,
          },
          dashboard,
        });
        return;
      }

      const incomeImageMatch = pathname.match(
        /^\/api\/income\/inbox\/(\d+)\/image$/,
      );
      if (incomeImageMatch && request.method === 'GET') {
        const file = repository.incomeStore.getInboxFilePath(
          Number(incomeImageMatch[1]),
        );
        if (!file) {
          sendError(response, 404, '收益截图不存在或已清理');
          return;
        }
        fs.stat(file.path, (error, stats) => {
          if (error || !stats.isFile()) {
            sendError(response, 404, '收益截图不存在或已清理');
            return;
          }
          response.writeHead(200, {
            'Content-Type': file.mime,
            'Content-Length': stats.size,
            'Cache-Control': 'no-store',
            ...SECURITY_HEADERS,
          });
          if (request.method === 'HEAD') {
            response.end();
            return;
          }
          fs.createReadStream(file.path).pipe(response);
        });
        return;
      }

      const incomeApplyMatch = pathname.match(
        /^\/api\/income\/inbox\/(\d+)\/apply$/,
      );
      if (incomeApplyMatch && request.method === 'POST') {
        const body = await readJsonBody(request);
        const today = todayShanghai();
        let result;
        try {
          result = repository.applyIncomeScreenshot(
            Number(incomeApplyMatch[1]),
            {
              date: body.date,
              daily_pnl:
                body.daily_pnl === undefined || body.daily_pnl === null
                  ? undefined
                  : Number(body.daily_pnl),
              products: Array.isArray(body.products)
                ? body.products.map((item) => ({
                    ...item,
                    daily_pnl:
                      item.daily_pnl === undefined || item.daily_pnl === null
                        ? null
                        : Number(item.daily_pnl),
                    holding_amount:
                      item.holding_amount === undefined ||
                      item.holding_amount === null ||
                      item.holding_amount === ''
                        ? null
                        : Number(item.holding_amount),
                    confidence:
                      item.confidence === undefined ||
                      item.confidence === null
                        ? undefined
                        : Number(item.confidence),
                  }))
                : undefined,
              action: body.action,
              notes: body.notes,
            },
            { today },
          );
        } catch (error) {
          sendError(response, 400, error.message);
          return;
        }
        if (!result) {
          sendError(response, 404, '没有找到这张收益截图');
          return;
        }
        sendJson(response, 200, {
          ...result,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      const incomeIgnoreMatch = pathname.match(
        /^\/api\/income\/inbox\/(\d+)\/ignore$/,
      );
      if (incomeIgnoreMatch && request.method === 'POST') {
        const body = await readJsonBody(request);
        const inbox = repository.incomeStore.ignoreInbox(
          Number(incomeIgnoreMatch[1]),
          String(body.note || '忽略收益截图'),
        );
        if (!inbox) {
          sendError(response, 404, '没有找到这张收益截图');
          return;
        }
        sendJson(response, 200, {
          inbox,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      if (pathname === '/api/product-valuations' && request.method === 'GET') {
        const url = new URL(request.url, 'http://127.0.0.1');
        const productCode = String(url.searchParams.get('product_code') || '');
        if (productCode) {
          sendJson(response, 200, {
            detail: repository.productValuationStore.getProductDetail(
              productCode,
              todayShanghai(),
            ),
          });
          return;
        }
        sendJson(response, 200, {
          valuations: repository.productValuationStore.listValuations(),
          ...repository.productValuationStore.getWorkspace(
            todayShanghai(),
            repository.tradeStore.getPortfolio(),
          ),
        });
        return;
      }

      if (
        pathname === '/api/product-yield-settings' &&
        request.method === 'GET'
      ) {
        sendJson(response, 200, {
          settings: repository.productValuationStore.listYieldSettings(),
        });
        return;
      }

      const productYieldSettingMatch = pathname.match(
        /^\/api\/product-yield-settings\/([A-Za-z0-9-]+)$/,
      );
      if (productYieldSettingMatch && request.method === 'PUT') {
        const body = await readJsonBody(request);
        let setting;
        try {
          setting = repository.productValuationStore.saveYieldSetting(
            productYieldSettingMatch[1],
            body,
          );
        } catch (error) {
          sendError(response, 400, error.message);
          return;
        }
        sendJson(response, 200, {
          setting,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      if (pathname === '/api/product-valuations' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const today = todayShanghai();
        const yieldDate = String(body.yield_date || body.date || '');
        const creditDate = String(
          body.credit_date || body.valuation_date || yieldDate,
        );
        if (body.product_code && yieldDate) {
          if (yieldDate > today) {
            sendError(
              response,
              400,
              '产品收益归属日不能晚于今天',
            );
            return;
          }
          if (creditDate && creditDate < yieldDate) {
            sendError(response, 400, '到账/可见日期不能早于收益归属日');
            return;
          }
        }
        let result;
        try {
          result = repository.productValuationStore.upsertValuation(body, {
            source: 'manual-correction',
            auditNote: body.correction_note || '手工补录产品收益',
          });
        } catch (error) {
          sendError(response, 400, error.message);
          return;
        }
        const notification = result.conflict
          ? repository.flagProductIncomeConflict({
              date: yieldDate || body.date,
              productCode: body.product_code,
              existing: result.valuation.daily_pnl,
              incoming: body.daily_pnl,
              source: 'manual-product',
            })
          : null;
        sendJson(response, result.conflict ? 200 : 201, {
          valuation: result.valuation,
          conflict: result.conflict,
          notification_id: notification?.id ?? null,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      const productValuationMatch = pathname.match(
        /^\/api\/product-valuations\/(\d+)$/,
      );
      if (productValuationMatch && request.method === 'PUT') {
        const before = repository.productValuationStore.getValuation(
          Number(productValuationMatch[1]),
        );
        if (!before) {
          sendError(response, 404, '没有找到这条产品收益记录');
          return;
        }
        const body = await readJsonBody(request);
        const today = todayShanghai();
        const yieldDate = String(body.yield_date || before.yield_date || '');
        const creditDate = String(
          body.credit_date ||
            body.valuation_date ||
            before.credit_date ||
            yieldDate,
        );
        if (yieldDate > today) {
          sendError(
            response,
            400,
            '产品收益归属日不能晚于今天',
          );
          return;
        }
        if (creditDate < yieldDate) {
          sendError(response, 400, '到账/可见日期不能早于收益归属日');
          return;
        }
        let result;
        try {
          result = repository.productValuationStore.updateValuationById(
            Number(productValuationMatch[1]),
            {
              ...before,
              ...body,
              product_code: before.product_code,
              yield_date: yieldDate,
              credit_date: creditDate,
              source: 'manual-correction',
            },
            {
              source: 'manual-correction',
              auditNote: body.correction_note || '手工修正产品收益',
            },
          );
        } catch (error) {
          sendError(response, 400, error.message);
          return;
        }
        sendJson(response, 200, {
          valuation: result.valuation,
          conflict: result.conflict,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      if (pathname === '/api/trades' && request.method === 'GET') {
        sendJson(response, 200, {
          overview: repository.tradeStore.getOverview(todayShanghai()),
          inbox: repository.tradeStore.listInbox(),
        });
        return;
      }

      if (pathname === '/api/trades' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const validation = validateTradePayload(body);
        if (validation.error) {
          sendError(response, 400, validation.error);
          return;
        }
        if (
          validation.value.decision_id &&
          !repository
            .listDecisions()
            .some((item) => item.id === validation.value.decision_id)
        ) {
          sendError(response, 400, '关联决策不存在');
          return;
        }
        let trade;
        try {
          trade = repository.tradeStore.createTrade(validation.value, '页面手工录入');
        } catch (error) {
          sendError(
            response,
            error.code === 'DUPLICATE_TRADE' ? 409 : 400,
            error.message,
          );
          return;
        }
        trade = syncTradeDecisionAndEvaluate(
          repository,
          trade,
          'trade-create',
        );
        sendJson(response, 201, {
          trade,
          overview: repository.tradeStore.getOverview(todayShanghai()),
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      const tradeConfirmMatch = pathname.match(
        /^\/api\/trades\/(\d+)\/confirm$/,
      );
      if (tradeConfirmMatch && request.method === 'POST') {
        const id = Number(tradeConfirmMatch[1]);
        const body = await readJsonBody(request);
        const confirmDate = String(body.confirm_date || todayShanghai()).trim();
        if (!parseYmd(confirmDate)) {
          sendError(response, 400, '确认日期格式应为 YYYY-MM-DD');
          return;
        }
        if (confirmDate > todayShanghai()) {
          sendError(response, 400, '确认日期不能晚于今天');
          return;
        }
        let trade;
        try {
          trade = repository.tradeStore.confirmTrade(
            id,
            confirmDate,
            body.note || '页面确认',
          );
        } catch (error) {
          sendError(
            response,
            error.code === 'DUPLICATE_TRADE' ? 409 : 400,
            error.message,
          );
          return;
        }
        if (!trade) {
          sendError(response, 404, '没有找到这笔交易');
          return;
        }
        trade = syncTradeDecisionAndEvaluate(
          repository,
          trade,
          'trade-confirm',
        );
        sendJson(response, 200, {
          trade,
          overview: repository.tradeStore.getOverview(todayShanghai()),
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      const tradeCancelMatch = pathname.match(
        /^\/api\/trades\/(\d+)\/cancel$/,
      );
      if (tradeCancelMatch && request.method === 'POST') {
        const id = Number(tradeCancelMatch[1]);
        const body = await readJsonBody(request);
        let trade;
        try {
          trade = repository.tradeStore.cancelTrade(
            id,
            String(body.note || '页面撤销'),
          );
        } catch (error) {
          sendError(response, 400, error.message);
          return;
        }
        if (!trade) {
          sendError(response, 404, '没有找到这笔交易');
          return;
        }
        trade = syncTradeDecisionAndEvaluate(
          repository,
          trade,
          'trade-update',
        );
        sendJson(response, 200, {
          trade,
          overview: repository.tradeStore.getOverview(todayShanghai()),
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      const tradeAuditMatch = pathname.match(/^\/api\/trades\/(\d+)\/audit$/);
      if (tradeAuditMatch && request.method === 'GET') {
        const id = Number(tradeAuditMatch[1]);
        if (!repository.tradeStore.getTrade(id)) {
          sendError(response, 404, '没有找到这笔交易');
          return;
        }
        sendJson(response, 200, {
          audits: repository.tradeStore.getAudits(id),
        });
        return;
      }

      const tradeMatch = pathname.match(/^\/api\/trades\/(\d+)$/);
      if (tradeMatch && request.method === 'PUT') {
        const id = Number(tradeMatch[1]);
        const before = repository.tradeStore.getTrade(id);
        if (!before) {
          sendError(response, 404, '没有找到这笔交易');
          return;
        }
        const body = await readJsonBody(request);
        const validation = validateTradePayload({
          ...before,
          ...body,
          trade_date: body.trade_date ?? before.trade_date,
        });
        if (validation.error) {
          sendError(response, 400, validation.error);
          return;
        }
        if (
          validation.value.decision_id &&
          !repository
            .listDecisions()
            .some((item) => item.id === validation.value.decision_id)
        ) {
          sendError(response, 400, '关联决策不存在');
          return;
        }
        let trade;
        try {
          trade = repository.tradeStore.updateTrade(
            id,
            validation.value,
            body.note || '页面修改',
          );
        } catch (error) {
          sendError(
            response,
            error.code === 'DUPLICATE_TRADE' ? 409 : 400,
            error.message,
          );
          return;
        }
        trade = syncTradeDecisionAndEvaluate(
          repository,
          trade,
          'trade-update',
        );
        sendJson(response, 200, {
          trade,
          overview: repository.tradeStore.getOverview(todayShanghai()),
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      if (pathname === '/api/trades/inbox/prune' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const olderThanDays = body.olderThanDays
          ? Number(body.olderThanDays)
          : 180;
        if (
          !Number.isInteger(olderThanDays) ||
          olderThanDays < 30 ||
          olderThanDays > 3650
        ) {
          sendError(response, 400, '保留天数需要是 30–3650 的整数');
          return;
        }
        const result = repository.tradeStore.pruneScreenshots({
          today: todayShanghai(),
          olderThanDays,
        });
        sendJson(response, 200, {
          ...result,
          inbox: repository.tradeStore.listInbox(),
        });
        return;
      }

      if (pathname === '/api/trades/inbox' && request.method === 'GET') {
        sendJson(response, 200, {
          inbox: repository.tradeStore.listInbox(),
          overview: repository.tradeStore.getOverview(todayShanghai()),
        });
        return;
      }

      if (pathname === '/api/trades/inbox' && request.method === 'POST') {
        const body = await readJsonBody(request, 20 * 1024 * 1024);
        const decoded = decodeImagePayload(body);
        if (decoded.error) {
          sendError(response, 400, decoded.error);
          return;
        }
        const saved = repository.tradeStore.saveInboxImage({
          buffer: decoded.value.buffer,
          mime: decoded.value.mime,
          originalName: decoded.value.original_name,
        });
        if (saved.duplicate) {
          sendJson(response, 200, {
            inbox: saved.item,
            duplicate: true,
            overview: repository.tradeStore.getOverview(todayShanghai()),
          });
          return;
        }
        const storedPath = path.join(
          repository.tradeInboxDir,
          saved.item.stored_name,
        );
        const ocr = await ocrImage(storedPath);
        const parsed = parseTradeText(ocr.text, {
          products: repository.listProducts(),
          today: todayShanghai(),
        });
        const item = repository.tradeStore.addInbox({
          original_name: saved.item.original_name,
          stored_name: saved.item.stored_name,
          mime: saved.item.mime,
          bytes: saved.item.bytes,
          sha256: saved.sha256,
          ocr_text: ocr.text,
          parsed,
          parse_confidence: parsed.confidence,
          error: ocr.ok ? '' : ocr.error,
        });
        sendJson(response, 201, {
          inbox: item,
          duplicate: false,
          ocr: {
            ok: ocr.ok,
            language: ocr.language,
            error: ocr.error,
          },
          overview: repository.tradeStore.getOverview(todayShanghai()),
        });
        return;
      }

      const inboxImageMatch = pathname.match(
        /^\/api\/trades\/inbox\/(\d+)\/image$/,
      );
      if (inboxImageMatch && request.method === 'GET') {
        const file = repository.tradeStore.getInboxFilePath(
          Number(inboxImageMatch[1]),
        );
        if (!file) {
          sendError(response, 404, '截图不存在或已清理');
          return;
        }
        fs.stat(file.path, (error, stats) => {
          if (error || !stats.isFile()) {
            sendError(response, 404, '截图不存在或已清理');
            return;
          }
          response.writeHead(200, {
            'Content-Type': file.mime,
            'Content-Length': stats.size,
            'Cache-Control': 'no-store',
            ...SECURITY_HEADERS,
          });
          if (request.method === 'HEAD') {
            response.end();
            return;
          }
          fs.createReadStream(file.path).pipe(response);
        });
        return;
      }

      const inboxApplyMatch = pathname.match(
        /^\/api\/trades\/inbox\/(\d+)\/apply$/,
      );
      if (inboxApplyMatch && request.method === 'POST') {
        const id = Number(inboxApplyMatch[1]);
        const item = repository.tradeStore.getInboxItem(id);
        if (!item) {
          sendError(response, 404, '没有找到这张截图');
          return;
        }
        const body = await readJsonBody(request);
        const merged = { ...item.parsed, ...body };
        const validation = validateTradePayload(merged);
        if (validation.error) {
          sendError(response, 400, validation.error);
          return;
        }
        if (
          validation.value.decision_id &&
          !repository
            .listDecisions()
            .some((item) => item.id === validation.value.decision_id)
        ) {
          sendError(response, 400, '关联决策不存在');
          return;
        }
        let result;
        try {
          result = repository.tradeStore.applyInbox(id, validation.value);
        } catch (error) {
          sendError(
            response,
            error.code === 'DUPLICATE_TRADE' ? 409 : 400,
            error.message,
          );
          return;
        }
        result.trade = syncTradeDecisionAndEvaluate(
          repository,
          result.trade,
          'trade-inbox-apply',
        );
        sendJson(response, 200, {
          ...result,
          overview: repository.tradeStore.getOverview(todayShanghai()),
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      const inboxIgnoreMatch = pathname.match(
        /^\/api\/trades\/inbox\/(\d+)\/ignore$/,
      );

      const inboxVisionMatch = pathname.match(
        /^\/api\/trades\/inbox\/(\d+)\/vision-apply$/,
      );
      if (inboxVisionMatch && request.method === 'POST') {
        const id = Number(inboxVisionMatch[1]);
        const item = repository.tradeStore.getInboxItem(id);
        if (!item) {
          sendError(response, 404, '没有找到这张截图');
          return;
        }
        const body = await readJsonBody(request);
        const validation = validateTradePayload(body);
        if (validation.error) {
          sendError(response, 400, validation.error);
          return;
        }
        if (
          validation.value.decision_id &&
          !repository
            .listDecisions()
            .some((item) => item.id === validation.value.decision_id)
        ) {
          sendError(response, 400, '关联决策不存在');
          return;
        }
        const fields = validation.value;
        const parsed = item.parsed || {};
        const checks = [];
        const ocrAmount = Number(parsed.amount);
        if (Number.isFinite(ocrAmount) && ocrAmount > 0) {
          const pass = Math.abs(ocrAmount - fields.amount) <= 0.01;
          checks.push({
            key: 'amount',
            pass,
            ocr: ocrAmount,
            vision: fields.amount,
          });
          if (!pass && body.confirm_mismatch !== true) {
            sendJson(response, 409, {
              error: 'OCR 参考金额与视觉识别金额不一致，请人工确认后重试',
              code: 'OCR_AMOUNT_MISMATCH',
              ocr_amount: ocrAmount,
              vision_amount: fields.amount,
              checks,
            });
            return;
          }
        } else {
          checks.push({
            key: 'amount',
            pass: null,
            detail: 'OCR 未给出参考金额',
          });
        }
        const ocrCode = String(parsed.product_code || '').toUpperCase();
        if (ocrCode) {
          const pass = ocrCode === fields.product_code.toUpperCase();
          checks.push({
            key: 'product_code',
            pass,
            ocr: ocrCode,
            vision: fields.product_code,
          });
          if (!pass && body.confirm_mismatch !== true) {
            sendJson(response, 409, {
              error: 'OCR 参考代码与视觉识别代码不一致，请人工确认后重试',
              code: 'OCR_CODE_MISMATCH',
              ocr_code: ocrCode,
              vision_code: fields.product_code,
              checks,
            });
            return;
          }
        } else {
          checks.push({
            key: 'product_code',
            pass: null,
            detail: 'OCR 未识别到产品代码',
          });
        }
        const known = repository
          .listProducts()
          .find(
            (product) =>
              String(product.code).toUpperCase() ===
              fields.product_code.toUpperCase(),
          );
        checks.push({
          key: 'catalog',
          pass: Boolean(known),
          detail: known ? known.name : '产品库未收录该代码',
        });
        if (!known && body.allow_unknown_code !== true) {
          sendJson(response, 409, {
            error: '产品库中没有这个代码；如确认无误请允许未收录代码后重试',
            code: 'UNKNOWN_PRODUCT_CODE',
            checks,
          });
          return;
        }
        const existing = repository.tradeStore.findMatchingTrade(fields);
        if (!existing && body.create !== true) {
          sendJson(response, 409, {
            error: '没有找到匹配的已有交易；如确需新建请显式允许 create',
            code: 'NO_MATCHING_TRADE',
            checks,
          });
          return;
        }
        const confidence = Number(body.confidence);
        const inbox = repository.tradeStore.updateInbox(id, {
          parsed: {
            ...parsed,
            ...fields,
            ocr_reference: {
              amount: Number.isFinite(ocrAmount) ? ocrAmount : null,
              product_code: ocrCode || '',
            },
            vision: { at: new Date().toISOString(), checks },
          },
          parse_confidence: Number.isFinite(confidence)
            ? Math.max(0, Math.min(100, confidence))
            : 95,
          notes: String(body.note || '视觉识别写入').slice(0, 500),
        });
        const result = repository.tradeStore.applyInbox(id, fields);
        result.trade = syncTradeDecisionAndEvaluate(
          repository,
          result.trade,
          'trade-inbox-vision-apply',
        );
        sendJson(response, 200, {
          ...result,
          inbox,
          checks,
          vision: true,
          overview: repository.tradeStore.getOverview(todayShanghai()),
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      if (inboxIgnoreMatch && request.method === 'POST') {
        const id = Number(inboxIgnoreMatch[1]);
        const body = await readJsonBody(request);
        const inbox = repository.tradeStore.ignoreInbox(
          id,
          String(body.note || ''),
        );
        if (!inbox) {
          sendError(response, 404, '没有找到这张截图');
          return;
        }
        sendJson(response, 200, {
          inbox,
          overview: repository.tradeStore.getOverview(todayShanghai()),
        });
        return;
      }

      const inboxMatch = pathname.match(/^\/api\/trades\/inbox\/(\d+)$/);
      if (inboxMatch && request.method === 'PUT') {
        const id = Number(inboxMatch[1]);
        const before = repository.tradeStore.getInboxItem(id);
        if (!before) {
          sendError(response, 404, '没有找到这张截图');
          return;
        }
        const body = await readJsonBody(request);
        const validation = validateInboxOverridePayload(body);
        if (validation.error) {
          sendError(response, 400, validation.error);
          return;
        }
        const inbox = repository.tradeStore.updateInbox(id, {
          parsed: { ...before.parsed, ...validation.value },
          parse_confidence:
            validation.value.confidence ?? before.parse_confidence,
          notes: validation.value.notes ?? before.notes,
        });
        sendJson(response, 200, {
          inbox,
          overview: repository.tradeStore.getOverview(todayShanghai()),
        });
        return;
      }

      if (pathname === '/api/review/decisions' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const validation = validateDecisionPayload(body);
        if (validation.error) {
          sendError(response, 400, validation.error);
          return;
        }
        const decision = repository.createDecision(validation.value);
        evaluateDecisionChanges(repository, 'decision-create');
        sendJson(response, 201, {
          decision,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      const decisionMatch = pathname.match(/^\/api\/review\/decisions\/(\d+)$/);
      if (decisionMatch && request.method === 'PUT') {
        const id = Number(decisionMatch[1]);
        const body = await readJsonBody(request);
        const validation = validateDecisionPayload(body);
        if (validation.error) {
          sendError(response, 400, validation.error);
          return;
        }
        const decision = repository.updateDecision(id, validation.value);
        if (!decision) {
          sendError(response, 404, '没有找到这条决策记录');
          return;
        }
        evaluateDecisionChanges(repository, 'decision-update');
        sendJson(response, 200, {
          decision,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      if (decisionMatch && request.method === 'DELETE') {
        const id = Number(decisionMatch[1]);
        const linked = repository
          .tradeStore.listTrades()
          .find((trade) => trade.decision_id === id);
        if (linked) {
          sendJson(response, 409, {
            error: `决策 #${id} 已关联交易 #${linked.id}，请先改绑或撤销交易`,
          });
          return;
        }
        const deleted = repository.deleteDecision(id);
        if (!deleted) {
          sendError(response, 404, '没有找到这条决策记录');
          return;
        }
        repository.decisionProposalStore.detachDecision(
          id,
          `决策 #${id} 已删除，提案取消`,
        );
        repository.automationStore.discardDecisionEvaluations(
          id,
          `决策 #${id} 已删除`,
        );
        sendJson(response, 200, {
          deleted: true,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      if (pathname === '/api/review/holdings' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const validation = validateHoldingPayload(body);
        if (validation.error) {
          sendError(response, 400, validation.error);
          return;
        }
        const holding = repository.createHolding(validation.value);
        sendJson(response, 201, {
          holding,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      const holdingMatch = pathname.match(/^\/api\/review\/holdings\/(\d+)$/);
      if (holdingMatch && request.method === 'PUT') {
        const id = Number(holdingMatch[1]);
        const body = await readJsonBody(request);
        const validation = validateHoldingPayload(body);
        if (validation.error) {
          sendError(response, 400, validation.error);
          return;
        }
        const holding = repository.updateHolding(id, validation.value);
        if (!holding) {
          sendError(response, 404, '没有找到这笔持仓');
          return;
        }
        sendJson(response, 200, {
          holding,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      if (holdingMatch && request.method === 'DELETE') {
        const deleted = repository.deleteHolding(Number(holdingMatch[1]));
        if (!deleted) {
          sendError(response, 404, '没有找到这笔持仓');
          return;
        }
        sendJson(response, 200, {
          deleted: true,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      if (pathname === '/api/review/events' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const validation = validateProductEventPayload(body);
        if (validation.error) {
          sendError(response, 400, validation.error);
          return;
        }
        const event = repository.createProductEvent(validation.value);
        sendJson(response, 201, {
          event,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      const eventMatch = pathname.match(/^\/api\/review\/events\/(\d+)$/);
      if (eventMatch && request.method === 'PUT') {
        const id = Number(eventMatch[1]);
        const body = await readJsonBody(request);
        const validation = validateProductEventPayload(body);
        if (validation.error) {
          sendError(response, 400, validation.error);
          return;
        }
        const event = repository.updateProductEvent(id, validation.value);
        if (!event) {
          sendError(response, 404, '没有找到这条产品事件');
          return;
        }
        sendJson(response, 200, {
          event,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      if (eventMatch && request.method === 'DELETE') {
        const deleted = repository.deleteProductEvent(Number(eventMatch[1]));
        if (!deleted) {
          sendError(response, 404, '没有找到这条产品事件');
          return;
        }
        sendJson(response, 200, {
          deleted: true,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      const noteMatch = pathname.match(
        /^\/api\/review\/notes\/(\d{4}-(?:0[1-9]|1[0-2]))$/,
      );
      if (noteMatch && request.method === 'PUT') {
        const month = noteMatch[1];
        const body = await readJsonBody(request);
        const validation = validateReviewNotePayload(body, month, 5, '月度五问');
        if (validation.error) {
          sendError(response, 400, validation.error);
          return;
        }
        const note = repository.saveReviewNote(month, validation.value);
        sendJson(response, 200, {
          note,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      const quarterMatch = pathname.match(/^\/api\/review\/quarterly\/(\d{4}-Q[1-4])$/);
      if (quarterMatch && request.method === 'PUT') {
        const quarter = quarterMatch[1];
        const body = await readJsonBody(request);
        const validation = validateReviewNotePayload(body, quarter, 6, '季度清单');
        if (validation.error) {
          sendError(response, 400, validation.error);
          return;
        }
        const note = repository.saveQuarterlyNote(quarter, validation.value);
        sendJson(response, 200, {
          note,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      if (pathname === '/api/review/export' && request.method === 'GET') {
        const month =
          requestUrl.searchParams.get('month') || shiftMonth(todayShanghai(), -1);
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
          sendError(response, 400, '月份格式应为 YYYY-MM');
          return;
        }
        const payload = dashboardPayload(repository);
        const markdown = buildMonthlyReviewMarkdown({
          month,
          review: payload.review,
          decisions: payload.workspace.decisions.filter((item) =>
            item.date.startsWith(month),
          ),
          events: payload.workspace.events.filter((item) =>
            item.date.startsWith(month),
          ),
          note: repository.getReviewNote(month),
          holdings: payload.workspace.holdings,
          holdingsSummary: payload.workspace.holdings_summary,
          generatedAt: new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          }).format(new Date()),
        });
        response.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="r2-review-${month}.md"`,
          'Content-Length': Buffer.byteLength(markdown),
          'Cache-Control': 'no-store',
          ...SECURITY_HEADERS,
        });
        response.end(markdown);
        return;
      }

      if (pathname === '/api/records' && request.method === 'POST') {
        const body = await readJsonBody(request);
        const today = todayShanghai();
        const capitalState = repository.getCapitalState(today);
        if (!capitalState.initialized) {
          sendError(response, 400, '请先初始化本金账户，再记录收益');
          return;
        }
        const basicValidation = validateRecordPayload(body, {
          today,
        });
        if (basicValidation.error) {
          sendError(response, 400, basicValidation.error);
          return;
        }
        const existing = repository.getRecord(basicValidation.value.date);
        if (existing) {
          const sameValue =
            Math.abs(
              Number(existing.daily_pnl) -
                Number(basicValidation.value.daily_pnl),
            ) <= 0.005;
          if (sameValue) {
            sendJson(response, 200, {
              record: existing,
              duplicate: true,
              changed: false,
              conflict: null,
              dashboard: dashboardPayload(repository),
            });
            return;
          }
          const notification = repository.flagIncomeRecordConflict({
            date: basicValidation.value.date,
            existing,
            incoming: basicValidation.value.daily_pnl,
            source: 'manual',
          });
          sendJson(response, 200, {
            record: existing,
            duplicate: false,
            changed: false,
            conflict: {
              date: basicValidation.value.date,
              existing_daily_pnl: Number(existing.daily_pnl),
              incoming_daily_pnl: basicValidation.value.daily_pnl,
              difference:
                Math.round(
                  (basicValidation.value.daily_pnl -
                    Number(existing.daily_pnl)) *
                    100,
                ) / 100,
              notification_id: notification.id,
            },
            dashboard: dashboardPayload(repository),
          });
          return;
        }
        let record;
        try {
          record = repository.createRecord(basicValidation.value);
        } catch (error) {
          sendError(response, 400, error.message);
          return;
        }
        sendJson(response, 201, {
          record,
          duplicate: false,
          changed: true,
          conflict: null,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      const recordMatch = pathname.match(/^\/api\/records\/(\d{4}-\d{2}-\d{2})$/);
      if (recordMatch && request.method === 'PUT') {
        const date = recordMatch[1];
        if (!repository.getRecord(date)) {
          sendError(response, 404, '没有找到这条记录');
          return;
        }
        const body = await readJsonBody(request);
        if (body.date && body.date !== date) {
          sendError(response, 400, '修改记录时不能更改日期，请删除后重新记录');
          return;
        }
        const today = todayShanghai();
        const validation = validateRecordPayload(
          { ...body, date },
          {
            date,
            today,
          },
        );
        if (validation.error) {
          sendError(response, 400, validation.error);
          return;
        }
        let record;
        try {
          record = repository.updateRecord(date, validation.value);
        } catch (error) {
          sendError(response, 400, error.message);
          return;
        }
        sendJson(response, 200, { record, dashboard: dashboardPayload(repository) });
        return;
      }

      if (recordMatch && request.method === 'DELETE') {
        const date = recordMatch[1];
        const deleted = repository.deleteRecord(date);
        if (!deleted) {
          sendError(response, 404, '没有找到这条记录');
          return;
        }
        sendJson(response, 200, { deleted: true, dashboard: dashboardPayload(repository) });
        return;
      }

      if (pathname === '/api/export.csv' && request.method === 'GET') {
        const records = repository.listRecords();
        const csv = buildCsv(records);
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="r2-daily-log-${todayShanghai()}.csv"`,
          'Content-Length': Buffer.byteLength(csv),
          'Cache-Control': 'no-store',
        });
        response.end(csv);
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendError(response, 404, '接口不存在');
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendError(response, 405, '请求方法不支持');
        return;
      }
      serveStatic(request, response, pathname);
    } catch (error) {
      const message = error instanceof Error ? error.message : '服务器处理失败';
      const statusCode =
        error && Number.isInteger(error.statusCode) ? error.statusCode : 500;
      sendError(response, statusCode, message);
    }
  });
}

function startServer(options = {}) {
  const repository = openDatabase({
    dbPath: options.dbPath || process.env.R2_DB_PATH || DEFAULT_DB,
    productCsvPath: options.productCsvPath || DEFAULT_PRODUCT_CSV,
    tradeInboxDir:
      options.tradeInboxDir || process.env.R2_TRADE_INBOX_DIR || undefined,
  });
  try {
    const backup = createDailyBackup(repository.db, repository.dbPath, {
      dir: repository.backupDir,
    });
    pruneBackups(repository.backupDir, 45);
    if (backup.created) {
      console.log(`  每日备份：${backup.file}`);
    }
  } catch (error) {
    console.warn(`  每日备份失败：${error instanceof Error ? error.message : error}`);
  }
  try {
    const pruned = repository.tradeStore.pruneScreenshots({
      today: todayShanghai(),
      olderThanDays: 180,
    });
    if (pruned.removed > 0) {
      console.log(`  已清理 ${pruned.removed} 张超过 180 天的成交截图原图`);
    }
  } catch (error) {
    console.warn(`  截图清理失败：${error instanceof Error ? error.message : error}`);
  }
  let automationTimer = null;
  let lastAutomationCycle = 0;
  const runAutomation = (trigger) => {
    const result = repository.automationStore.runCycle({
      today: todayShanghai(),
      trigger,
    });
    lastAutomationCycle = Date.now();
    if (result.ok) {
      console.log(
        `  自动化 ${trigger}：评估 ${result.summary.evaluations_created} 条，待处理 ${result.summary.pending_jobs} 项`,
      );
    } else if (!result.skipped) {
      console.warn(`  自动化 ${trigger} 失败：${result.error}`);
    }
  };
  if (options.automation !== false) {
    const startupTimer = setTimeout(() => runAutomation('startup'), 250);
    startupTimer.unref?.();
    automationTimer = setInterval(() => {
      const settings = repository.automationStore.getSettings();
      if (!settings.automation_enabled) return;
      const minutes = Math.max(1, Number(settings.scheduler_minutes) || 5);
      if (Date.now() - lastAutomationCycle < minutes * 60 * 1000) return;
      runAutomation('interval');
    }, 60 * 1000);
    automationTimer.unref?.();
  }
  const server = createServer({ repository });
  const host = options.host || process.env.HOST || '127.0.0.1';
  const port = Number(options.port || process.env.PORT || 8765);

  server.listen(port, host, () => {
    console.log('');
    console.log('  钱多多已启动');
    console.log(`  打开：http://${host}:${port}`);
    console.log(`  数据库：${repository.dbPath}`);
    console.log('  按 Ctrl+C 停止服务');
    console.log('');
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 已被占用。可设置 PORT=其他端口后重试。`);
    } else {
      console.error(error);
    }
  });

  const shutdown = () => {
    if (automationTimer) clearInterval(automationTimer);
    server.close(() => {
      repository.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { server, repository };
}

if (require.main === module) {
  startServer();
}

module.exports = {
  buildCsv,
  createServer,
  dashboardPayload,
  isAllowedOrigin,
  resolveProductCsv,
  startServer,
  validateRecordPayload,
};
