'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HOME = 'https://finprod.paas.cmbchina.com/';
const API = `${HOME}api/prod/queryProdList`;
function loadPlaywright() {
  const candidates = [
    'playwright-core',
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
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next runtime path.
    }
  }
  throw new Error('未找到 playwright；请用 Codex 运行时 Node 执行。');
}

function findBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('未找到 Chrome/Edge；请设置 CHROME_PATH。');
  return found;
}

async function captureAuth(page) {
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
        referer: headers.referer || HOME,
      };
    }
  };
  page.on('request', onRequest);
  await page.goto(HOME, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(800);
  page.off('request', onRequest);
  if (!auth) throw new Error('未能从招行公开页面捕获接口签名。');
  return auth;
}

async function queryPage(page, state, pageNo, status, signal) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(API, {
      method: 'POST',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json;charset=UTF-8',
        origin: HOME.replace(/\/$/, ''),
        referer: state.auth.referer,
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36',
        appid: state.auth.appid,
        timespan: state.auth.timespan,
        signature: state.auth.signature,
        ...(state.auth.businessId ? { 'x-b3-businessid': state.auth.businessId } : {}),
      },
      body: JSON.stringify({
        keyWords: '',
        type: 'PN',
        isOwn: 'C',
        isPublic: 'Z',
        status,
        riskLevel: 'R2',
        crossFinance: 'Z',
        obligate: '',
        pageNO: pageNo,
        pageSize: 50,
      }),
    });
    if (response.status === 429 && attempt < 2) {
      await require('node:timers/promises').setTimeout(500 * (attempt + 1), undefined, { signal });
      continue;
    }
    if (!response.ok) throw new Error('公开产品列表 HTTP ' + response.status);
    const json = await response.json();
    if (json.code === 'SUC0000') return json.data;
    if (/signature|timespan|CFN0511/i.test(`${json.code} ${json.message || ''}`)) {
      state.auth = await captureAuth(page);
      continue;
    }
    throw new Error('公开产品列表返回异常');
  }
  throw new Error(`第 ${pageNo} 页重试失败`);
}


const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36';

async function openPublicBrowser(signal) {
  signal?.throwIfAborted();
  const browser = await loadPlaywright().chromium.launch({
    headless: true,
    executablePath: findBrowserExecutable(),
    timeout: 20000,
  });
  const close = () => browser.close().catch(() => {});
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) {
    await close();
    signal.throwIfAborted();
  }
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    return { context, close: async () => {
      signal?.removeEventListener('abort', close);
      await close();
    } };
  } catch (error) {
    signal?.removeEventListener('abort', close);
    await close();
    throw error;
  }
}

async function createProductListClient(context, signal) {
  const page = await context.newPage();
  const state = { auth: await captureAuth(page) };
  return {
    queryPage: (pageNo, status = '1') => queryPage(page, state, pageNo, status, signal),
  };
}

async function queryProducts(client, status, { strict = false } = {}) {
  const first = await client.queryPage(1, status);
  const reportedPages = first.totalPage || Math.ceil(first.totalSize / 50);
  const pages = strict || reportedPages > 0 ? reportedPages : 1;
  const total = Number(first.totalSize);
  const rows = [];
  if (!Number.isInteger(pages) || pages < 1 || pages > 100) throw new Error('公开产品列表分页异常');
  for (let page = 1; page <= pages; page += 1) {
    const data = page === 1 ? first : await client.queryPage(page, status);
    if (strict && (!Array.isArray(data.list) || Number(data.totalSize) !== total ||
        Number(data.totalPage ?? pages) !== pages || data.list.length !== Math.min(50, total - 50 * (page - 1)))) {
      throw new Error('公开产品列表分页不一致');
    }
    rows.push(...(data.list || []));
  }
  if (strict && (rows.length !== total || total === 0)) throw new Error('公开产品列表条数异常');
  return { rows, pages, total };
}

module.exports = { API, openPublicBrowser, createProductListClient, queryProducts, findBrowserExecutable };
