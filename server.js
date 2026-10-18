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

const ROOT = __dirname;
const DIST_DIR = path.join(ROOT, 'dist');
const PUBLIC_DIR = path.join(ROOT, 'public');
const STATIC_DIR = fs.existsSync(path.join(DIST_DIR, 'index.html')) ? DIST_DIR : PUBLIC_DIR;
const DEFAULT_DB = path.join(ROOT, 'data', 'r2_ledger.sqlite');
const ACTIONS = new Set(['无操作', '买入', '赎回', '切换']);

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
    review: buildReview(records, today),
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
        const refreshed = repository.refreshProducts();
        sendJson(response, 200, {
          refreshed,
          dashboard: dashboardPayload(repository),
        });
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
