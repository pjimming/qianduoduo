#!/usr/bin/env node
'use strict';

/**
 * 自动更新招行 R2 产品快照。
 *
 * 主数据源：招行理财产品统一查询平台公开接口
 *   https://finprod.paas.cmbchina.com/api/prod/queryProdList
 * 辅助数据源：招行移动端公开 R2 货架（用于核对移动端展示年化和期限）
 *
 * 只读取公开页面和公开接口，不登录账户、不抓取实时额度、不替用户下单。
 * 额度、费率、赎回到账和实际可买状态仍需在招行 App 内复核。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const FINPROD_HOME = 'https://finprod.paas.cmbchina.com/';
const FINPROD_API = 'https://finprod.paas.cmbchina.com/api/prod/queryProdList';
const MOBILE_API = 'https://mobile.cmbchina.com/ientrustfinance/financelist/alllist';
const CORE_HEADERS = [
  'name',
  'code',
  'issuer',
  'risk_level',
  'term_days',
  'score',
  'min_amount',
  'annualized_yield',
  'benchmark',
  'return_1m_annualized',
  'return_3m_annualized',
  'return_6m_annualized',
  'return_1y_annualized',
  'return_since_inception_annualized',
  'status',
  'source',
  'data_date',
  'notes',
  'capacity',
];
const EXTRA_HEADERS = [
  'max_drawdown_pct',
  'negative_days_pct',
  'history_months',
  'fee_bps',
  'liquidity_days',
  'next_open_date',
];
const ALL_HEADERS = [...CORE_HEADERS, ...EXTRA_HEADERS];
const MAX_SNAPSHOT_AGE_DAYS = 7;

function loadPlaywright() {
  const candidates = [
    'playwright',
    path.join(
      os.homedir(),
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'node',
      'node_modules',
      'playwright',
    ),
  ];
  const errors = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(
    `未找到 playwright。请用 Codex 运行时 Node 运行，或设置 NODE_PATH。\n${errors.join('\n')}`,
  );
}

function findBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('未找到 Chrome/Edge 可执行文件；请设置 CHROME_PATH。');
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isoToUtcMs(value) {
  const text = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function daysBetween(left, right) {
  const leftMs = isoToUtcMs(left);
  const rightMs = isoToUtcMs(right);
  if (leftMs === null || rightMs === null) return null;
  return Math.round((rightMs - leftMs) / 86400000);
}

function parseChineseDate(value) {
  const text = String(value || '').trim();
  const chinese = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(text);
  if (chinese) {
    return `${chinese[1]}-${String(chinese[2]).padStart(2, '0')}-${String(chinese[3]).padStart(2, '0')}`;
  }
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return iso ? text : null;
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => String(value).trim() !== ''));
}

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) => {
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    return row;
  });
}

function writeCsv(filePath, rows) {
  const lines = [ALL_HEADERS.join(',')];
  for (const row of rows) {
    lines.push(ALL_HEADERS.map((header) => csvEscape(row[header] ?? '')).join(','));
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `\uFEFF${lines.join('\n')}\n`, 'utf8');
}

function latestSnapshotPath() {
  if (process.env.R2_PRODUCT_CSV) return path.resolve(process.env.R2_PRODUCT_CSV);
  if (!fs.existsSync(DATA_DIR)) return null;
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((name) => /^cmb_r2_products.*\.csv$/i.test(name))
    .map((name) => {
      const filePath = path.join(DATA_DIR, name);
      const match = /(\d{4}-\d{2}-\d{2})/.exec(name);
      return {
        filePath,
        date: match ? match[1] : '',
        mtime: fs.statSync(filePath).mtimeMs,
      };
    })
    .sort((left, right) => right.date.localeCompare(left.date) || right.mtime - left.mtime);
  return files.length ? files[0].filePath : null;
}

function textOr(value, fallback = '') {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text || fallback;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : '';
}

function performanceMap(product) {
  const map = {};
  for (const item of product?.pastPerf?.tqilstw4z3 || []) {
    const type = textOr(item.zprfTyp);
    const value = numberOrNull(item.zyeaYld);
    if (type && value !== null) map[type] = value;
  }
  return map;
}

function parseTermDays(product) {
  const text = `${textOr(product?.shortName)} ${textOr(product?.name)}`;
  const match = /(\d+)\s*天/.exec(text);
  if (match) return Number(match[1]);
  if (/日开/.test(text)) return 0;
  return null;
}

function parseMinAmount(product) {
  const value = numberOrNull(product?.buynfq);
  return value !== null && value > 0 ? value : null;
}

function computeFeeBps(product) {
  const parts = [product?.zchrCst, product?.chrmn2, product?.chrsal].map(numberOrNull);
  if (parts.some((part) => part === null)) return null;
  return parts.reduce((sum, part) => sum + part, 0) * 100;
}

function computeHistoryMonths(product) {
  const start = parseChineseDate(product?.zrunDat);
  const end = parseChineseDate(product?.zprfDat);
  if (!start || !end) return null;
  const days = daysBetween(start, end);
  return days !== null && days > 0 ? days / 30.44 : null;
}

function normalizeRateLabel(text) {
  const value = String(text || '');
  if (value.includes('1')) return '近1年年化';
  if (/成立|以来/.test(value)) return '成立以来年化';
  if (value.length >= 10) return '成立以来年化';
  return value;
}

async function captureFinprodAuth(page, { reload = false } = {}) {
  let auth = null;
  const onRequest = (request) => {
    if (!request.url().includes('/api/prod/queryProdList') || auth) return;
    const headers = request.headers();
    if (headers.appid && headers.timespan && headers.signature) {
      auth = {
        appid: headers.appid,
        timespan: headers.timespan,
        signature: headers.signature,
        businessId: headers['x-b3-businessid'],
        referer: headers.referer || FINPROD_HOME,
      };
    }
  };
  page.on('request', onRequest);
  if (reload) {
    await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
  } else {
    await page.goto(FINPROD_HOME, { waitUntil: 'networkidle', timeout: 60000 });
  }
  await page.waitForTimeout(800);
  page.off('request', onRequest);
  if (!auth) throw new Error('未能从招行理财产品统一查询平台捕获接口签名。');
  return auth;
}

async function refreshFinprodAuth(state) {
  state.auth = await captureFinprodAuth(state.page, { reload: true });
  return state.auth;
}

async function finprodPost(state, payload) {
  const send = async () => {
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json;charset=UTF-8',
      origin: FINPROD_HOME.replace(/\/$/, ''),
      referer: state.auth.referer || FINPROD_HOME,
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
      appid: state.auth.appid,
      timespan: state.auth.timespan,
      signature: state.auth.signature,
      'x-b3-businessid': state.auth.businessId,
    };
    const response = await fetch(FINPROD_API, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`查询接口返回非 JSON：${text.slice(0, 200)}`);
    }
    if (json.code !== 'SUC0000') {
      throw new Error(`查询接口返回 ${json.code}：${json.message || ''}`);
    }
    return json;
  };

  try {
    return await send();
  } catch (error) {
    if (/signature|签名|timespan|CFN0511/i.test(String(error.message))) {
      await refreshFinprodAuth(state);
      return send();
    }
    throw error;
  }
}

async function queryProduct(state, code) {
  const json = await finprodPost(state, {
    keyWords: code,
    type: 'PN',
    isOwn: 'C',
    isPublic: 'Z',
    status: '1',
    pageNO: 1,
    pageSize: 50,
    crossFinance: 'Z',
    riskLevel: 'R2',
    obligate: '',
  });
  return (json.data?.list || []).find((item) => item.code === code) || null;
}

async function fetchMobileTopR2() {
  const mh5aid = crypto.randomUUID().replaceAll('-', '');
  const msid = `msidun${crypto.randomUUID().replaceAll('-', '')}`;
  const uid = crypto.randomUUID().replaceAll('-', '');
  const timestamp = Date.now();
  const body = {
    prdTyp: 'F',
    encType: 'S',
    userInfo: '',
    yDalCod: '',
    yPagCnt: '',
    yRipCod: '',
    ySaaCod: '',
    prdInfoYS: [],
    ordTyp: 'A',
    timLmt: '',
    timLow: '',
    timHig: '',
    offRgn: '',
    ccyNbr: '',
    slfTag: '',
    selFst: '',
    bblTyp: '',
    evlLvl: 'R2',
    trnCst: '',
    prdFrm: '',
    buyNf: 'Z',
    hotFlg: '',
    ngtMkt: '',
    timTmp: timestamp,
    rseFrm: '',
  };
  const response = await fetch(MOBILE_API, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'application/json; charset=UTF-8',
      origin: 'https://mobile.cmbchina.com',
      referer: 'https://mobile.cmbchina.com/IEntrustFinance/financeproduct/financelist.html',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
      'x-mfe-timestamp': String(timestamp),
      'x-mfe-uid': uid,
      'x-mfe-msid': msid,
      'x-requested-with': 'XMLHttpRequest',
      cookie: `mh5aid=${mh5aid}; MFE_MSID2=${msid}`,
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (json.bizResult?.code !== 200) {
    throw new Error(`移动端 R2 货架返回异常：${json.sysCode} ${json.sysMsg || ''}`);
  }
  return json.bizResult.data?.prdList || [];
}

async function main() {
  const snapshotPath = latestSnapshotPath();
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    throw new Error('未找到现有产品快照 CSV。');
  }
  const existingRows = readCsv(snapshotPath);
  if (!existingRows.length) throw new Error(`快照为空：${snapshotPath}`);

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless: true,
    executablePath: findBrowserExecutable(),
  });

  try {
    const page = await browser.newPage({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
    });
    const state = { page, auth: await captureFinprodAuth(page) };

    let mobileTop = [];
    try {
      mobileTop = await fetchMobileTopR2();
    } catch (error) {
      console.warn(`移动端 R2 货架获取失败，继续使用统一查询平台：${error.message}`);
    }
    const mobileByCode = new Map(mobileTop.map((item) => [item.ripCod, item]));

    const updatedRows = [];
    const summary = [];
    const today = localDateString();

    for (const oldRow of existingRows) {
      const code = textOr(oldRow.code);
      if (!code) continue;
      if (code.includes('/')) {
        updatedRows.push({
          ...oldRow,
          notes: textOr(
            oldRow.notes,
            '多份额/新发产品，统一查询平台未自动更新；起购、费率与额度以 App 为准',
          ),
        });
        summary.push({ code, action: 'skipped-multi-share' });
        continue;
      }

      let product;
      try {
        product = await queryProduct(state, code);
      } catch (error) {
        updatedRows.push({
          ...oldRow,
          notes: `公开接口查询失败，保留上次快照：${error.message}`,
        });
        summary.push({ code, action: 'query-failed', error: error.message });
        continue;
      }

      if (!product) {
        updatedRows.push({
          ...oldRow,
          notes: textOr(
            oldRow.notes,
            '统一查询平台未返回该开放产品；保留上次快照，买入前请在 App 核验',
          ),
        });
        summary.push({ code, action: 'not-found' });
        continue;
      }

      const perf = performanceMap(product);
      const dataDate = parseChineseDate(product.zprfDat) || textOr(oldRow.data_date);
      if (perf.D === undefined) {
        updatedRows.push({
          ...oldRow,
          notes: '统一查询平台未返回近 1 年年化，保留上次快照；买入前请在 App 核验',
        });
        summary.push({ code, action: 'missing-1y' });
        continue;
      }

      const mobile = mobileByCode.get(code);
      const mobileRate = mobile ? numberOrNull(String(mobile.prdRat || '').replace('%', '')) : null;
      const nextOpen = parseChineseDate(product.begdat);
      const feeBps = computeFeeBps(product);
      const historyMonths = computeHistoryMonths(product);
      const notes = [
        '统一查询平台公开接口自动更新；1Y历史年化作为annualized_yield输入，不是预期',
        '额度、费率、赎回到账和可买状态仍需在招行 App 当日核验',
      ];
      if (nextOpen) notes.push(`下一开放日 ${nextOpen}`);
      if (mobile) {
        notes.push(`移动端展示 ${mobile.prdRat}`);
        if (mobileRate !== null && Math.abs(mobileRate - perf.D) > 0.05) {
          notes.push(`移动端与统一平台 1Y 差异 ${(mobileRate - perf.D).toFixed(2)} 个百分点，需复核`);
        }
      } else {
        notes.push('移动端首页未返回该代码');
      }

      const oldTerm = textOr(oldRow.term_days);
      const parsedTerm = parseTermDays(product);
      const minAmount = parseMinAmount(product);
      const nextRow = {
        ...oldRow,
        name: textOr(oldRow.name, textOr(product.shortName, product.name)),
        code,
        issuer: textOr(product.orgName, textOr(oldRow.issuer, '招银理财')),
        risk_level: textOr(product.risk, textOr(oldRow.risk_level, 'R2')),
        term_days: oldTerm !== '' ? oldTerm : parsedTerm === null ? '' : String(parsedTerm),
        min_amount: minAmount === null ? oldRow.min_amount : minAmount.toFixed(2),
        annualized_yield: perf.D.toFixed(2),
        benchmark: textOr(product.zbasPrf, oldRow.benchmark),
        return_1m_annualized: perf.A === undefined ? '' : perf.A.toFixed(2),
        return_3m_annualized: perf.B === undefined ? '' : perf.B.toFixed(2),
        return_6m_annualized: perf.C === undefined ? '' : perf.C.toFixed(2),
        return_1y_annualized: perf.D.toFixed(2),
        return_since_inception_annualized:
          perf.F === undefined ? oldRow.return_since_inception_annualized : perf.F.toFixed(2),
        status: textOr(product.statusText) === '1' ? '开放中' : '未开放',
        source: '招行理财产品统一查询平台-公开接口',
        data_date: dataDate,
        notes: notes.join('；'),
        fee_bps: feeBps === null ? oldRow.fee_bps : feeBps.toFixed(0),
        history_months: historyMonths === null ? oldRow.history_months : historyMonths.toFixed(1),
        next_open_date: nextOpen || oldRow.next_open_date || '',
      };
      updatedRows.push(nextRow);
      summary.push({
        code,
        name: nextRow.name,
        action: 'updated',
        dataDate: nextRow.data_date,
        return1m: nextRow.return_1m_annualized,
        return3m: nextRow.return_3m_annualized,
        return6m: nextRow.return_6m_annualized,
        return1y: nextRow.return_1y_annualized,
        feeBps: nextRow.fee_bps,
        nextOpen: nextRow.next_open_date,
      });
    }

    const freshRows = updatedRows.filter((row) => {
      if (!row.data_date || !row.return_1y_annualized) return false;
      const age = daysBetween(row.data_date, today);
      return age !== null && age >= 0 && age <= MAX_SNAPSHOT_AGE_DAYS;
    });
    const coreCount = existingRows.filter((row) => row.code && !String(row.code).includes('/')).length;
    const minimumFresh = Math.min(10, coreCount);
    if (freshRows.length < minimumFresh) {
      throw new Error(
        `只有 ${freshRows.length} 只产品拿到 7 天内数据，低于最低要求 ${minimumFresh}；不写入新快照。`,
      );
    }

    const outputPath = path.join(DATA_DIR, `cmb_r2_products-${today}.csv`);
    writeCsv(outputPath, updatedRows);

    let refreshResult = null;
    try {
      const response = await fetch('http://127.0.0.1:8765/api/products/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      refreshResult = { status: response.status, body: (await response.text()).slice(0, 300) };
    } catch (error) {
      refreshResult = { error: error.message };
    }

    console.log(
      JSON.stringify(
        {
          outputPath,
          sourceSnapshot: snapshotPath,
          rows: updatedRows.length,
          freshRows: freshRows.length,
          latestDataDate: freshRows
            .map((row) => row.data_date)
            .sort((left, right) => left.localeCompare(right))
            .at(-1),
          mobileTop: mobileTop.slice(0, 5).map((item) => ({
            code: item.ripCod,
            rate: item.prdRat,
            rateLabel: normalizeRateLabel(item.ratDes),
            term: item.terDay,
            info: item.prdInf,
          })),
          refreshResult,
          summary,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
