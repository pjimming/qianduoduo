'use strict';

const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { API, openPublicBrowser, createProductListClient, queryProducts } = require('./product-list');
const { isoDate } = require('./calendar');
const { decimal, fresh, screen, evaluateProduct } = require('./policy');
const { fingerprint: stablePublicHash } = require('../r2-strategy/contract');

const VERSION = 'cmb-public-v1';
const SOURCE = 'cmb';
const CF = 'https://cfweb.paas.cmbchina.com';
const SEARCH_PAGE = 'https://mbsearch.paas.cmbchina.com/finance';
const SHELF_PAGE = 'https://mobile.cmbchina.com/IEntrustFinance/financeproduct/financelist.html';
const SEARCH = 'https://searchagency.paas.cmbchina.com/mix/search';
const SHELF = 'https://mobile.cmbchina.com/ientrustfinance/financelist/alllist';
const KEY = /^[a-zA-Z0-9_-]{1,40}$/;
const OPTIONS = { maxParallel: 4, maxShelfPages: 25 };
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const text = (value, max = 300) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const normalize = value => text(value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const shareKey = ({ channel, code }) => `${channel}/${code}`;
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const evidence = (kind, url, checked_at, summary) => ({ kind, url, checked_at, summary, hash: hash(summary) });

function sourceError(code, message, health) {
  return Object.assign(new Error(message), { code, health });
}

async function post(url, body, { headers, signal, fetcher = fetch } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const budget = AbortSignal.timeout(12000);
    const response = await fetcher(url, {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, budget]) : budget,
      headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 429 && attempt < 2) {
      const retry = Number(response.headers.get('retry-after'));
      await delay(retry > 0 ? Math.min(retry * 1000, 4000) : 500 * (attempt + 1), undefined, { signal });
      continue;
    }
    if (!response.ok) throw sourceError('source_http', '公开来源请求失败');
    return response.json();
  }
}

function publicDetail(share, tab = 'prodintro') {
  return `${CF}/Personal/saproductdetail?${new URLSearchParams({ saaCod: share.channel, funCod: share.code, type: tab })}#toTarget`;
}

function cfUrl(endpoint, share) {
  return CF + endpoint + (share ? '?' + new URLSearchParams({ saaCod: share.channel, funCod: share.code }) : '');
}

async function createCfClient(context, signal, options) {
  const sample = { channel: 'D07', code: '120056A' };
  const sampleUrl = publicDetail(sample);
  const page = await context.newPage();
  let authPromise;
  let capturedAt = 0;

  function capture(force = false) {
    if (!force && authPromise && Date.now() - capturedAt < 90000) return authPromise;
    capturedAt = Date.now();
    authPromise = (async () => {
      const target = cfUrl('/api/ProductInfo/getSAProductDetailInfo', sample);
      const [request] = await Promise.all([
        page.waitForRequest(req => req.url() === target && req.headers().signature, { timeout: 15000 }),
        page.goto(sampleUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }),
      ]);
      const headers = request.headers();
      return Object.fromEntries(['appid', 'timespan', 'signature', 'x-b3-businessid']
        .filter(key => headers[key]).map(key => [key, headers[key]]));
    })();
    return authPromise;
  }

  await capture();
  return async (endpoint, share, body) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = capture();
      const auth = await pending;
      const result = await post(cfUrl(endpoint, share), body, {
        ...options, signal, headers: { ...auth, referer: sampleUrl },
      });
      if (result.returnCode === 'SUC0000') return result.body;
      if (result.returnCode !== 'CFN0511' || attempt > 0) break;
      await (pending === authPromise ? capture(true) : authPromise);
    }
    throw sourceError('source_response', '招行一网通接口响应异常');
  };
}

function parsePool(rawRows) {
  const shares = [];
  const seen = new Set();
  for (const row of rawRows) {
    if (row.statusText !== '1' || !['R2', 'PR2'].includes(row.risk) || !row.ccynbr || !row.pubPrv) {
      throw sourceError('pool_scope', '权威产品池与请求范围不符');
    }
    const channel = text(row.saacod);
    const code = text(row.code);
    const key = shareKey({ channel, code });
    if (!KEY.test(channel) || !KEY.test(code) || seen.has(key)) {
      throw sourceError('pool_identity', '权威产品池份额缺失或重复');
    }
    seen.add(key);
    if (row.ccynbr !== '10' || row.pubPrv !== 'A') continue;
    const performance = {};
    for (const [label, type] of Object.entries({ '1m': 'A', '3m': 'B', '6m': 'C', '1y': 'D' })) {
      const history = row.pastPerf?.tqilstw4z3;
      const values = (Array.isArray(history) ? history : []).filter(item => item.zprfTyp === type);
      if (values.length === 1 && values[0].zripCod === code && values[0].zsaaCod === channel &&
          decimal(values[0].zyeaYld) !== null) performance[label] = values[0].zyeaYld;
    }
    shares.push({
      code, channel, name: text(row.name) || text(row.shortName), short_name: text(row.shortName),
      issuer: text(row.orgName), risk: row.risk, min_amount: text(row.buynfq) || (Number.isFinite(row.buynfq) ? String(row.buynfq) : null),
      restrictions: text(row.spclCustDsc) || text(row.obligate) || null,
      inception_date: isoDate(row.zrunDat), performance_date: isoDate(row.zprfDat), performance,
    });
  }
  if (!shares.length) throw sourceError('pool_scope', '权威产品池无符合范围的份额');
  return shares;
}

function parseQuota(result, share, checked_at) {
  const body = result?.body;
  if (result?.returnCode !== 'SUC0000' || !Array.isArray(body?.recommend?.content) ||
      body.search?.success !== true || body.recommend?.success !== true) {
    throw sourceError('quota_response', '公开额度接口结构异常');
  }
  const names = [share.name, share.short_name].map(normalize).filter(Boolean);
  const matches = body.recommend.content.filter(item => item.code === share.code &&
    item.source?.RIP_COD === share.code && item.source?.SAA_COD === share.channel &&
    names.includes(normalize(item.title)));
  const status = new Set(matches.map(row => row.quota_status));
  const row = matches[0];
  return {
    status: status.size === 1 && [0, 1].includes(row.quota_status) ? row.quota_status : null,
    status_new: Number.isInteger(row?.quota_status_new) ? row.quota_status_new : null,
    checked_at, amount: null, amount_state: 'not_checked',
    public_term: matches.length === 1 ? text(row.source?.OPN_DSC || row.source?.OPN_FQC) : null,
  };
}

function parseAmount(value) {
  const amount = text(value).normalize('NFKC');
  const match = amount.match(/剩余\s*额度\s*[:：]?\s*(?:[<>≤≥约]\s*)?([\d,.]+)\s*(万|亿)?元/);
  if (!match) return null;
  const numeric = Number(match[1].replaceAll(',', '')) * (match[2] === '亿' ? 1e8 : match[2] === '万' ? 1e4 : 1);
  return { amount: text(value), low_amount: Number.isFinite(numeric) && numeric <= 10000 };
}

async function readShelf(signal, options, targets, clock) {
  const amounts = new Map();
  const seen = new Set();
  let cursor = {};
  let pages = 0;
  try {
    for (; pages < options.maxShelfPages && ![...targets].every(key => amounts.has(key)); pages++) {
      const result = await post(SHELF, { evlLvl: 'R2', prdTyp: 'F', ordTyp: 'A', buyNf: 'Z', ...cursor },
        { ...options, signal, headers: { referer: SHELF_PAGE } });
      const data = result?.bizResult?.data;
      if (result?.bizResult?.code !== 200 || !Array.isArray(data?.prdList)) throw new Error('货架结构异常');
      for (const item of data.prdList) {
        const key = shareKey({ channel: item.saaCod, code: item.ripCod });
        if (!targets.has(key)) continue;
        const parsed = parseAmount(item.dxsTag);
        if (!amounts.get(key)?.amount) amounts.set(key, {
          ...(parsed || {}), amount_state: parsed ? 'public' : item.dxsTag ? 'unrecognized' : 'blank',
          amount_checked_at: clock().toISOString(),
        });
      }
      if (!data.prdList.length || !data.yRipCod) return { amounts, pages: pages + 1, state: 'not_covered' };
      cursor = Object.fromEntries(['yDalCod', 'yPagCnt', 'yRipCod', 'ySaaCod', 'timTmp']
        .filter(key => typeof data[key] === 'string' || Number.isFinite(data[key])).map(key => [key, data[key]]));
      const key = JSON.stringify(cursor);
      if (seen.has(key)) throw new Error('货架游标重复');
      seen.add(key);
    }
    return { amounts, pages, state: 'not_covered' };
  } catch {
    signal?.throwIfAborted();
    return { amounts, pages, state: 'request_failed' };
  }
}

function plain(html) {
  return String(html || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim().normalize('NFKC');
}

function parseDetail(body, share, quota) {
  if (body?.funCod !== share.code || body.saaCod !== share.channel) {
    throw sourceError('detail_identity', '产品详情份额不匹配');
  }
  const overview = typeof body.prdIntro === 'string' ? body.prdIntro.slice(0, 250000) : '';
  const clauses = [...overview.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match => plain(match[1]));
  const opening = clauses.filter(line => /^(产品运作|认购、申购、赎回安排|最短持有期限?|封闭期限?|封闭期安排|开放日|开放安排|赎回安排)/.test(line));
  const mode = opening.filter(line => /^(产品运作|最短持有|封闭期)/.test(line));
  const matchRows = clauses.length ? clauses : [plain(overview)];
  const label = normalize(body.style);
  const ruleText = mode.join(' ') + ' ' + (quota?.public_term ?? '');
  const dates = [
    ...ruleText.matchAll(/(?:最短持有(?:期限?|天数)|封闭(?:期限?|天数))\s*[:：]?\s*(?:为|不少于|不低于)?\s*[【\[]?(\d{1,4})[】\]]?\s*(?:个)?(?:自然)?[天日]/g),
    ...String(quota?.public_term ?? '').matchAll(/^(?:最短)?持[有满]\s*(\d{1,4})\s*(?:个)?[天日]后(?:每|可|$)/g),
  ];
  const days = new Set(dates.map(match => Number(match[1])));
  const renewal = opening.some(line => /(?:未赎回|未申请赎回|未提出赎回)[^。；]{0,45}(?:下一|下一个|自动)[^。；]{0,25}(?:周期|运作期|持有期)/.test(line));
  const fixed = /定期开放|定开/.test(ruleText);
  const rolling = /滚动持有|滚动运作|周期滚动/.test(ruleText) || renewal;
  const noLock = /(?:无|不设(?:置)?)最短持有/.test(ruleText);
  const hasLock = /(?:最短|最低)持有|(?:持有|持满).{0,12}[天日周月年]后|封闭/.test(ruleText);
  const daily = noLock || (!hasLock && /每日(?:可申赎|可赎回|开放申赎|开放申购和赎回)/.test(ruleText));
  const conflict = days.size > 1 || (noLock && [...days].some(value => value > 0));
  const day = days.size === 1 ? [...days][0] : null;
  const term = {
    kind: fixed ? 'periodic' : rolling ? 'rolling' : conflict ? 'conflict'
      : day !== null ? (/最短持有|持[有满]\s*\d/.test(ruleText) ? 'minimum' : 'closed')
      : daily ? 'daily' : 'unknown',
    days: fixed || rolling || conflict ? null : day ?? (daily ? 0 : null),
    basis: text([...mode, quota?.public_term].filter(Boolean).join(' · '), 1000) || null,
  };
  const allocation = matchRows.filter(line => /^(投资范围|投资比例|资产配置|资产配置比例)/.test(line));
  const equity = allocation.join(' ').match(/权益类(?:资产|投资)[^。；]{0,50}?(?:不超过|不高于|上限为|0\s*[-—~至]\s*)(\d+(?:\.\d+)?)\s*%/);
  const equity_upper_pct = equity ? Number(equity[1]) : null;
  const category = /存款类|存款型/.test(label) ? 'deposit'
    : /固收增强|固收\+|固定收益增强/.test(label) || equity_upper_pct > 0 ? 'enhanced'
      : /纯固收|纯债/.test(label) ? 'bond' : 'unknown';
  const valuation = matchRows.find(line => /交易日[^。；]{0,35}(?:估值|份额净值|单位净值)/.test(line) ||
    (/交易日(?:为|均为)[^。；]{0,24}开放日/.test(line) && /开放日(?:当天|当日)?(?:的|份额|单位)?净值/.test(line)));
  return {
    registration: /^Z\d{10,20}$/.test(body.regCode) ? body.regCode : null,
    term, category, category_basis: text(body.style) || null, equity_upper_pct,
    valuation_basis: valuation && !/每个自然日[^。；]{0,20}(?:估值|净值)|每日均为估值日/.test(matchRows.join(' ')) ? 'trading_days' : null,
    valuation_clause: valuation ? text(valuation, 520) : null,
    redemption_clause: text(opening.find(line => /赎回安排|开放安排/.test(line)), 1100) || null,
    allowed_assets: text(allocation.join(' '), 1200) || null,
    sale_channel: text(body.saleChannel) || null,
  };
}

async function readNav(cf, share, signal) {
  const points = [];
  const size = 500;
  const seen = new Set();
  let total, pages;
  for (let page = 1; page <= (pages ?? 1); page++) {
    signal?.throwIfAborted();
    const body = await cf('/api/ProductValue/getSAValueByPage', null, {
      saaCod: share.channel, funCod: share.code, pageIndex: page, pageSize: size,
    });
    if (page === 1) {
      total = body?.totalRecord;
      pages = body?.totalPage;
    }
    if (!Number.isInteger(total) || total < 0 || !Number.isInteger(pages) ||
        pages < 0 || pages > 15 || (total > 0 && pages !== Math.ceil(total / size)) ||
        body?.totalRecord !== total || body?.totalPage !== pages || !Array.isArray(body?.data) ||
        body.data.length !== Math.min(size, total - (page - 1) * size)) {
      throw sourceError('nav_pages', '净值分页不完整');
    }
    const fingerprint = hash(body.data.map(point => [point.znavDat, point.znavVal]));
    if (seen.has(fingerprint)) throw sourceError('nav_pages', '净值分页重复');
    seen.add(fingerprint);
    for (const point of body.data) {
      if (point.zripNbr !== share.code || point.zsaaCod !== share.channel) {
        throw sourceError('nav_identity', '净值销售份额不匹配');
      }
      const date = isoDate(point.znavDat);
      if (!date || decimal(point.znavVal, true) === null) throw sourceError('nav_invalid', '净值日或披露精度无法验证');
      points.push({ date, unit: point.znavVal, cumulative: text(point.znavCtl, 50) || null });
    }
  }
  if (points.length !== total) throw sourceError('nav_pages', '净值条数不一致');
  return { points, pages, total };
}

async function parallel(items, limit, signal, visit) {
  const queue = items.values();
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (const item of queue) {
      if (signal?.aborted) break;
      await visit(item);
    }
  }));
  signal?.throwIfAborted();
}

function publicPdf(content) {
  const link = String(content ?? '').match(/href=["'](https:\/\/[^"'\s<>]+\.pdf)["']/i)?.[1];
  if (!link) return null;
  const url = new URL(link);
  return ['s3gw.cmbchina.com', 'cfweb.paas.cmbchina.com', 'www.cmbchinawm.com'].includes(url.host) &&
    !url.username && !url.password ? url.href : null;
}

async function bookEvidence(cf, share, signal, options, clock) {
  const doc = await cf('/api/ProductNotice/getSAProductExplain', null, { saaCod: share.channel, funCod: share.code });
  const url = doc?.prdCode === share.code ? publicPdf(doc.content) : null;
  if (!url) return null;
  const response = await (options.fetcher ?? fetch)(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]), redirect: 'error',
  });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 15_000_000) return null;
  const digest = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 15_000_000) return null;
    digest.update(chunk);
  }
  return evidence('prospectus', url, clock().toISOString(), {
    document_hash: digest.digest('hex'), registration: share.detail.registration,
    title: text(doc.infoTitle), disclosure_date: isoDate(String(doc.addDate ?? '').slice(0, 10)),
    location: '产品基本信息、认购申购赎回、投资范围与策略', verified_terms: false,
  });
}

async function reportsEvidence(cf, share, clock) {
  const body = await cf('/api/ProductNotice/getSAProdIRList', share);
  if (!Array.isArray(body)) return null;
  const reports = body.map(item => ({
    id: /^\d{1,14}$/.test(String(item.id)) ? String(item.id) : null,
    title: text(item.infoTitle), date: isoDate(String(item.addDate ?? '').slice(0, 10)),
  })).filter(item => item.id && item.title && item.date).sort((a, b) => b.date.localeCompare(a.date));
  const newest = reports[0];
  const url = newest ? CF + '/personal/saprodnoticedetail?code=' + newest.id : publicDetail(share, 'prodir');
  return evidence('reports', url, clock().toISOString(), {
    title: newest?.title ?? null, disclosure_date: newest?.date ?? null, count: reports.length,
  });
}

async function collect({ date, calendar, signal, clock = () => new Date(), options: input = {} }) {
  const options = { ...OPTIONS, ...input };
  const browser = await (options.openBrowser ?? openPublicBrowser)(signal);
  const health = {};
  try {
    const client = await (options.listClient ?? createProductListClient)(browser.context, signal);
    const { rows, pages, total } = await queryProducts(client, '1', { strict: true });
    const shares = parsePool(rows);
    const listAt = clock().toISOString();
    health.pool = { requested: pages, ok: pages, total, included: shares.length };
    if (!shares.some(share => share.performance['1m'] !== undefined)) {
      throw sourceError('performance_unavailable', '公开近 1 月业绩来源全局不可用', health);
    }
    const passed = shares.filter(share => decimal(share.performance['1m']) !== null &&
      decimal(share.performance['1m']) >= decimal('2.15') && fresh(share.performance_date, date));
    health.quota = { requested: passed.length, ok: 0, matched: 0 };
    health.detail = { requested: 0, ok: 0 };
    health.nav = { requested: 0, ok: 0 };
    for (const share of shares) {
      share.evidence = [evidence('performance', API, listAt, {
        performance_date: share.performance_date, performance: share.performance,
        inception_date: share.inception_date, risk: share.risk, currency: 'CNY', public_offering: true,
        pages, total, source: SOURCE,
      })];
    }

    await parallel(passed, options.maxParallel, signal, async share => {
      try {
        const response = await post(SEARCH, { keyword: share.code }, { ...options, signal, headers: { referer: SEARCH_PAGE } });
        share.quota = parseQuota(response, share, clock().toISOString());
        health.quota.ok++;
        if (share.quota.status !== null) health.quota.matched++;
      } catch {
        share.quota = { status: null, checked_at: clock().toISOString(), amount_state: 'not_checked' };
      }
    });
    if (passed.length && !health.quota.matched) throw sourceError('quota_unavailable', '公开额度来源全局不可用', health);
    const open = passed.filter(share => share.quota?.status === 0);
    const shelf = await readShelf(signal, options, new Set(open.map(shareKey)), clock);
    health.shelf = { pages: shelf.pages, covered: shelf.amounts.size, state: shelf.state };
    for (const share of passed) {
      if (share.quota.status === 0) {
        Object.assign(share.quota, shelf.amounts.get(shareKey(share)) ?? { amount_state: shelf.state });
      }
      share.evidence.push(evidence('quota', SEARCH_PAGE, share.quota.checked_at, share.quota));
      if (share.quota.status === 0) {
        share.evidence.push(evidence('shelf', SHELF_PAGE, share.quota.amount_checked_at ?? clock().toISOString(), {
          pages: shelf.pages, amount: share.quota.amount ?? null, state: share.quota.amount_state,
        }));
      }
    }

    if (open.length) {
      const cf = await (options.cfClient ?? createCfClient)(browser.context, signal, options);
      await parallel(open, options.maxParallel, signal, async share => {
        health.detail.requested++;
        try {
          share.detail = parseDetail(await cf('/api/ProductInfo/getSAProductDetailInfo', share), share, share.quota);
          health.detail.ok++;
          share.evidence.push(evidence('detail', publicDetail(share), clock().toISOString(), share.detail));
        } catch {
          share.detail = null;
          share.detail_issue = 'detail_unavailable';
        }
        const term = share.detail?.term;
        if (term && (term.days > 190 || ['periodic', 'rolling', 'conflict'].includes(term.kind))) return;
        health.nav.requested++;
        try {
          share.nav = await readNav(cf, share, signal);
          if (share.nav.points.length) health.nav.ok++;
          share.evidence.push(evidence('nav', publicDetail(share, 'prodvalue'), clock().toISOString(), {
            total: share.nav.total, pages: share.nav.pages, points_hash: hash(share.nav.points), raw_precision: true,
          }));
        } catch (error) {
          share.nav = { issue: ['nav_pages', 'nav_identity', 'nav_invalid'].includes(error.code) ? error.code : 'nav_unavailable' };
        }
      });
      if (!health.detail.ok || (health.nav.requested && !health.nav.ok)) {
        throw sourceError('detail_nav_unavailable', '产品详情或净值来源全局不可用', health);
      }
      const provisional = screen(shares, date, calendar);
      const check = new Set(provisional.results.filter(row => ['eligible', 'watch'].includes(row.status)).map(shareKey));
      health.prospectus = { requested: check.size, ok: 0 };
      health.reports = { requested: check.size, ok: 0 };
      await parallel(open.filter(share => share.detail && check.has(shareKey(share))), options.maxParallel, signal, async share => {
        try {
          const proof = await bookEvidence(cf, share, signal, options, clock);
          if (proof) { share.evidence.push(proof); health.prospectus.ok++; }
        } catch {
          // The public overview remains available if the full document cannot be downloaded.
        }
        try {
          const proof = await reportsEvidence(cf, share, clock);
          if (proof) { share.evidence.push(proof); health.reports.ok++; }
        } catch {
          // The trade review shows the report as unverified.
        }
      });
    }
    return { products: shares, health, input: { list_pages: pages, list_total: total, share_count: shares.length, captured_at: listAt } };
  } catch (error) {
    error.health ??= health;
    throw error;
  } finally {
    await browser.close();
  }
}

// Public, same-share monitoring only. Unlike collect(), detail and NAV are
// attempted even for sold-out, below-yield and no-longer-listed shares. This
// function deliberately has no holding/lot/amount argument and persists nothing.
async function collectHoldingEvidence({ identities, date, calendar, signal: callerSignal, clock = () => new Date(), options: input = {} }) {
  if (!isoDate(date) || date !== isoDate(date) || typeof calendar?.isOpen !== 'function' ||
      !Array.isArray(identities) || identities.length > 128) throw sourceError('monitor_input', '监控日期、日历或份额范围无效');
  const seen = new Set();
  const targets = identities.map(identity => {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
        Object.keys(identity).some(key => !['source', 'channel', 'code'].includes(key)) ||
        identity.source !== SOURCE || !KEY.test(identity.channel) || !KEY.test(identity.code)) {
      throw sourceError('monitor_identity', '监控请求仅接受公开来源、渠道和销售份额身份');
    }
    const key = shareKey(identity);
    if (seen.has(key)) throw sourceError('monitor_identity', '监控份额身份重复');
    seen.add(key);
    return { source: SOURCE, channel: identity.channel, code: identity.code };
  }).sort((a, b) => compareText(shareKey(a), shareKey(b)));
  const options = { ...OPTIONS, ...input };
  if (!Number.isInteger(options.maxParallel) || options.maxParallel < 1 || options.maxParallel > 4) throw sourceError('monitor_input', '监控并发需在1至4之间');
  const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000);
  const health = { pool: { requested: 0, ok: 0, included: 0 }, detail: { requested: targets.length, ok: 0 },
    nav: { requested: targets.length, ok: 0 } };
  const items = [];
  const finish = () => {
    items.sort((a, b) => compareText(shareKey(a.identity), shareKey(b.identity)));
    const content = { scope: 'holding_monitor', business_date: date, collector_version: VERSION,
      items: items.map(row => ({ identity: row.identity, data: row.data, nav_hash: row.nav_hash,
        issues: row.issues, evidence: row.evidence.map(proof => ({ kind: proof.kind, hash: proof.hash, url: proof.url, summary: proof.summary })) })) };
    return { ...content, captured_at: clock().toISOString(), health, items, content_hash: stablePublicHash(content) };
  };
  if (!targets.length) return finish();
  const browser = await (options.openBrowser ?? openPublicBrowser)(signal);
  try {
    let shares = [], poolIssue = null;
    const occurrences = new Map();
    try {
      const client = await (options.listClient ?? createProductListClient)(browser.context, signal);
      const result = await queryProducts(client, '1', { strict: true });
      shares = parsePool(result.rows);
      for (const row of result.rows) {
        const code = text(row.code);
        occurrences.set(code, (occurrences.get(code) ?? 0) + 1);
      }
      health.pool = { requested: result.pages, ok: result.pages, included: shares.length, total: result.total };
    } catch (error) {
      signal.throwIfAborted();
      poolIssue = error.code ?? 'pool_unavailable';
      health.pool.issue = poolIssue;
    }
    const byIdentity = new Map(shares.map(row => [shareKey(row), row]));
    let cf, clientIssue = null;
    try { cf = await (options.cfClient ?? createCfClient)(browser.context, signal, options); }
    catch (error) { signal.throwIfAborted(); clientIssue = error.code ?? 'detail_client_unavailable'; }
    await parallel(targets, options.maxParallel, signal, async target => {
      // The ledger supplies a sales code but has no public channel field.
      // Resolve it only when the public list identifies exactly one share.
      const needsChannel = target.channel === SOURCE;
      const ambiguous = needsChannel && occurrences.get(target.code) > 1;
      const listed = needsChannel ? (ambiguous ? null : shares.find(share => share.code === target.code)) : byIdentity.get(shareKey(target));
      const identity = listed && needsChannel ? { ...target, channel: listed.channel } : target;
      const product = listed ? { ...listed } : { channel: identity.channel, code: identity.code, name: identity.code,
        issuer: '', performance: {}, performance_date: null };
      const proofs = [], issues = [];
      if (!listed) issues.push(poolIssue ?? (ambiguous ? 'share_identity_conflict' : 'share_not_listed'));
      if (listed) proofs.push(evidence('performance', API, clock().toISOString(), {
        performance_date: listed.performance_date, performance: listed.performance,
        inception_date: listed.inception_date, risk: listed.risk, currency: 'CNY', public_offering: true, source: SOURCE,
      }));
      // A source label is not a sales channel and cannot be used for detail or NAV.
      if ((listed || !needsChannel) && cf) {
        try {
          product.detail = parseDetail(await cf('/api/ProductInfo/getSAProductDetailInfo', identity), identity, null);
          health.detail.ok++;
          proofs.push(evidence('detail', publicDetail(identity), clock().toISOString(), product.detail));
        } catch (error) {
          signal.throwIfAborted();
          product.detail = null; product.detail_issue = error.code ?? 'detail_unavailable'; issues.push(product.detail_issue);
        }
        try {
          product.nav = await readNav(cf, identity, signal);
          if (product.nav.points.length) health.nav.ok++;
          proofs.push(evidence('nav', publicDetail(identity, 'prodvalue'), clock().toISOString(), {
            total: product.nav.total, pages: product.nav.pages, points_hash: hash(product.nav.points), raw_precision: true,
          }));
        } catch (error) {
          signal.throwIfAborted();
          product.nav = { issue: error.code ?? 'nav_unavailable' }; issues.push(product.nav.issue);
        }
      } else if (listed || !needsChannel) {
        product.detail_issue = clientIssue; product.nav = { issue: clientIssue }; issues.push(clientIssue);
      }
      const data = evaluateProduct(product, date, calendar);
      // The monitoring calculation must never acquire a candidate rank or quota
      // simply because this separately requested public evidence exists.
      data.shortlisted = false; data.rank = null;
      items.push({ identity, data, nav_hash: product.nav?.points?.length ? hash(product.nav.points) : null,
        evidence: proofs, issues: [...new Set(issues)], listed: Boolean(listed), automatic_eligible: false });
    });
    return finish();
  } finally { await browser.close(); }
}

module.exports = {
  VERSION, SOURCE, KEY, shareKey, hash, sourceError, collect, collectHoldingEvidence, parsePool, parseQuota, parseDetail, parseAmount,
  readNav, readShelf, publicPdf, publicDetail, createCfClient,
};
