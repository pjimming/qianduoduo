'use strict';
// Public-data-only collector. Does not import a database or call local write APIs.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { gzipSync } = require('node:zlib');
const root = path.resolve(__dirname, '../../..');
const req = createRequire(path.join(root, 'package.json'));
const src = req('./server/modules/r2-screening/source');
const lists = req('./server/modules/r2-screening/product-list');
const products = req('./lib/products');
const policy = req('./server/modules/r2-screening/policy');
const { valuationCalendar, shanghaiTime } = req('./server/modules/r2-screening/calendar');
const mapping = path.join(root, 'scripts/fetch-cmb-r2-all.cjs');
const context = { require: createRequire(mapping), __dirname: path.dirname(mapping), module: { exports: {} }, console, process };
vm.runInNewContext(fs.readFileSync(mapping, 'utf8').split('main().catch')[0] + '\nmodule.exports={toProduct};', context);
const toProduct = context.module.exports.toProduct;
const now = () => new Date().toISOString();
const save = (name, data) => fs.writeFileSync(path.join(__dirname, name), gzipSync(JSON.stringify(data)));
async function parallel(items, visit) {
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < items.length) {
      const p = items[next++];
      await visit(p);
      if (++done % 50 === 0) console.log('collected', done, '/', items.length);
    }
  }));
}
async function main() {
  const started_at = now(), date = shanghaiTime(new Date()).date;
  const signal = AbortSignal.timeout(25 * 60 * 1000);
  const browser = await lists.openPublicBrowser(signal);
  const audit = { started_at, date, requests: [], failures: [], scope: 'CMB public agency R2/PR2 CNY public shares; isOwn=C; not all Chinese banks' };
  try {
    const client = await lists.createProductListClient(browser.context, signal);
    const logged = { queryPage: async (page, status) => {
      const at = now(); const body = await client.queryPage(page, status);
      audit.requests.push({ kind: 'pool', status, page, at, finished_at: now(), total: body.totalSize, pages: body.totalPage, count: body.list?.length });
      return body;
    } };
    const raw = [];
    for (const status of ['1', '2']) {
      // Unopened pool currently has 103 pages, beyond the production client's 100-page guard.
      const first = await logged.queryPage(1, status);
      const total = Number(first.totalSize), pages = Number(first.totalPage);
      if (!Number.isInteger(pages) || pages < 1 || pages > 200) throw new Error('audit pagination bound');
      for (let page = 1; page <= pages; page++) {
        const body = page === 1 ? first : await logged.queryPage(page, status);
        if (Number(body.totalSize) !== total || Number(body.totalPage) !== pages ||
          !Array.isArray(body.list) || body.list.length !== Math.min(50, total - (page - 1) * 50)) throw new Error('audit pagination mismatch');
        raw.push(...body.list);
      }
      console.log('pool status', status, total, 'pages', pages);
    }
    save('pool.json.gz', { raw, audit });
    const seen = new Set();
    const shares = [];
    for (const row of raw) {
      if (!['R2', 'PR2'].includes(row.risk) || row.ccynbr !== '10' || row.pubPrv !== 'A') continue;
      const key = row.saacod + '/' + row.code;
      if (seen.has(key)) { audit.failures.push({ key, kind: 'duplicate_pool' }); continue; }
      seen.add(key);
      const p = src.parsePool([{ ...row, statusText: '1' }])[0];
      p.raw_status = row.statusText;
      p.original = toProduct(row);
      p.list_checked_at = audit.requests.filter(q => q.kind === 'pool' && q.status === row.statusText).at(-1)?.finished_at;
      shares.push(p);
    }
    const targets = shares.filter(p => p.raw_status === '1' && (products.isObservationReady(p.original) ||
      (Number(p.performance['1m']) >= 2.15 && policy.fresh(p.performance_date, date))));
    console.log(JSON.stringify({ pool: raw.length, included: shares.length, targets: targets.length, original_ready: shares.filter(p => products.isObservationReady(p.original)).length }));
    const post = async (url, body) => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', referer: 'https://mbsearch.paas.cmbchina.com/finance' }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    };
    await parallel(targets, async p => {
      const at = now();
      try {
        const rawQuota = await post('https://searchagency.paas.cmbchina.com/mix/search', { keyword: p.code });
        p.quota = src.parseQuota(rawQuota, p, now());
        p.quota_raw = rawQuota?.body?.recommend?.content?.filter(r => r.code === p.code);
      } catch (e) { p.quota = { status: null, checked_at: now() }; audit.failures.push({ key: src.shareKey(p), kind: 'quota', message: e.message }); }
      p.quota_requested_at = at;
    });
    const shelf = await src.readShelf(signal, { maxShelfPages: 300 }, new Set(targets.map(src.shareKey)), () => new Date());
    audit.shelf = { pages: shelf.pages, state: shelf.state, covered: shelf.amounts.size, finished_at: now() };
    for (const p of targets) Object.assign(p.quota, shelf.amounts.get(src.shareKey(p)) ?? { amount_state: shelf.state });
    save('checkpoint.json.gz', { shares, audit });
    const cf = await src.createCfClient(browser.context, signal, {});
    await parallel(targets, async p => {
      try {
        p.detail_requested_at = now();
        p.detail_raw = await cf('/api/ProductInfo/getSAProductDetailInfo', p);
        p.detail_checked_at = now();
        p.detail = src.parseDetail(p.detail_raw, p, p.quota);
      } catch (e) { p.detail_issue = 'detail_unavailable'; audit.failures.push({ key: src.shareKey(p), kind: 'detail', message: e.message }); }
      try {
        p.nav_requested_at = now();
        p.nav = await src.readNav(cf, p, signal);
        p.nav_checked_at = now();
      } catch (e) { p.nav = { issue: e.code || 'nav_unavailable' }; audit.failures.push({ key: src.shareKey(p), kind: 'nav', message: e.message }); }
    });
    audit.finished_at = now();
    audit.calendar = { version: valuationCalendar.version, sources: valuationCalendar.sources };
    const rules = ['lib/products.js', 'lib/yield-policy.js', 'lib/r2-policy.js', 'scripts/fetch-cmb-r2-all.cjs', 'server/modules/r2-screening/source.js', 'server/modules/r2-screening/policy.js', 'server/modules/r2-screening/calendar.js', 'server/modules/r2-screening/product-list.js', 'docs/r2-product-screening-strategy.md'];
    audit.rules = rules.map(file => ({ file, sha256: src.hash(fs.readFileSync(path.join(root, file), 'utf8')), text: fs.readFileSync(path.join(root, file), 'utf8') }));
    save('evidence.json.gz', { shares, audit });
    console.log(JSON.stringify({ finished_at: audit.finished_at, shelf: audit.shelf, failures: audit.failures.length, v: policy.screen(shares, date, valuationCalendar).counts }));
  } catch (e) { audit.finished_at = now(); audit.error = e.message; save('failed-round.json.gz', audit); throw e; }
  finally { await browser.close(); }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
