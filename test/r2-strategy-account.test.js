'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAccountContext, moneyCents } = require('../server/modules/r2-strategy/account');
const assetsByCode = Object.fromEntries(['A', 'B'].map(code => [code, { product_key: code, family_key: code,
  evidence_tier: 'full_1y', bucket: 'short', liquidity_eligible: true, available_on: '2026-11-10' }]));
const decision = (action = '买入') => ({ id: 1, action, review_meta: { holding_lot_id: 'old:A', expected_legs:
  action === '切换' ? [{ side: 'redeem', product_code: 'A' }, { side: 'buy', product_code: 'B' }] : [{ side: 'buy', product_code: 'B' }] } });
const reserve = (patch = {}) => ({ id: 1, decision_id: 1, leg_key: 'buy:B', state: 'active', amount_cents: 3000, executed_cents: 0, released_cents: 0, ...patch });
const holding = (amount = 50, code = 'A', lot = 'old:A') => ({ lot_id: lot, product_code: code, amount, term_days: 30 });
const pending = (patch = {}) => ({ id: 1, decision_id: 1, status: 'pending', trade_type: 'buy', product_code: 'B', amount: 30, term_days: 30, ...patch });
const input = patch => ({ principal: 100, date: '2026-11-07', assetsByCode, holdings: [holding()], trades: [], reservations: [], decisions: [decision()], ...patch });
const settlement = id => ({ trade_id: id, product_code: 'A', status: 'verified', verified: true,
  arrival_date: '2026-11-07', arrival_verified_at: '2026-11-07T00:00:00.000Z', evidence_hash: 'a'.repeat(64) });

test('confirmed holdings, pending screenshot and accepted reservation occupy the same principal once', () => {
  const value = buildAccountContext(input({ trades: [pending()], reservations: [reserve()] }));
  assert.equal(value.verified, true);
  assert.equal(value.principal_cents, 10000);
  assert.equal(value.committed_cents, 8000);
  assert.equal(value.available_cents, 2000);
  assert.equal(value.commitments[0].amount_cents, 3000);
});
test('independent pending trade and accepted proposal are different commitments', () => {
  const value = buildAccountContext(input({ trades: [pending({ decision_id: 2 })],
    decisions: [decision(), { ...decision(), id: 2 }], reservations: [reserve()] }));
  assert.equal(value.committed_cents, 11000);
  assert.ok(value.blockers.includes('account_overcommitted'));
});
test('a pending switch transfers projected exposure and does not count its source twice', () => {
  const value = buildAccountContext(input({ holdings: [holding(100)], decisions: [decision('切换')],
    trades: [pending({ trade_type: 'switch', product_code: 'A', target_product_code: 'B', target_term_days: 30 })],
    reservations: [reserve()] }));
  assert.equal(value.verified, true);
  assert.equal(value.committed_cents, 10000);
  assert.equal(value.actual_holdings[0].amount_cents, 10000);
  assert.equal(value.exposures.find(row => row.product_code === 'A').amount_cents, 7000);
  assert.equal(value.exposures.find(row => row.product_code === 'B').amount_cents, 3000);
});
test('partially confirmed switch uses actual holdings and only reserves its unexecuted balance', () => {
  const value = buildAccountContext(input({ holdings: [holding(60), holding(40, 'B', 'confirmed:B')], decisions: [decision('切换')],
    trades: [pending({ id: 1, status: 'confirmed', trade_type: 'switch', product_code: 'A', target_product_code: 'B', amount: 40 }),
      pending({ id: 2, trade_type: 'switch', product_code: 'A', target_product_code: 'B', amount: 60 })],
    reservations: [reserve({ amount_cents: 10000, executed_cents: 4000 })] }));
  assert.equal(value.verified, true);
  assert.equal(value.committed_cents, 10000);
  assert.equal(value.commitments[0].amount_cents, 6000);
});

test('persisted v9 holding snapshots pin the source batch instead of consuming another batch of the same product', () => {
  const oldDecision = decision('切换');
  delete oldDecision.review_meta.holding_lot_id;
  oldDecision.review_meta.execution_snapshot = { lot_id: 'old:A' };
  const value = buildAccountContext(input({ holdings: [holding(50, 'A', 'unrelated:A'), holding(50)],
    decisions: [oldDecision], reservations: [reserve()] }));
  assert.equal(value.exposures.find(row => row.lot_id === 'unrelated:A').amount_cents, 5000);
  assert.equal(value.exposures.find(row => row.lot_id === 'old:A').amount_cents, 2000);
});
test('pending redemption keeps source capital occupied; confirmation alone does not prove arrival', () => {
  const redeem = pending({ trade_type: 'redeem', product_code: 'A', amount: 50 });
  assert.equal(buildAccountContext(input({ trades: [redeem] })).committed_cents, 5000);
  const inTransit = buildAccountContext(input({ holdings: [], trades: [{ ...redeem, status: 'confirmed' }] }));
  assert.equal(inTransit.blocked_cash_cents, 5000);
  assert.ok(inTransit.blockers.includes('settlement_unverified:1'));
  const arrived = buildAccountContext(input({ holdings: [], trades: [{ ...redeem, status: 'confirmed',
    arrival_date: '2026-11-07', arrival_verified_at: '2026-11-07T00:00:00.000Z' }], settlementChecks: { 1: settlement(1) } }));
  assert.equal(arrived.blocked_cash_cents, 0);
  assert.equal(arrived.verified, true);
});
test('a split switch after verified redemption uses the same decision proceeds rather than borrowing unrelated holdings', () => {
  const trades = [pending({ id: 1, trade_type: 'redeem', product_code: 'A', status: 'confirmed', amount: 50,
    arrival_date: '2026-11-07', arrival_verified_at: '2026-11-07T00:00:00.000Z' }),
    pending({ id: 2, trade_type: 'buy', product_code: 'B', amount: 50 })];
  const value = buildAccountContext(input({ holdings: [], trades, decisions: [decision('切换')],
    reservations: [reserve({ amount_cents: 5000 })], settlementChecks: { 1: settlement(1) } }));
  assert.equal(value.verified, true);
  assert.equal(value.committed_cents, 5000);
  assert.equal(value.available_cents, 5000);
  const unarrived = buildAccountContext(input({ holdings: [],
    trades: trades.map(trade => trade.id === 1 ? { ...trade, arrival_date: null, arrival_verified_at: null } : trade),
    decisions: [decision('切换')], reservations: [reserve({ amount_cents: 5000 })] }));
  assert.equal(unarrived.verified, false);
  assert.ok(unarrived.blockers.includes('switch_funding_unavailable'));
});
test('confirmed execution without reservation reconciliation blocks fresh recommendations rather than double counting silently', () => {
  const value = buildAccountContext(input({ holdings: [holding(50), holding(10, 'B', 'new:B')],
    trades: [pending({ status: 'confirmed', amount: 10 })], reservations: [reserve()] }));
  assert.ok(value.blockers.includes('reservation_reconciliation_needed'));
  assert.equal(value.verified, false);
});
test('cancelled facts and released reservations free only their own intent', () => {
  const value = buildAccountContext(input({ trades: [pending({ status: 'cancelled' })],
    reservations: [reserve({ state: 'released', released_cents: 3000 })] }));
  assert.equal(value.committed_cents, 5000);
  assert.equal(value.available_cents, 5000);
});
test('input remains unchanged and duplicate factual identities or sub-cent money are rejected', () => {
  const model = input({ reservations: [reserve()] }), before = JSON.stringify(model);
  const value = buildAccountContext(model);
  assert.equal(JSON.stringify(model), before);
  assert.equal(buildAccountContext(model).fingerprint, value.fingerprint);
  assert.throws(() => buildAccountContext(input({ holdings: [holding(), holding()] })), /批次重复/);
  for (const amount of [-1, NaN, 0.001, Infinity]) assert.throws(() => moneyCents(amount));
  assert.equal(moneyCents(0.29), 29);
});
