'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { createServer } = require('../server');

const { productCsv } = require('./fixtures');

async function startTestServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-review-api-'));
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: productCsv,
    logger: { warn() {} },
  });
  const server = createServer({ repository });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${port}`;
}

function postJson(url, body, method = 'POST') {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('review API stores decisions, holdings, events, notes and exports Markdown', async (t) => {
  const base = await startTestServer(t);

  await postJson(`${base}/api/capital/init`, {
    initial_principal: 500000,
    initial_date: '2026-09-01',
  });
  await postJson(`${base}/api/records`, {
    date: '2026-10-15',
    daily_pnl: 120,
    action: '买入',
    notes: '接口测试',
  });
  await postJson(`${base}/api/records`, {
    date: '2026-10-16',
    daily_pnl: -30,
    action: '无操作',
    notes: '',
  });

  const decisionResponse = await postJson(`${base}/api/review/decisions`, {
    date: '2026-10-15',
    product_name: '招银理财某90天',
    action: '买入',
    reason: '额度命中且期限匹配',
    expectation: '持有到期年化 2.9%',
    actual_result: '',
    rating: '待评估',
  });
  assert.equal(decisionResponse.status, 201);
  const decisionPayload = await decisionResponse.json();
  assert.equal(decisionPayload.decision.product_name, '招银理财某90天');
  assert.equal(decisionPayload.dashboard.workspace.decisions.length, 1);

  const invalidDecision = await postJson(`${base}/api/review/decisions`, {
    date: '2026-10-15',
    product_name: '缺理由',
    action: '买入',
    reason: '',
  });
  assert.equal(invalidDecision.status, 400);

  const holdingResponse = await postJson(`${base}/api/review/holdings`, {
    product_name: '招银理财某90天',
    product_code: 'CMB001',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 100000,
    purchase_date: '2026-10-15',
    term_days: 90,
    maturity_date: null,
    notes: '',
  });
  assert.equal(holdingResponse.status, 201);
  const holdingPayload = await holdingResponse.json();
  assert.equal(holdingPayload.holding.maturity_date, '2027-01-13');
  assert.equal(
    holdingPayload.dashboard.workspace.holdings_summary.total_amount,
    100000,
  );

  const eventResponse = await postJson(`${base}/api/review/events`, {
    date: '2026-10-16',
    product_name: '招银理财某90天',
    event_type: '费率',
    description: '销售费率下调 0.05%',
    impact: '低',
    status: '待复核',
  });
  assert.equal(eventResponse.status, 201);

  const noteResponse = await postJson(
    `${base}/api/review/notes/2026-09`,
    {
      answers: ['按计划执行', '买入 90 天产品', '接近 0', '没有触发', '减少无效切换'],
      conclusion: '9 月执行正常',
    },
    'PUT',
  );
  assert.equal(noteResponse.status, 200);
  const notePayload = await noteResponse.json();
  assert.equal(notePayload.note.answers.length, 5);
  assert.equal(notePayload.dashboard.workspace.notes.length, 1);

  const quarterlyResponse = await postJson(
    `${base}/api/review/quarterly/2026-Q3`,
    {
      answers: ['偏离 3%', '未超限', '覆盖', '可接受', '无', '值得'],
      conclusion: 'Q3 结构稳定',
    },
    'PUT',
  );
  assert.equal(quarterlyResponse.status, 200);

  const dashboard = await fetch(`${base}/api/dashboard`).then((response) =>
    response.json(),
  );
  assert.equal(dashboard.workspace.decisions.length, 1);
  assert.equal(dashboard.workspace.holdings.length, 1);
  assert.equal(dashboard.workspace.events.length, 1);
  assert.equal(dashboard.workspace.notes.length, 1);
  assert.equal(dashboard.workspace.quarterly.length, 1);
  assert.equal(dashboard.workspace.timeline.nodes.length, 4);

  const exportResponse = await fetch(`${base}/api/review/export?month=2026-10`);
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get('content-type'), /text\/markdown/);
  const markdown = await exportResponse.text();
  assert.match(markdown, /# R2 月度复盘 2026-10/);
  assert.match(markdown, /招银理财某90天/);
  assert.match(markdown, /月收益 \| ¥90\.00/);
  assert.match(markdown, /最差单日 \| −¥30\.00/);
  assert.match(markdown, /## 三、环比/);
  assert.match(markdown, /首月记录，暂无环比/);
  assert.match(markdown, /月度五问/);
  assert.match(markdown, /当前持仓快照/);

  const deleteResponse = await fetch(
    `${base}/api/review/decisions/${decisionPayload.decision.id}`,
    { method: 'DELETE' },
  );
  assert.equal(deleteResponse.status, 200);
  const deleted = await deleteResponse.json();
  assert.equal(deleted.dashboard.workspace.decisions.length, 0);
});

test('review API rejects invalid holding and event payloads', async (t) => {
  const base = await startTestServer(t);

  const badHolding = await postJson(`${base}/api/review/holdings`, {
    product_name: '高风险产品',
    risk_level: 'R3',
    amount: 1000,
    purchase_date: '2026-10-15',
  });
  assert.equal(badHolding.status, 400);

  const badEvent = await postJson(`${base}/api/review/events`, {
    date: '2026-10-16',
    product_name: '某产品',
    event_type: '不存在的类型',
    description: '测试',
  });
  assert.equal(badEvent.status, 400);

  const badNote = await postJson(
    `${base}/api/review/notes/2026-09`,
    { answers: ['x'.repeat(2001)] },
    'PUT',
  );
  assert.equal(badNote.status, 400);
});
