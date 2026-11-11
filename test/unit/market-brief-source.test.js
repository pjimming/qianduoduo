'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createMarketBriefSource } = require('../../server/modules/market-briefs/source');
const { createMarketBriefService } = require('../../server/modules/market-briefs/service');
const { createMarketBriefRoutes } = require('../../server/modules/market-briefs/routes');
const { createRouter } = require('../../server/http/router');
const { handleCaughtError } = require('../../server/http/errors');

const analysis = (type = 'market_overview', extra = {}) => ({
  analysis_type: type, title: '分析', content_markdown: '# 标题\n\n接口原文',
  published_at: '2026-11-11T17:26:06+08:00', ...extra,
});
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

test('market source reads public dates and published three-period originals without credentials', async () => {
  const calls = [];
  const source = createMarketBriefSource({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/dates') ? json({ dates: ['2026-11-10', '2026-11-11', '2026-11-11'] })
      : json({ trade_date: '2026-11-11', analyses: [
        analysis('morning_brief'), analysis('midday_brief'), analysis(),
        analysis('private_draft'), analysis('morning_brief', { published_at: null }),
      ] });
  } });
  assert.deepEqual(await source.dates(), ['2026-11-11', '2026-11-10']);
  const result = await source.daily('2026-11-11');
  assert.deepEqual(result.analyses.map(x => x.analysis_type), ['morning_brief', 'midday_brief', 'market_overview']);
  assert.equal(result.analyses[0].content_markdown, '# 标题\n\n接口原文');
  for (const { url, options } of calls) {
    assert.ok(url.startsWith('https://touzikexue.com/api/daily-market-analyses/'));
    assert.deepEqual(options.headers, { Accept: 'application/json' });
    assert.equal(options.redirect, 'error');
  }
});

test('market source rejects invalid dates, wrong-date content and malformed responses', async () => {
  let calls = 0;
  const source = createMarketBriefSource({ fetchImpl: async () => {
    calls++;
    return json({ trade_date: '2026-11-10', analyses: [] });
  } });
  await assert.rejects(source.daily('2026-02-30'), { statusCode: 400 });
  assert.equal(calls, 0);
  await assert.rejects(source.daily('2026-11-11'), { statusCode: 502 });
  await assert.rejects(createMarketBriefSource({ fetchImpl: async () => json({ dates: ['bad-date'] }) }).dates(), { statusCode: 502 });
  await assert.rejects(createMarketBriefSource({ fetchImpl: async () => json({
    trade_date: '2026-11-11', analyses: [analysis('market_overview', { content_markdown: null })],
  }) }).daily('2026-11-11'), { statusCode: 502 });
});

test('market source handles absence, source errors, timeout and response size bounds', async () => {
  const absent = createMarketBriefSource({ fetchImpl: async () => json({}, 404) });
  assert.deepEqual(await absent.daily('2026-11-11'), { trade_date: '2026-11-11', analyses: [] });
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(createMarketBriefSource({ fetchImpl: async () => json({}, status) }).dates(), { statusCode: 502 });
  }
  const slow = createMarketBriefSource({ timeoutMs: 5, fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  await assert.rejects(slow.dates(), { statusCode: 504 });
  const large = createMarketBriefSource({ fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) });
  await assert.rejects(large.dates(), { statusCode: 502 });
});

test('market source chooses the most recently published version for each period', async () => {
  const source = createMarketBriefSource({ fetchImpl: async () => json({ trade_date: '2026-11-11', analyses: [
    analysis('market_overview', { title: '旧', published_at: '2026-11-11T15:01:00+08:00' }),
    analysis('market_overview', { title: '新' }),
  ] }) });
  assert.equal((await source.daily('2026-11-11')).analyses[0].title, '新');
});

test('market brief cache coalesces requests, expires and does not cache failures', async () => {
  let clock = 0, calls = 0, failing = true;
  const service = createMarketBriefService({ now: () => clock, source: {
    dates: async () => { calls++; if (failing) throw new Error('offline'); return ['2026-11-11']; },
    daily: async date => { calls++; return { trade_date: date, analyses: [] }; },
  } });
  await assert.rejects(service.dates(), /offline/);
  failing = false;
  const [first, second] = await Promise.all([service.dates(), service.dates()]);
  assert.deepEqual(first, second);
  assert.equal(calls, 2);
  await service.dates();
  assert.equal(calls, 2);
  clock = 60001;
  await service.dates();
  assert.equal(calls, 3);
  await service.daily('2026-11-11');
  clock += 30001;
  await service.daily('2026-11-11');
  assert.equal(calls, 5);
});

test('market brief HTTP routes expose dates, original content and mapped validation errors', async t => {
  const source = createMarketBriefSource({ fetchImpl: async url => url.endsWith('/dates')
    ? json({ dates: ['2026-11-11'] }) : json({ trade_date: '2026-11-11', analyses: [analysis()] }) });
  const router = createRouter();
  for (const route of createMarketBriefRoutes(createMarketBriefService({ source }))) {
    router.add(route.method, route.path, route.handler);
  }
  const server = http.createServer((req, res) => router.handle(req, res).catch(error => handleCaughtError(res, error)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/market-briefs/`;
  assert.deepEqual((await fetch(`${base}dates`).then(r => r.json())).dates, ['2026-11-11']);
  assert.equal((await fetch(`${base}2026-11-11`).then(r => r.json())).analyses[0].content_markdown, analysis().content_markdown);
  const invalid = await fetch(`${base}2026-02-30`);
  assert.equal(invalid.status, 400);
});
