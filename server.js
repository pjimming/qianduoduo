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
  summarize,
  todayShanghai,
} = require('./lib/metrics');
const { buildProductView } = require('./lib/products');
const { shiftMonth } = require('./lib/review-store');

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
 * 产品快照按文件名中的日期自动取最新一份；也可以用 R2_PRODUCT_CSV 指定。
 * 这样换一期 CSV 不需要改代码。
 */
function resolveProductCsv(rootDir = ROOT) {
  if (process.env.R2_PRODUCT_CSV) {
    return path.resolve(process.env.R2_PRODUCT_CSV);
  }
  const dataDir = path.join(rootDir, 'data');
  if (!fs.existsSync(dataDir)) {
    return path.join(dataDir, 'cmb_r2_products.csv');
  }
  const candidates = fs
    .readdirSync(dataDir)
    .filter((name) => /^cmb_r2_products.*\.csv$/i.test(name))
    .map((name) => {
      const filePath = path.join(dataDir, name);
      const match = /(\d{4}-\d{2}-\d{2})/.exec(name);
      return {
        filePath,
        date: match ? match[1] : '',
        mtime: fs.statSync(filePath).mtimeMs,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.mtime - a.mtime);

  return candidates[0]?.filePath || path.join(dataDir, 'cmb_r2_products.csv');
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

function readJsonBody(request) {
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
      if (size > 64 * 1024) {
        reject(new Error('请求内容过大'));
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
  if (expectation.length > 1000) return { error: '预期不能超过 1000 个字符' };
  const actualResult = String(payload.actual_result || '').trim();
  if (actualResult.length > 1000) return { error: '实际结果不能超过 1000 个字符' };
  const rating = String(payload.rating || '待评估').trim();
  if (!DECISION_RATINGS.has(rating)) {
    return { error: '事后评价不在允许范围内' };
  }
  return {
    value: {
      date,
      product_name: productName,
      action,
      reason,
      expectation,
      actual_result: actualResult,
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
    return { error: '持仓金额需要是大于 0 的数字' };
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
  lines.push(`- 总持仓金额：${moneyText(holdingsSummary.total_amount)}`);
  lines.push(
    `- 单只最高占比：${
      holdingsSummary.max_product
        ? `${holdingsSummary.max_product.name} ${pctText(holdingsSummary.max_product.pct, 1)}`
        : '—'
    }`,
  );
  lines.push(
    `- 日开 + 30 天内占比：${pctText(holdingsSummary.liquidity_ratio_pct, 1)}`,
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
    lines.push('| 产品 | 金额 | 买入日 | 期限 | 到期日 | 发行方 | 风险 |');
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

function dashboardPayload(repository) {
  const rawRecords = repository.listRecords();
  const records = enrichRecords(rawRecords);
  const today = todayShanghai();
  const todayRecord = rawRecords.find((record) => record.date === today) || null;
  const productView = buildProductView(repository.listProducts());
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
  const review = buildReview(records, today);

  return {
    meta: {
      today,
      target_annualized: TARGET_ANNUALIZED,
      has_today_record: Boolean(todayRecord),
      today_record: todayRecord,
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
    workspace: repository.getReviewWorkspace({ today, records, review }),
    capital: repository.getCapitalState(today),
    products: productView,
  };
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

      if (pathname === '/api/review/workspace' && request.method === 'GET') {
        sendJson(response, 200, {
          workspace: dashboardPayload(repository).workspace,
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
        sendJson(response, 200, {
          decision,
          dashboard: dashboardPayload(repository),
        });
        return;
      }

      if (decisionMatch && request.method === 'DELETE') {
        const deleted = repository.deleteDecision(Number(decisionMatch[1]));
        if (!deleted) {
          sendError(response, 404, '没有找到这条决策记录');
          return;
        }
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
        const basicValidation = validateRecordPayload(body);
        if (basicValidation.error) {
          sendError(response, 400, basicValidation.error);
          return;
        }
        if (repository.getRecord(basicValidation.value.date)) {
          sendError(response, 409, '这个日期已经有记录，请直接修改');
          return;
        }
        let record;
        try {
          record = repository.createRecord(basicValidation.value);
        } catch (error) {
          sendError(response, 400, error.message);
          return;
        }
        sendJson(response, 201, { record, dashboard: dashboardPayload(repository) });
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
        const validation = validateRecordPayload({ ...body, date }, { date });
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
