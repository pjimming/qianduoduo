'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: wait } = require('node:timers/promises');
const { createServer, startServer } = require('../server.js');
const { openDatabase } = require('../lib/db');
const { openScreeningRepository } = require('../server/modules/r2-screening/repository');
const { createScreeningService } = require('../server/modules/r2-screening/service');
const { evaluateProduct, navMetrics, screen } = require('../server/modules/r2-screening/policy');
const { valuationCalendar, refreshCalendar, shanghaiTime, nextDue } = require('../server/modules/r2-screening/calendar');
const { parsePool, parseQuota, parseDetail, parseAmount, readNav, readShelf, publicPdf, collect, createCfClient } = require('../server/modules/r2-screening/source');
const { queryProducts } = require('../server/modules/r2-screening/product-list');
const ops = require('../scripts/r2-screening-db.cjs');
const fixture = require('./fixtures/r2-screening/2026-11-07.json');

const date = '2026-11-07';
const initial = '2026-11-07T04:00:00.000Z';
const calendar = valuationCalendar;
const versions = { rule: 'v9', refresh: refreshCalendar.version, valuation: calendar.version, collector: 'cmb-public-v1' };
const dates = ['2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];

const cleanup = new WeakMap();

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qdd-screen-test-'));
  const work = [];
  cleanup.set(t, work);
  t.after(async () => {
    for (const close of work.reverse()) await close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function nav(values, time = dates) {
  return { points: values.map((unit, i) => ({ date: time[i], unit })) };
}

function share(patch = {}) {
  return {
    code: 'S1', channel: 'D07', name: '产品一', issuer: '测试理财', performance_date: '2026-11-01',
    performance: { '1m': '2.15' }, quota: { status: 0, amount: '剩余额度 0.01 元', low_amount: true },
    detail: { term: { kind: 'minimum', days: 190 }, category: 'bond', valuation_basis: 'trading_days' },
    nav: nav(['1', '1.001', '1.002', '1.003', '1.004', '1.005', '1.006']),
    ...patch,
  };
}

function batch(products = [share()]) {
  return { products, input: { share_count: products.length }, health: { pool: { ok: 1, requested: 1 } } };
}

function storeIn(t, dir = folder(t)) {
  const store = openScreeningRepository(path.join(dir, 'screen.sqlite'), { initialize: true });
  cleanup.get(t).push(() => store.close());
  return store;
}

function enqueue(store, key, { trigger = 'manual', now = initial, day = date } = {}) {
  return store.enqueue({ trigger, date: day, key, now, versions });
}

async function until(lookup) {
  for (let i = 0; i < 200; i++) {
    const result = lookup();
    if (result) return result;
    await wait(10);
  }
  throw new Error('初筛状态未在测试时间内推进');
}

test('frozen public trial preserves gates, sample counts and stable shortlist', () => {
  const { counts, results } = screen(fixture.products, fixture.date, calendar);
  assert.deepEqual(counts, {
    eligible: 30, watch: 0, pending: 49, rejected: 905, total: 984, yield_pass: 162,
    yield_pending: 48, yield_rejected: 774, quota_open: 33, shortlisted: 17, frequent_zero: 6,
  });
  assert.equal(results.filter(row => row.reasons.some(r => r.code === 'sold_out')).length, 129);
  assert.equal(results.filter(row => row.reasons.some(r => r.code === 'term_exceeds')).length, 2);
  assert.equal(results.filter(row => row.reasons.some(r => r.code === 'rolling')).length, 1);
  assert.deepEqual(
    results.filter(row => row.shortlisted).map(row => row.code).sort(),
    screen([...fixture.products].reverse(), fixture.date, calendar).results.filter(row => row.shortlisted).map(row => row.code).sort(),
  );
});

test('yield, term, quota, and ranking gates preserve exact boundaries', () => {
  const evaluate = input => evaluateProduct(share(input), date, calendar);
  assert.equal(evaluate().status, 'eligible');
  assert.equal(evaluate({ performance: { '1m': '2.14' } }).status, 'rejected');
  assert.equal(evaluate({ performance_date: '2026-10-31' }).status, 'pending');
  assert.equal(evaluate({ performance_date: '2026-11-08' }).status, 'pending');
  for (const [kind, days, expected] of [
    ['minimum', 191, 'rejected'], ['periodic', null, 'rejected'],
    ['rolling', null, 'pending'], ['conflict', null, 'pending'], ['unknown', null, 'eligible'],
  ]) assert.equal(evaluate({ detail: { term: { kind, days }, category: 'bond' } }).status, expected);
  assert.equal(evaluate({ quota: { status: 1 } }).status, 'rejected');
  assert.equal(evaluate({ quota: { status: 2 } }).status, 'pending');
  assert.equal(evaluate({ quota: { status: 0, amount_state: 'request_failed' } }).quota.assumption, true);
  assert.equal(evaluate({ detail_issue: 'detail_unavailable' }).status, 'pending');
  const items = ['A5', 'A4', 'A1', 'A2', 'A3'].map((code, index) => share({ code, channel: index === 1 ? 'D06' : 'D07' }));
  items.push(share({ code: 'X1', detail: { term: { kind: 'unknown', days: null }, category: 'bond' } }));
  items.push(share({ code: 'X2', detail: { term: { kind: 'minimum', days: 190 }, category: 'unknown' } }));
  const { results } = screen(items, date, calendar);
  assert.deepEqual(results.filter(item => item.shortlisted).sort((a, b) => a.rank - b.rank).map(item => item.code), ['A4', 'A1', 'A2']);
  assert.equal(results.filter(item => item.rank === null && item.status === 'eligible').length, 2);
});

test('precise NAV handles closures, round-off, conflicts and zero counts', () => {
  for (let zeros = 0; zeros <= 4; zeros++) {
    const input = share({ nav: nav(dates.map((_, i) => `1.${String(Math.max(0, i - zeros)).padStart(7, '0')}`)) });
    input.nav.points.push({ date: '2026-11-01', unit: '8.00' });
    const result = evaluateProduct(input, date, calendar);
    assert.equal(result.metrics.zero_dates.length, zeros);
    assert.equal(result.hints.includes('frequent_zero'), zeros >= 3);
    assert.equal(result.status, 'eligible');
  }
  const points = nav(['1.0000000', '1.0000001'], dates.slice(-2));
  assert.equal(navMetrics(points, date, calendar, 'trading_days').zero_dates, null);
  points.points.push({ ...points.points[0], unit: '1.00000000' });
  assert.equal(navMetrics(points, date, calendar, 'trading_days').issue, null);
  points.points.push({ ...points.points[0], unit: '1.00000001' });
  assert.equal(navMetrics(points, date, calendar, 'trading_days').issue, 'nav_conflict');
  assert.equal(navMetrics(nav(['1', '1.001'], ['2026-09-29', '2026-10-01']), '2026-10-02', calendar).count, 1);
  assert.equal(navMetrics(nav(['1', '1.001'], ['2026-10-29', '2026-10-30']), date, calendar).issue, 'nav_stale');
});

test('drawdown compares exact ratios and identifies the first repair', () => {
  for (const [value, band] of [['0.9900001', 'pass'], ['0.99', 'watch'], ['0.985', 'watch'], ['0.9849999', 'reject']]) {
    const metrics = navMetrics(nav(['1', '1', value, '0.999', '1', '1.01', '1.02']), date, calendar, 'trading_days');
    assert.equal(metrics.drawdown.band, band);
    assert.equal(metrics.drawdown.peak_date, dates[0]);
    assert.equal(metrics.drawdown.repair_date, dates[4]);
    assert.equal(metrics.drawdown.repair_days, 2);
  }
  assert.equal(navMetrics(nav(['1', '0.98'], dates.slice(-2)), date, calendar).drawdown.recovery, 'unrepaired');
  assert.equal(navMetrics(nav(['1', '1'], dates.slice(-2)), date, calendar).drawdown.recovery, 'none');
});

test('month ends require an established valuation basis and exact valuation dates', () => {
  const days = ['2026-07-31', '2026-08-31', '2026-09-30', '2026-10-30', '2026-11-06'];
  const values = ['1.00', '1.03', '1.05', '1.06', '1.07'];
  assert.equal(navMetrics(nav(values, days), date, calendar, 'trading_days').trend, 'weak');
  assert.equal(navMetrics(nav(values, days), date, calendar).trend, 'pending');
  const missing = [...days];
  missing[2] = '2026-09-29';
  assert.equal(navMetrics(nav(values, missing), date, calendar, 'trading_days').trend, 'pending');
  assert.equal(navMetrics(nav(values, days), date, { ...calendar, start: '2026-08-01' }, 'trading_days').issue, 'calendar_gap');
});

test('source adapters validate identity, quota display, HTML clauses and pagination', async () => {
  const row = { saacod: 'D07', code: 'S1', risk: 'R2', ccynbr: '10', pubPrv: 'A', statusText: '1',
    name: '产品一', shortName: '产品（A）', zprfDat: '2026年11月06日',
    pastPerf: { tqilstw4z3: [{ zripCod: 'OTHER', zsaaCod: 'D07', zprfTyp: 'A', zyeaYld: '3.01' }] } };
  const [product] = parsePool([row, { ...row, saacod: 'D08' }]);
  assert.equal(product.performance['1m'], undefined);
  assert.throws(() => parsePool([row, row]), { code: 'pool_identity' });
  assert.throws(() => parsePool([{ ...row, risk: 'R3' }]), { code: 'pool_scope' });
  const match = { code: 'S1', title: '产品(A)', source: { RIP_COD: 'S1', SAA_COD: 'D07' }, quota_status: 0 };
  const response = matches => ({ returnCode: 'SUC0000', body: {
    search: { success: true }, recommend: { success: true, content: matches },
  } });
  assert.equal(parseQuota(response([match]), product, initial).status, 0);
  assert.equal(parseQuota(response([{ ...match, source: { ...match.source, SAA_COD: 'D08' } }]), product, initial).status, null);
  assert.equal(parseQuota(response([match, { ...match, quota_status: 1 }]), product, initial).status, null);
  assert.deepEqual(parseAmount('剩余额度 0.01 元'), { amount: '剩余额度 0.01 元', low_amount: true });
  assert.equal(parseAmount(''), null);
  const identity = { funCod: 'S1', saaCod: 'D07' };
  const overview = prdIntro => parseDetail({ ...identity, style: '纯固收', term: '365 天以上', datCyl: 365, prdIntro }, product);
  assert.equal(overview('<tr><td>最短持有期</td><td>90个自然日</td></tr>').term.days, 90);
  assert.equal(overview('<tr><td>存续期限</td><td>365天</td></tr>').term.days, null);
  assert.equal(overview('<tr><td>产品运作方式</td><td>定期开放</td></tr>').term.kind, 'periodic');
  assert.equal(overview('<tr><td>赎回安排</td><td>未赎回自动进入下一个周期</td></tr>').term.kind, 'rolling');
  assert.equal(overview('<tr><td>产品运作方式</td><td>不设置最短持有期，每日可申赎</td></tr>').term.days, 0);
  const conflict = parseDetail({
    ...identity, prdIntro: '<tr><td>产品运作方式</td><td>每日开放型，最短持有期270天</td></tr>',
  }, product, { public_term: '持有30天后每日可赎' });
  assert.equal(conflict.term.kind, 'conflict');
  assert.equal(conflict.term.days, null);
  assert.equal(overview('<tr><td>开放日</td><td>每个交易日为开放日，开放日可以申请申购。</td></tr>').valuation_basis, null);
  assert.equal(overview('<tr><td>认购、申购、赎回安排</td><td>每个交易日为开放日。赎回以开放日当天的净值确认。</td></tr>').valuation_basis, 'trading_days');
  assert.equal(publicPdf('<a href="https://example.com/private.pdf">bad</a>'), null);
  assert.equal(publicPdf('<a href="https://s3gw.cmbchina.com/document.pdf">good</a>'), 'https://s3gw.cmbchina.com/document.pdf');
  assert.deepEqual((await queryProducts({ queryPage: async () => ({ totalSize: 0, totalPage: 0, list: [] }) }, '2')).rows, []);
  await assert.rejects(queryProducts({ queryPage: async page => ({
    totalPage: 2, totalSize: 51, list: Array(page === 1 ? 50 : 0).fill(row),
  }) }, '1', { strict: true }), /分页不一致/);
  await assert.rejects(readNav(async () => ({
    totalRecord: 2, totalPage: 1, data: [{ znavDat: '20261105' }],
  }), product), { code: 'nav_pages' });
  await assert.rejects(readNav(async () => ({
    totalRecord: 1, totalPage: 1, data: [{ znavDat: '20261105', znavVal: '1.012', zripNbr: 'S1', zsaaCod: 'D08' }],
  }), product), { code: 'nav_identity' });
});

test('source guards rate limits, repeated shelf cursors, and global outage', async () => {
  const rows = [{ ripCod: 'S1', saaCod: 'D07', dxsTag: '' }];
  let requests = 0;
  const shelf = await readShelf(AbortSignal.timeout(5000), {
    maxShelfPages: 4,
    fetcher: async () => {
      requests++;
      if (requests === 1) return new Response(null, { status: 429 });
      return Response.json({ bizResult: { code: 200, data: { yRipCod: 'S1', ySaaCod: 'D07', prdList: rows } } });
    },
  }, new Set(['D07/S1', 'D07/S2']), () => new Date(initial));
  assert.equal(requests, 3);
  assert.equal(shelf.state, 'request_failed');
  assert.equal(shelf.amounts.get('D07/S1').amount_state, 'blank');
  let closed = false;
  await assert.rejects(collect({ date, calendar, signal: AbortSignal.timeout(2000), options: {
    openBrowser: async () => ({ context: null, close: async () => { closed = true; } }),
    listClient: async () => ({ queryPage: async () => ({ totalSize: 1, totalPage: 1, list: [{
      saacod: 'D07', code: 'S1', risk: 'R2', ccynbr: '10', pubPrv: 'A', statusText: '1', name: '产品一',
      zprfDat: '20261106', pastPerf: { tqilstw4z3: [{ zripCod: 'S1', zsaaCod: 'D07', zprfTyp: 'A', zyeaYld: '3' }] },
    }] }) }),
    fetcher: async () => new Response(null, { status: 503 }),
  } }), { code: 'quota_unavailable' });
  assert.equal(closed, true);
});

test('store checks aliases and restores its independent, verified snapshot', t => {
  const dir = folder(t);
  const target = path.join(dir, 'screen.sqlite');
  const ledger = path.join(dir, 'ledger.sqlite');
  fs.writeFileSync(ledger, 'ledger');
  const alias = path.join(dir, 'alias.sqlite');
  fs.linkSync(ledger, alias);
  assert.throws(() => openScreeningRepository(ledger, { initialize: true, ledgerPath: ledger }), /独立路径/);
  assert.throws(() => openScreeningRepository(alias, { initialize: true, ledgerPath: ledger }), /独立文件/);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    assert.throws(() => openScreeningRepository(target, {
      initialize: true, ledgerPath: target + suffix,
    }), /独立路径/);
  }
  fs.linkSync(ledger, target + '-wal');
  assert.throws(() => openScreeningRepository(target, { initialize: true, ledgerPath: ledger }), /独立文件/);
  assert.equal(fs.existsSync(target), false);
  fs.unlinkSync(target + '-wal');
  const unknown = path.join(dir, 'unknown.sqlite');
  const db = new DatabaseSync(unknown);
  db.exec('CREATE TABLE daily_records (id INTEGER)');
  db.close();
  assert.throws(() => openScreeningRepository(unknown, { initialize: true }), /不匹配/);

  const store = openScreeningRepository(target, { initialize: true });
  try {
    assert.equal(store.verify().version, 1);
    enqueue(store, 'backup-key');
    const snapshot = ops.backup(target, path.join(dir, 'backups'), 'test');
    assert.equal(snapshot.runs, 1);
    assert.throws(() => ops.restore(target, snapshot.file, dir), /已停止/);
    store.close();
    assert.throws(() => ops.restore(target, unknown, dir), /不匹配/);
    assert.equal(ops.verify(target).runs, 1);
    assert.equal(fs.existsSync(target + '-wal'), false);
    assert.equal(fs.existsSync(target + '-shm'), false);
    const restored = ops.restore(target, snapshot.file, dir);
    assert.equal(restored.restored.runs, 1);
    assert.equal(restored.safety.runs, 1);
  } finally { try { store.close(); } catch {} }
  assert.equal(fs.readFileSync(ledger, 'utf8'), 'ledger');
});

test('manual and scheduled claims, expired worker token and midnight are isolated', t => {
  const dir = folder(t);
  const store = storeIn(t, dir);
  const peer = openScreeningRepository(store.dbPath);
  cleanup.get(t).push(() => peer.close());
  const { run } = enqueue(store, 'manual-key');
  assert.equal(enqueue(peer, 'manual-key').run.id, run.id);
  assert.equal(enqueue(peer, 'other-key').conflict, true);
  const scheduled = enqueue(peer, null, { trigger: 'scheduled' }).run;
  const claim = store.take(date, initial, versions);
  assert.equal(claim.run.id, run.id);
  assert.equal(peer.take(date, initial, versions), null);
  const later = '2026-11-07T04:01:00.000Z';
  const replacement = peer.take(date, later, versions);
  assert.equal(replacement.run.id, scheduled.id);
  assert.equal(store.get(run.id).status, 'interrupted');
  const input = batch();
  const output = screen(input.products, date, calendar);
  assert.equal(store.publish(claim.token, later, date, input, output, false), false);
  assert.equal(store.publish(replacement.token, later, '2026-11-08', input, output, false), false);
  assert.equal(store.publish(replacement.token, later, date, input, output, false), true);
  assert.equal(peer.current().id, scheduled.id);
});

test('failed publish rolls back all rows and a corrected NAV keeps both histories', t => {
  const store = storeIn(t);
  function publish(key, input) {
    const { run } = enqueue(store, key);
    const claim = store.take(date, initial, versions);
    const result = screen(input.products, date, calendar);
    return { run, claim, commit: () => store.publish(claim.token, initial, date, input, result, false) };
  }
  const first = publish('publish-1', batch());
  assert.equal(first.commit(), true);
  const repeatedEvidence = { kind: 'nav', url: 'https://cfweb.paas.cmbchina.com/', hash: 'test', summary: {}, checked_at: initial };
  const second = publish('publish-2', batch([share({ evidence: [repeatedEvidence, repeatedEvidence] })]));
  assert.throws(second.commit, /UNIQUE/);
  assert.equal(store.current().id, first.run.id);
  assert.equal(store.result(second.run.id, 'D07', 'S1'), undefined);
  store.finish(second.claim.token, initial, { status: 'failed', code: 'publish_failed', message: 'test' });
  const third = publish('publish-3', batch([share({ nav: nav(['1', '1.04'], dates.slice(-2)) })]));
  assert.equal(third.commit(), true);
  assert.notEqual(store.result(first.run.id, 'D07', 'S1').nav_series_id, store.result(third.run.id, 'D07', 'S1').nav_series_id);
  const fourth = publish('publish-4', batch([share({ nav: nav(['1', '1.04'], dates.slice(-2)) })]));
  assert.equal(fourth.commit(), true);
  assert.equal(store.result(fourth.run.id, 'D07', 'S1').nav_series_id, store.result(third.run.id, 'D07', 'S1').nav_series_id);
  assert.equal(store.verify().runs, 4);
});

test('a partially collected product pool cannot replace the last published batch', async t => {
  const store = storeIn(t);
  let complete = true;
  const service = createScreeningService({
    repository: store, enabled: true, schedule: false, clock: () => new Date(initial),
    collector: async () => {
      const input = batch();
      if (!complete) input.health.pool.requested++;
      return input;
    },
  });
  cleanup.get(t).push(() => service.stop());
  const { run: first } = service.manual('complete-pool');
  await until(() => store.current()?.id === first.id);
  complete = false;
  const { run: partial } = service.manual('partial-pool');
  await until(() => store.get(partial.id).status === 'failed');
  assert.equal(store.get(partial.id).error_code, 'publish_failed');
  assert.equal(store.current().id, first.id);
  assert.equal(store.result(partial.id, 'D07', 'S1'), undefined);
});

test('scheduler separates Shanghai noon, holidays, catch-up, retry and restart', async t => {
  const store = storeIn(t);
  let now = new Date('2026-10-05T04:00:00Z');
  let fails = true;
  const setup = () => createScreeningService({
    repository: store, enabled: true, clock: () => now,
    collector: async () => { if (fails) throw new Error('secret external failure'); return batch(); },
  });
  assert.deepEqual(shanghaiTime(new Date('2026-10-08T03:59:00Z')), { date: '2026-10-08', hour: 11, minute: 59 });
  assert.equal(nextDue(now, refreshCalendar), '2026-10-08T12:00:00+08:00');
  let service = setup();
  service.tick();
  now = new Date('2026-10-08T03:59:00Z');
  service.tick();
  assert.equal(store.last(), null);
  now = new Date('2026-10-08T04:00:00Z');
  service.tick();
  const first = await until(() => store.last()?.retry_at && store.last());
  assert.equal(first.trigger, 'scheduled');
  assert.equal(first.status, 'queued');
  assert.equal(first.error_message.includes('secret'), false);
  await service.stop();
  service = setup();
  service.tick();
  assert.equal(store.attempts(first.id).length, 1);
  fails = false;
  now = new Date('2026-10-08T04:01:00Z');
  service.tick();
  await until(() => store.current()?.id === first.id);
  service.tick();
  assert.equal(store.attempts(first.id).length, 2);
  await service.stop();
  now = new Date('2026-10-10T05:00:00Z'); // Saturday make-up day
  service = setup();
  service.tick();
  assert.equal(store.last().id, first.id);
  await service.stop();
  now = new Date('2026-10-12T06:00:00Z');
  service = setup();
  service.tick();
  await until(() => store.current()?.business_date === '2026-10-12');
  assert.equal(store.current().trigger, 'startup');
  await service.stop();
});

test('HTTP endpoints pin history, validate parameters, and preserve the ledger and store on reads', async t => {
  const dir = folder(t);
  const ledgerPath = path.join(dir, 'ledger.sqlite');
  const ledger = openDatabase({ dbPath: ledgerPath, backupDir: dir, tradeInboxDir: dir, logger: { warn() {} } });
  const store = storeIn(t, dir);
  const service = createScreeningService({
    repository: store, enabled: true, schedule: false, clock: () => new Date(initial),
    collector: async () => batch([share()]),
  });
  const server = createServer({ repository: ledger, screening: service });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.get(t).push(async () => { await service.stop(); await new Promise(resolve => server.close(resolve)); ledger.close(); });
  const root = `http://127.0.0.1:${server.address().port}`;
  const base = root + '/api/r2-screening';
  const get = suffix => fetch(base + suffix);
  const keys = ['product_daily_valuations', 'daily_records', 'trade_transactions', 'capital_settings'];
  const fingerprint = () => keys.map(key => ledger.db.prepare('SELECT * FROM ' + key).all());
  const facts = fingerprint();
  const oldProducts = await (await fetch(root + '/api/dashboard/products')).json();
  const start = await fetch(base + '/runs', { method: 'POST', headers: { 'Idempotency-Key': 'test-run-key' } });
  assert.equal(start.status, 202);
  const { run } = await start.json();
  const second = await fetch(base + '/runs', { method: 'POST', headers: { 'Idempotency-Key': 'test-run-key' } });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).run.id, run.id);
  assert.equal((await fetch(base + '/runs', { method: 'POST', headers: {
    'Idempotency-Key': 'other-key', Origin: 'https://example.com',
  } })).status, 403);
  await until(() => store.current());
  const status = await (await get('/status')).json();
  assert.equal(status.availability, 'ready');
  assert.equal(JSON.stringify(status).includes(dir), false);
  assert.equal((await get('/results?run_id=0')).status, 400);
  assert.equal((await get('/results?limit=101')).status, 400);
  assert.equal((await get('/results?sort=unknown')).status, 400);
  assert.equal((await get('/results?status=eligible&status=pending')).status, 400);
  assert.equal((await get('/results/D07/S1/nav?from=2026-02-30')).status, 400);
  assert.equal((await get('/results/D07/missing')).status, 404);
  assert.equal((await get('/results?run_id=999')).status, 404);
  const result = await (await get('/results?shortlisted=1&term=190&issuer=' + encodeURIComponent('测试理财'))).json();
  assert.equal(result.run_id, run.id);
  assert.equal(result.total, 1);
  const detail = await (await get('/results/D07/S1?run_id=' + run.id)).json();
  assert.equal(detail.result.code, 'S1');
  const points = await (await get('/results/D07/S1/nav?run_id=' + run.id)).json();
  assert.equal(points.items.length, 7);
  assert.equal(store.verify().runs, 1);
  assert.deepEqual(fingerprint(), facts);
  assert.deepEqual(await (await fetch(root + '/api/dashboard/products')).json(), oldProducts);
});

test('main lifecycle remains healthy when screening is pointed at the ledger', async t => {
  const dir = folder(t);
  const ledgerPath = path.join(dir, 'ledger.sqlite');
  const runtime = startServer({
    dbPath: ledgerPath, screeningDbPath: ledgerPath, screeningEnabled: true, port: 0,
    maintenance: false, automation: false, installSignalHandlers: false, logger: { log() {}, warn() {}, error() {} },
  });
  try {
    await runtime.ready;
    const root = 'http://127.0.0.1:' + runtime.server.address().port;
    assert.equal((await fetch(root + '/api/health')).status, 200);
    assert.equal((await (await fetch(root + '/api/r2-screening/status')).json()).availability, 'unavailable');
    assert.equal(runtime.repository.db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name LIKE 'screening_%'").get().count, 0);
  } finally { await runtime.stop(); }
});

test('desktop source recaptures signing headers and returns only the public body', async () => {
  let captures = 0;
  const seen = [];
  const context = { newPage: async () => ({
    waitForRequest: async () => ({ headers: () => ({ appid: 'public', signature: String(++captures), timespan: 'now' }) }),
    goto: async () => {},
  }) };
  const client = await createCfClient(context, AbortSignal.timeout(2000), {
    fetcher: async (_url, { headers }) => {
      seen.push(headers.signature);
      return Response.json(headers.signature === '1' ? { returnCode: 'CFN0511' }
        : { returnCode: 'SUC0000', body: { points: [] } });
    },
  });
  assert.deepEqual(await client('/api/ProductValue/getSAValueByPage', null, {}), { points: [] });
  assert.deepEqual(seen, ['1', '2']);
});

test('source timeout preserves prior publication, with a later refresh able to publish', async t => {
  const store = storeIn(t);
  let mode = 'healthy';
  const service = createScreeningService({
    repository: store, enabled: true, schedule: false, timeoutMs: 80, clock: () => new Date(initial),
    collector: async ({ signal }) => {
      if (mode === 'timeout') await wait(2000, null, { signal });
      return batch();
    },
  });
  cleanup.get(t).push(() => service.stop());
  const first = service.manual('source-first').run.id;
  await until(() => store.current()?.id === first);
  mode = 'timeout';
  const second = service.manual('source-timeout').run.id;
  await until(() => store.get(second).status === 'failed');
  assert.equal(store.get(second).error_code, 'collection_timeout');
  assert.equal(store.current().id, first);
  mode = 'healthy';
  const third = service.manual('source-recovery').run.id;
  await until(() => store.current()?.id === third);
  assert.equal(store.get(third).status, 'succeeded');
});

test('paused screening serves history and permits restore while the ledger HTTP service stays healthy', async t => {
  const dir = folder(t);
  const target = path.join(dir, 'screen.sqlite');
  const store = openScreeningRepository(target, { initialize: true });
  store.close();
  const snapshot = ops.backup(target, path.join(dir, 'backups'), 'paused');
  const writable = openScreeningRepository(target);
  enqueue(writable, 'before-paused-restore');
  writable.close();

  const runtime = startServer({
    dbPath: path.join(dir, 'ledger.sqlite'), screeningDbPath: target, screeningEnabled: false, port: 0,
    maintenance: false, automation: false, installSignalHandlers: false, logger: { log() {}, warn() {}, error() {} },
  });
  try {
    await runtime.ready;
    const root = 'http://127.0.0.1:' + runtime.server.address().port;
    const status = async () => (await fetch(root + '/api/r2-screening/status')).json();
    assert.equal((await status()).last_attempt.id, 1);
    assert.equal((await status()).scheduler.active, null);
    assert.equal(fs.existsSync(target + '-wal'), false);
    ops.restore(target, snapshot.file, dir);
    assert.equal((await status()).last_attempt, null);
    assert.equal((await fetch(root + '/api/health')).status, 200);
  } finally { await runtime.stop(); }
});
