'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, requestJson, initializeCapital } = require('./helpers/test-context');

test('capital page funding refreshes with settlement and cost corrections without modifying capital or income facts', async t => {
  const { baseUrl, repository } = await startTestServer(t);
  initializeCapital(repository, { principal: 100, date: '2026-09-01' });
  const post = async body => {
    const response = await requestJson(baseUrl + '/api/trades', { method: 'POST', body: JSON.stringify({
      trade_date: '2026-10-19', confirm_date: '2026-10-19', trade_type: 'buy', status: 'confirmed',
      product_code: '120056A', product_name: '合成测试产品', issuer: '合成机构', risk_level: 'R2',
      amount: 100, term_days: 90, ...body }) });
    assert.equal(response.response.status, 201);
    return response.body.trade;
  };
  await post({});
  const trade = await post({ trade_type: 'redeem', amount: 50, settlement_amount: 55, term_days: null });
  await post({ amount: 55 });
  const ledger = async () => (await requestJson(baseUrl + '/api/dashboard/ledger')).body;
  assert.equal((await ledger()).capital.funding.settled_realized_pnl_cents, 0);
  let result = await requestJson(baseUrl + '/api/trades/' + trade.id, { method: 'PUT',
    body: JSON.stringify({ arrival_date: '2026-10-20' }) });
  assert.equal(result.response.status, 200);
  const before = await ledger();
  assert.equal(before.capital.current_principal, 100);
  assert.equal(before.capital.events.length, 0);
  assert.equal(before.capital.funding.settled_realized_pnl_cents, 500);
  assert.equal(before.capital.funding.holding_cost_cents, 10500);
  assert.equal(before.capital.funding.reinvested_pnl_cents, 500);
  const changes = repository.db.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual((await ledger()).capital.funding, before.capital.funding);
  assert.equal(repository.db.prepare('SELECT total_changes() n').get().n, changes);
  result = await requestJson(baseUrl + '/api/trades/' + trade.id, { method: 'PUT',
    body: JSON.stringify({ amount: 50.01, note: '合成证据校正成本' }) });
  assert.equal(result.response.status, 200);
  const after = await ledger();
  assert.equal(after.capital.funding.settled_realized_pnl_cents, 499);
  assert.equal(after.capital.funding.holding_cost_cents, 10499);
  assert.equal(after.capital.funding.funding_capacity_cents, 10499);
  assert.equal(after.capital.current_principal, 100);
  assert.deepEqual(after.capital.events, before.capital.events);
  assert.deepEqual(after.records, before.records);
});
