'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CONTRACT_HASH } = require('../server/modules/r2-strategy/contract');
const { combineHoldingEvidence, monitorContent } = require('../server/modules/r2-strategy/holding-evidence');
const { buildHoldingMonitoring } = require('../server/modules/r2-strategy/holdings');
const { collectHoldingEvidence, sourceError } = require('../server/modules/r2-screening/source');

const DATE = '2026-11-07';
const CLOCK = () => new Date('2026-11-07T09:00:00.000Z');
const calendar = { isOpen: () => true, start: '2026-01-01', end: '2026-12-31' };
const id = (code, channel = 'D07') => ({ source: 'cmb', channel, code });
const hash64 = 'a'.repeat(64);

function poolRow({ channel = 'D07', code = 'A', risk = 'R2', yield1m = '2.50', performanceDate = '2026-11-06',
  minAmount = '100', name = `产品${code}` } = {}) {
  return { statusText: '1', risk, ccynbr: '10', pubPrv: 'A', saacod: channel, code, name, shortName: name,
    orgName: '招银理财', buynfq: minAmount, zrunDat: '2025-01-01', zprfDat: performanceDate,
    pastPerf: { tqilstw4z3: yield1m === null ? [] : [{ zprfTyp: 'A', zripCod: code, zsaaCod: channel, zyeaYld: yield1m }] } };
}

function detailBody({ channel = 'D07', code = 'A', style = '纯固收', termDays = 30, registration = 'Z1234567890' } = {}) {
  return { funCod: code, saaCod: channel, style, regCode: registration,
    prdIntro: `<table><tr><td>最短持有期限：${termDays}天</td></tr><tr><td>赎回安排：每日可赎回</td></tr></table>` };
}

function navBody({ channel = 'D07', code = 'A', points = [['2026-11-05', '1.0100'], ['2026-11-06', '1.0110']] } = {}) {
  return { totalRecord: points.length, totalPage: 1, data: points.map(([date, value]) => ({ zripNbr: code,
    zsaaCod: channel, znavDat: date, znavVal: value })) };
}

function stubSource({ pool = [poolRow()], detail = share => detailBody({ code: share.code, channel: share.channel }),
  nav = (share, body) => navBody({ code: body.funCod, channel: body.saaCod }) } = {}) {
  const calls = [];
  return {
    calls,
    options: {
      maxParallel: 2,
      async openBrowser() { return { context: {}, close: async () => {} }; },
      async listClient() {
        return { async queryPage() { return { list: pool, totalSize: pool.length, totalPage: 1 }; } };
      },
      async cfClient() {
        return async (endpoint, share, body) => {
          calls.push({ endpoint, share: structuredClone(share), body: body ? structuredClone(body) : body });
          if (endpoint.includes('ProductInfo/getSAProductDetailInfo')) return detail(share);
          if (endpoint.includes('ProductValue/getSAValueByPage')) return nav(share, body);
          throw new Error(`未预期接口 ${endpoint}`);
        };
      },
    },
  };
}

function collect(identities, options) {
  return collectHoldingEvidence({ identities, date: DATE, calendar, clock: CLOCK, options });
}

function contextFor(rows = [], overrides = {}) {
  return { date: DATE, contract_hash: CONTRACT_HASH, fingerprint: 'context-2026-11-07', available: true,
    blockers: [], rows, ...overrides };
}

test('监控补采只发公开份额身份，物料中不含账户金额或批次', async () => {
  const stub = stubSource({ pool: [poolRow({ code: 'A' }), poolRow({ code: 'B', yield1m: '3.10' })] });
  const batch = await collect([id('B'), id('A')], stub.options);
  assert.equal(batch.items.length, 2);
  assert.deepEqual(batch.items.map(row => row.identity.code), ['A', 'B']);
  // 每次网络请求只携带 source/channel/code，绝不携带金额、批次或账户字段。
  assert.ok(stub.calls.length >= 4);
  for (const call of stub.calls) {
    if (call.share) {
      assert.deepEqual(Object.keys(call.share).sort(), ['channel', 'code', 'source']);
      assert.ok(!JSON.stringify(call.share).includes('amount'));
    }
    if (call.body) assert.deepEqual(Object.keys(call.body).sort(), ['funCod', 'pageIndex', 'pageSize', 'saaCod']);
  }
  for (const item of batch.items) {
    assert.equal(item.automatic_eligible, false);
    assert.equal(item.data.shortlisted, false);
    assert.equal(item.data.rank, null);
    assert.deepEqual(item.identity, id(item.identity.code));
  }
  assert.equal(batch.items[0].data.min_amount, '100');
  assert.deepEqual(batch.health.pool, { requested: 1, ok: 1, included: 2, total: 2 });
  assert.deepEqual(batch.health.detail, { requested: 2, ok: 2 });
  assert.deepEqual(batch.health.nav, { requested: 2, ok: 2 });
  assert.match(batch.content_hash, /^[a-f0-9]{64}$/);
  assert.equal(batch.captured_at, CLOCK().toISOString());
  assert.equal(batch.items.length, 2);
  assert.deepEqual(Object.keys(batch.items[0]).sort(),
    ['automatic_eligible', 'data', 'evidence', 'identity', 'issues', 'listed', 'nav_hash']);
});

test('同一输入与倒序身份产生相同内容指纹，排序不受区域设置影响', async () => {
  const pool = [poolRow({ code: 'A' }), poolRow({ code: 'B', yield1m: '3.10' })];
  const first = await collect([id('A'), id('B')], stubSource({ pool }).options);
  const second = await collect([id('B'), id('A')], stubSource({ pool }).options);
  assert.equal(first.content_hash, second.content_hash);
  assert.deepEqual(first.items.map(row => row.identity.code), ['A', 'B']);
  assert.deepEqual(second.items.map(row => row.identity.code), ['A', 'B']);
  assert.deepEqual(first.items[0].data, second.items[0].data);
});

test('按销售代码解析实际渠道，重复渠道候选保持待核且不请求详情', async () => {
  const stub = stubSource({ pool: [poolRow({ code: 'A', channel: 'D08' }),
    poolRow({ code: 'B' }), poolRow({ code: 'B', channel: 'D08' })] });
  const batch = await collect([id('A', 'cmb'), id('B', 'cmb'), id('C', 'cmb')], stub.options);
  const byCode = new Map(batch.items.map(row => [row.identity.code, row]));
  assert.deepEqual(byCode.get('A').identity, id('A', 'D08'));
  assert.equal(byCode.get('A').data.performance['1m'], '2.50');
  assert.ok(byCode.get('B').issues.includes('share_identity_conflict'));
  assert.ok(byCode.get('C').issues.includes('share_not_listed'));
  assert.equal(stub.calls.length, 2);
  assert.ok(stub.calls.every(call => (call.share ?? call.body).channel === 'D08' || call.body?.saaCod === 'D08'));

  const legacy = await collect([id('A', 'cmb')], stubSource({ pool: [] }).options);
  const combined = combineHoldingEvidence({ context: contextFor(), date: DATE, supplements: [legacy, batch] });
  assert.deepEqual(combined.rows.map(row => row.identity), [id('A', 'D08')]);
  assert.equal(combined.rows[0].holding_yield_state, 'pass');
  const conflicting = await collect([id('A', 'cmb')], stubSource({ pool: [
    poolRow({ code: 'A' }), poolRow({ code: 'A', channel: 'D08' }),
  ] }).options);
  const updated = combineHoldingEvidence({ context: contextFor(), date: DATE, supplements: [batch, conflicting] });
  assert.equal(updated.rows[0].holding_yield_state, 'pending');
});

test('拒绝携带账户金额、外部来源或重复份额的监控请求', async () => {
  const stub = stubSource();
  await assert.rejects(() => collect([{ ...id('A'), amount: 100000 }], stub.options), { code: 'monitor_identity' });
  await assert.rejects(() => collect([{ ...id('A'), lot_id: 'lot-1' }], stub.options), { code: 'monitor_identity' });
  await assert.rejects(() => collect([{ ...id('A'), source: 'other' }], stub.options), { code: 'monitor_identity' });
  await assert.rejects(() => collect([id('A'), id('A')], stub.options), { code: 'monitor_identity' });
  await assert.rejects(() => collect([id('A')], { ...stub.options, maxParallel: 5 }), { code: 'monitor_input' });
});

test('售罄/下架与低门槛存量仍补采详情和净值，且永不回流新买候选', async () => {
  // A 仍在公开池但收益已不达标且门槛极低；U 已不在公开池（售罄/下架）。
  // 两者都必须继续取证，且监控结果全部 automatic_eligible=false。
  const stub = stubSource({ pool: [poolRow({ code: 'A', yield1m: '1.90', minAmount: '1' })] });
  const batch = await collect([id('A'), id('U')], stub.options);
  const a = batch.items.find(row => row.identity.code === 'A');
  const u = batch.items.find(row => row.identity.code === 'U');
  assert.equal(a.listed, true);
  assert.equal(u.listed, false);
  for (const item of [a, u]) {
    assert.equal(item.automatic_eligible, false);
    assert.equal(item.data.shortlisted, false);
    assert.equal(item.data.rank, null);
    assert.ok(item.evidence.some(proof => proof.kind === 'detail'));
    assert.ok(item.evidence.some(proof => proof.kind === 'nav'));
    assert.equal(item.nav_hash.length, 64);
  }
  assert.deepEqual(a.evidence.map(proof => proof.kind).sort(), ['detail', 'nav', 'performance']);
  assert.equal(a.data.yield_gate, 'reject');
  assert.equal(a.data.min_amount, '1');
  // 售罄/下架本身不是“收益不达标”，缺失的近1月证据只能进入待核。
  assert.equal(u.data.performance_date, null);
  assert.equal(u.data.yield_gate, 'pending');
  assert.ok(u.issues.includes('share_not_listed'));
  // 即使上游上下文把该行标成可自动交易，监控合并后也必须清零。
  const context = contextFor([{ identity: id('A'), mapping: { source: 'cmb', channel: 'D07', sales_code: 'A', product_code: 'A' }, automatic_eligible: true,
    holding_yield_state: 'pass', performance: { '1m': '1.90' }, performance_date: '2026-11-06', run_id: 7 }]);
  const combined = combineHoldingEvidence({ context, date: DATE, supplements: [batch] });
  assert.equal(combined.available, false);
  for (const row of combined.rows) assert.equal(row.automatic_eligible, false);
});

test('缺净值时保留收益证据但标记净值待核，不把其当作收益不达标或已复核', async () => {
  const stub = stubSource({ nav: () => { throw sourceError('nav_unavailable', '净值接口失败'); } });
  const batch = await collect([id('A')], stub.options);
  const item = batch.items[0];
  assert.equal(item.nav_hash, null);
  assert.ok(item.issues.includes('nav_unavailable'));
  assert.equal(item.data.metrics.issue, 'nav_unavailable');
  assert.equal(item.data.yield_gate, 'pass');
  const combined = combineHoldingEvidence({ context: contextFor(), date: DATE, supplements: [batch] });
  const row = combined.rows[0];
  assert.equal(row.holding_yield_state, 'pass');
  assert.equal(row.nav_fresh, false);
  assert.equal(row.monitoring_verified, true); // 收益本身当日已复核
  assert.ok(row.monitoring_issues.includes('nav_stale'));
  assert.ok(row.monitoring_issues.includes('nav_hash_missing'));
  const monitoring = buildHoldingMonitoring({ holdings: [{ lot_id: 'lot-1', product_code: 'A', amount: 1000 }],
    context: combined, date: DATE });
  assert.equal(monitoring.rows[0].state, 'risk_review');
  assert.ok(monitoring.rows[0].risk_reasons.includes('nav_evidence_unverified'));
  assert.notEqual(monitoring.rows[0].action, '赎回');
});

test('缺近1月或数据过期只能待核，不能判成低于2.15%', async () => {
  const no1m = await collect([id('A')], stubSource({ pool: [poolRow({ code: 'A', yield1m: null })] }).options);
  const stale = await collect([id('A')], stubSource({ pool: [poolRow({ code: 'A', performanceDate: '2026-10-20' })] }).options);
  const missing = combineHoldingEvidence({ context: contextFor(), date: DATE, supplements: [no1m] });
  const old = combineHoldingEvidence({ context: contextFor(), date: DATE, supplements: [stale] });
  const missingRow = missing.rows[0], oldRow = old.rows[0];
  assert.equal(missingRow.holding_yield_state, 'pending');
  assert.equal(missingRow.monitoring_verified, false);
  assert.ok(missingRow.monitoring_issues.includes('yield_unverified'));
  assert.ok(missingRow.monitoring_issues.includes('scope_unverified'));
  assert.equal(oldRow.holding_yield_state, 'pending');
  assert.ok(oldRow.monitoring_issues.includes('yield_unverified'));
  for (const row of [missingRow, oldRow]) assert.notEqual(row.holding_yield_state, 'below');
});

test('来源失败保留最近一次公开证据，同时标记复核失败与待核', async () => {
  const good = await collect([id('A')], stubSource().options);
  const base = combineHoldingEvidence({ context: contextFor(), date: DATE, supplements: [good] });
  assert.equal(base.rows[0].holding_yield_state, 'pass');
  assert.equal(base.rows[0].monitoring_verified, true);
  assert.equal(base.rows[0].nav_hash.length, 64);
  const previousHash = base.rows[0].monitor_content_hash;
  assert.equal(previousHash, good.content_hash);
  // 第二次公开池抓取失败（queryProducts 因总数为 0 抛 pool_unavailable），详情/净值仍可取：
  // 不能借失败清空旧证据或改判收益，但必须标成未复核并进入风险复核。
  const failed = await collect([id('A')], stubSource({ pool: [] }).options);
  const next = combineHoldingEvidence({ context: { ...contextFor(), fingerprint: base.fingerprint, rows: base.rows },
    date: DATE, supplements: [failed] });
  const row = next.rows[0];
  assert.equal(row.performance['1m'], '2.50');
  assert.equal(row.nav_hash.length, 64);
  assert.equal(row.holding_yield_state, 'pass');
  assert.equal(row.monitoring_verified, false);
  assert.ok(row.monitoring_issues.includes('pool_unavailable'));
  assert.equal(row.monitor_content_hash, failed.content_hash);
  assert.notEqual(row.monitor_content_hash, previousHash);
  const monitoring = buildHoldingMonitoring({ holdings: [{ lot_id: 'lot-1', product_code: 'A', amount: 1000 }],
    context: next, date: DATE });
  assert.equal(monitoring.rows[0].state, 'risk_review');
  assert.ok(monitoring.rows[0].risk_reasons.includes('monitor_evidence_unverified'));
});

test('多份额逐条归因，不把一只份额的收益写到另一只', async () => {
  const pool = [poolRow({ code: 'A', yield1m: '1.90' }), poolRow({ code: 'B', yield1m: '3.20' })];
  const batch = await collect([id('A'), id('B')], stubSource({ pool }).options);
  const combined = combineHoldingEvidence({ context: contextFor(), date: DATE, supplements: [batch] });
  const a = combined.rows.find(row => row.identity.code === 'A');
  const b = combined.rows.find(row => row.identity.code === 'B');
  assert.equal(a.holding_yield_state, 'below');
  assert.equal(a.performance['1m'], '1.90');
  assert.equal(a.mapping.product_code, 'A');
  assert.equal(b.holding_yield_state, 'pass');
  assert.equal(b.performance['1m'], '3.20');
  assert.equal(b.mapping.product_code, 'B');
  // 重新合并同一批次是幂等的，批量哈希只保留一个。
  const again = combineHoldingEvidence({ context: contextFor(), date: DATE, supplements: [batch] });
  assert.deepEqual(again.rows, combined.rows);
  assert.equal(again.fingerprint, combined.fingerprint);
  assert.deepEqual(again.monitor_content_hashes, [batch.content_hash]);
});

test('被篡改或日期不符的监控批次不产生新证据，只登记未验证', async () => {
  const batch = await collect([id('A'), id('B')], stubSource({ pool: [poolRow({ code: 'A' }), poolRow({ code: 'B' })] }).options);
  const tampered = structuredClone(batch);
  tampered.items[0].data.performance['1m'] = '9.99';
  const combined = combineHoldingEvidence({ context: contextFor(), date: DATE, supplements: [tampered] });
  assert.deepEqual(combined.rows, []);
  assert.deepEqual(combined.monitoring_issues, ['monitor_batch_unverified']);
  const wrongDay = structuredClone(batch);
  wrongDay.business_date = '2026-11-06';
  const combinedWrongDay = combineHoldingEvidence({ context: contextFor(), date: DATE, supplements: [wrongDay] });
  assert.deepEqual(combinedWrongDay.rows, []);
  assert.deepEqual(combinedWrongDay.monitoring_issues, ['monitor_batch_unverified']);
  // 正确批次的内容摘要与合并端重新计算的一致。
  const content = monitorContent(batch);
  assert.equal(require('../server/modules/r2-strategy/contract').fingerprint(content), batch.content_hash);
});
