'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');

function openTemp(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'r2-holding-valuation-'),
  );
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: null,
    logger: { warn() {} },
  });
  t.after(() => {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return repository;
}

function createTrade(store, overrides = {}) {
  return store.createTrade({
    trade_date: '2026-10-20',
    confirm_date: '2026-10-20',
    trade_type: 'buy',
    status: 'confirmed',
    product_code: '120026A',
    product_name: '招银理财14天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 15000,
    term_days: 14,
    source: 'manual',
    notes: '',
    ...overrides,
  });
}

test('missing snapshot never falls back to principal or daily record value', (t) => {
  const repository = openTemp(t);
  createTrade(repository.tradeStore, {
    product_code: '120026A',
    amount: 30000,
  });

  const current = repository.holdingValuationStore.getCurrent(
    '2026-10-24',
    repository.tradeStore.getPortfolio(),
  );
  assert.equal(current.available, false);
  assert.equal(current.status, 'missing');
  assert.equal(current.current_value, null);
  assert.equal(current.active_cost, 30000);
  assert.match(current.stale_reasons[0], /尚未录入/);
});

test('confirmed holdings snapshot excludes pending buys and is idempotent', (t) => {
  const repository = openTemp(t);
  createTrade(repository.tradeStore, {
    product_code: '120026A',
    amount: 15000,
  });
  createTrade(repository.tradeStore, {
    product_code: '120056A',
    product_name: '招银理财90天',
    amount: 15000,
    term_days: 90,
  });
  createTrade(repository.tradeStore, {
    trade_date: '2026-10-23',
    confirm_date: null,
    status: 'pending',
    product_code: 'JX040210',
    product_name: '建信理财7天',
    amount: 16000,
    term_days: 7,
  });

  const first = repository.holdingValuationStore.createSnapshot(
    {
      as_of_date: '2026-10-24',
      total_value: 30006.04,
      source: 'user-confirmed',
      notes: '银行当前已确认持仓总市值',
    },
    { today: '2026-10-24', now: '2026-10-24T02:00:00.000Z' },
  );
  assert.equal(first.created, true);

  const duplicate = repository.holdingValuationStore.createSnapshot(
    {
      as_of_date: '2026-10-24',
      total_value: 30006.04,
      source: 'user-confirmed',
      notes: '不同备注不应破坏同一事实的幂等性',
    },
    { today: '2026-10-24', now: '2026-10-24T03:00:00.000Z' },
  );
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.snapshot.id, first.snapshot.id);

  const current = repository.holdingValuationStore.getCurrent(
    '2026-10-24',
    repository.tradeStore.getPortfolio(),
  );
  assert.equal(current.status, 'current');
  assert.equal(current.current_value, 30006.04);
  assert.equal(current.active_cost, 30000);
  assert.equal(current.market_gain, 6.04);
  assert.equal(current.active_holding_count, 2);
  assert.equal(current.pending_buy_count, 1);
  assert.equal(current.pending_buy_amount, 16000);
  assert.equal(current.previous_value, null);
  assert.equal(current.change_since_previous, null);
});

test('a trade confirmed after the snapshot marks it stale', (t) => {
  const repository = openTemp(t);
  const firstBuy = createTrade(repository.tradeStore, {
    product_code: '107320A',
    product_name: '日开1号',
    amount: 30000,
    term_days: 0,
  });
  repository.holdingValuationStore.createSnapshot(
    {
      as_of_date: '2026-10-22',
      total_value: 33006.6,
      source: 'user-confirmed',
    },
    { today: '2026-10-24', now: '2026-10-22T12:00:00.000Z' },
  );
  createTrade(repository.tradeStore, {
    trade_date: '2026-10-21',
    confirm_date: '2026-10-23',
    trade_type: 'redeem',
    product_code: '107320A',
    product_name: '日开1号',
    amount: 3000,
    settlement_amount: 3000.57,
    term_days: null,
  });
  assert.ok(firstBuy.id > 0);

  const stale = repository.holdingValuationStore.getCurrent(
    '2026-10-24',
    repository.tradeStore.getPortfolio(),
  );
  assert.equal(stale.status, 'stale');
  assert.equal(stale.current_value, 33006.6);
  assert.ok(stale.stale_reasons.some((item) => item.includes('2026-10-23')));

  const refreshed = repository.holdingValuationStore.createSnapshot(
    {
      as_of_date: '2026-10-24',
      total_value: 27006.04,
      source: 'user-confirmed',
    },
    { today: '2026-10-24', now: '2026-10-24T04:00:00.000Z' },
  );
  assert.equal(refreshed.created, true);
  const current = repository.holdingValuationStore.getCurrent(
    '2026-10-24',
    repository.tradeStore.getPortfolio(),
  );
  assert.equal(current.status, 'current');
  assert.equal(current.current_value, 27006.04);
  assert.equal(current.active_cost, 27000);
  assert.equal(current.previous_value, 33006.6);
  assert.equal(current.change_since_previous, -6000.56);
});

test('per-product values must cover all active holdings and reconcile to total', (t) => {
  const repository = openTemp(t);
  createTrade(repository.tradeStore, {
    product_code: '120026A',
    amount: 6000,
  });
  createTrade(repository.tradeStore, {
    product_code: '120056A',
    amount: 7500,
    term_days: 90,
  });

  assert.throws(
    () =>
      repository.holdingValuationStore.createSnapshot(
        {
          as_of_date: '2026-10-24',
          total_value: 13506.04,
          items: [
            {
              product_code: '120026A',
              market_value: 6001.17,
            },
          ],
        },
        { today: '2026-10-24' },
      ),
    /必须覆盖全部当前已确认持仓/,
  );

  assert.throws(
    () =>
      repository.holdingValuationStore.createSnapshot(
        {
          as_of_date: '2026-10-24',
          total_value: 13506.04,
          items: [
            {
              product_code: '120026A',
              market_value: 6001.17,
            },
            {
              product_code: '120056A',
              market_value: 7501.44,
            },
          ],
        },
        { today: '2026-10-24' },
      ),
    /合计.*不一致/,
  );

  const saved = repository.holdingValuationStore.createSnapshot(
    {
      as_of_date: '2026-10-24',
      total_value: 13502.61,
      items: [
        {
          product_code: '120026A',
          market_value: 6001.17,
        },
        {
          product_code: '120056A',
          market_value: 7501.44,
        },
      ],
    },
    { today: '2026-10-24' },
  );
  assert.equal(saved.snapshot.items.length, 2);
  assert.equal(
    saved.snapshot.items.reduce((sum, item) => sum + item.market_value, 0),
    13502.61,
  );
});
