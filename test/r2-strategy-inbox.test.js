'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStrategyInboxItems } = require('../server/modules/r2-strategy/inbox');

function row(overrides = {}) {
  return {
    lot_id: 'lot:120056A:2026-10-01',
    product_code: '120056A',
    state: 'exit_required',
    action: '赎回',
    planned_action: 'redeem',
    yield_1m: 1.82,
    performance_date: '2026-10-31',
    next_verify_date: '2026-11-07',
    requires_user_action: true,
    message_key: 'message-exit-1',
    fingerprint: 'f'.repeat(64),
    ...overrides,
  };
}

function result(rows, activationSeq = 3) {
  return {
    input: { activation_seq: activationSeq },
    monitoring: { counts: {}, rows },
  };
}

test('v9 actionable holding becomes one strategy inbox item', () => {
  const items = buildStrategyInboxItems({
    result: result([row()]),
    mode: 'v9',
    today: '2026-11-08',
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].dedupe_key, 'r2-strategy:message-exit-1');
  assert.equal(items[0].source_type, 'r2_strategy_holding');
  assert.equal(items[0].source_id, 'lot:120056A:2026-10-01');
  assert.equal(items[0].severity, 'urgent');
  assert.equal(items[0].due_at, null);
  assert.match(items[0].title, /续持不达标/);
  assert.match(items[0].summary, /1\.82%/);
  assert.equal(
    items[0].action_url,
    '/ledger/products?section=holdings&lot=lot%3A120056A%3A2026-10-01',
  );
  assert.equal(items[0].metadata.strategy_activation_seq, 3);
});

test('locked exit carries its next verification date', () => {
  const items = buildStrategyInboxItems({
    result: result([
      row({
        state: 'exit_at_open',
        planned_action: 'exit_at_maturity',
        next_verify_date: '2026-12-01',
      }),
    ]),
    mode: 'v9',
    today: '2026-11-08',
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, 'warn');
  assert.equal(items[0].due_at, '2026-12-01');
});

test('hold rows and rows without user action do not create todos', () => {
  const items = buildStrategyInboxItems({
    result: result([
      row({ state: 'hold', requires_user_action: false, message_key: 'hold' }),
      row({ state: 'risk_review', requires_user_action: false, message_key: 'risk' }),
    ]),
    mode: 'v9',
    today: '2026-11-08',
  });
  assert.deepEqual(items, []);
});

test('shadow and legacy results never create user todos', () => {
  const value = result([row()]);
  assert.deepEqual(
    buildStrategyInboxItems({ result: value, mode: 'shadow', today: '2026-11-08' }),
    [],
  );
  assert.deepEqual(
    buildStrategyInboxItems({ result: value, mode: 'legacy', today: '2026-11-08' }),
    [],
  );
});

test('duplicate message keys are projected once', () => {
  const items = buildStrategyInboxItems({
    result: result([row(), row({ lot_id: 'lot:other' })]),
    mode: 'v9',
    today: '2026-11-08',
  });
  assert.equal(items.length, 1);
});
