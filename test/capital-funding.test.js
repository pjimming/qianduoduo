'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCapitalFunding } = require('../lib/capital-funding');
const { buildAccountContext } = require('../server/modules/r2-strategy/account');
const { tradeSettlementChecks } = require('../lib/capital-funding');

const date = '2026-11-11';
const redeem = (patch = {}) => ({ id: 17, status: 'confirmed', trade_type: 'redeem',
  product_code: 'A', confirm_date: date, amount: 4996.07, settlement_amount: 5000.45,
  arrival_date: date, arrival_verified_at: '2026-11-11T04:52:16Z', ...patch });
const funding = patch => buildCapitalFunding({ principal: 70000, date,
  initialDate: '2026-10-20', holdings: [{ amount: 70003.93 }], trades: [redeem()], ...patch });

test('settled gain funds reinvestment without inventing a capital deposit or counting daily income', () => {
  const input = { principal: 70000, date, holdings: [{ amount: 70003.93 }], trades: [redeem()] };
  const before = JSON.stringify(input);
  const value = buildCapitalFunding(input);
  assert.equal(value.net_contributions_cents, 7000000);
  assert.equal(value.settled_realized_pnl_cents, 438);
  assert.equal(value.funding_capacity_cents, 7000438);
  assert.equal(value.holding_cost_cents, 7000393);
  assert.equal(value.reinvested_pnl_cents, 393);
  assert.equal(value.outside_holdings_cents, 45);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(buildCapitalFunding(input), value);
});

test('unconfirmed, cancelled, unverified, future and missing-amount proceeds provide no extra funds', () => {
  for (const patch of [{ status: 'pending' }, { status: 'cancelled' }, { arrival_date: null },
    { arrival_verified_at: null }, { arrival_verified_at: 'invalid' }, { arrival_date: '2026-11-12' },
    { confirm_date: '2026-11-12' }, { settlement_amount: null }, { settlement_amount: undefined }]) {
    const value = funding({ trades: [redeem(patch)] });
    assert.equal(value.settled_realized_pnl_cents, 0, JSON.stringify(patch));
    assert.equal(value.reinvested_pnl_cents, 0);
  }
});

test('settled losses reduce funding capacity; confirmed zero settlement is a real loss', () => {
  assert.equal(funding({ trades: [redeem({ settlement_amount: 4990 })] }).settled_realized_pnl_cents, -607);
  const value = funding({ trades: [redeem({ settlement_amount: 0 })] });
  assert.equal(value.settled_realized_pnl_cents, -499607);
  assert.equal(value.funding_capacity_cents, 6500393);
  assert.equal(value.reinvested_pnl_cents, 0);
});

test('capital baseline excludes earlier settlements and correction recomputes instead of accumulating', () => {
  assert.equal(funding({ initialDate: '2026-11-12' }).settled_realized_pnl_cents, 0);
  assert.equal(funding({ trades: [redeem({ amount: 4996.06 })] }).settled_realized_pnl_cents, 439);
  assert.equal(funding().settled_realized_pnl_cents, 438);
  assert.throws(() => funding({ trades: [redeem(), redeem()] }), /重复/);
  assert.throws(() => funding({ trades: [redeem({ settlement_amount: 5000.451 })] }), /整分/);
});

test('strategy and capital bridge agree on arrived profit while real overspending still blocks', () => {
  const model = { principal: 70000, date, holdings: [{ lot_id: '1:A', product_code: 'A', amount: 70003.93, term_days: 30 }],
    trades: [redeem()], assetsByCode: { A: { product_key: 'A', family_key: 'A', evidence_tier: 'full_1y', bucket: 'short' } },
    settlementChecks: tradeSettlementChecks([redeem()]) };
  const value = buildAccountContext(model);
  assert.equal(value.verified, true);
  assert.equal(value.principal_cents, funding().funding_capacity_cents);
  assert.equal(value.available_cents, 45);
  const overspent = buildAccountContext({ ...model, holdings: [{ ...model.holdings[0], amount: 70005 }] });
  assert.ok(overspent.blockers.includes('account_overcommitted'));
  const unarrived = buildAccountContext({ ...model, settlementChecks: {} });
  assert.equal(unarrived.settled_realized_pnl_cents, 0);
  assert.ok(unarrived.blockers.includes('account_overcommitted'));
});

test('a split switch can reinvest arrived gain from its own decision without counting it twice', () => {
  const trade = redeem({ amount: 100, settlement_amount: 105, decision_id: 1 });
  const buy = { id: 18, status: 'pending', trade_type: 'buy', product_code: 'B', amount: 105, decision_id: 1 };
  const model = { principal: 100, date, trades: [trade, buy], holdings: [], settlementChecks: tradeSettlementChecks([trade]),
    decisions: [{ id: 1, action: '切换', review_meta: { expected_legs: [
      { side: 'redeem', product_code: 'A' }, { side: 'buy', product_code: 'B' }] } }],
    assetsByCode: { B: { product_key: 'B', family_key: 'B', evidence_tier: 'full_1y', bucket: 'short' } } };
  const result = buildAccountContext(model);
  assert.equal(result.verified, true);
  assert.equal(result.committed_cents, 10500);
  assert.equal(result.available_cents, 0);
  // Same arrived money cannot be used again after the first leg is confirmed.
  const secondBuy = { ...buy, id: 19, amount: 1 };
  const consumed = buildAccountContext({ ...model, trades: [trade, { ...buy, status: 'confirmed' }, secondBuy] });
  assert.ok(consumed.blockers.includes('switch_funding_unavailable'));
});
