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

function addIncome(repository, productCode, dailyPnl, productName = '') {
  return repository.productValuationStore.upsertValuation({
    valuation_date: '2026-10-22',
    yield_date: '2026-10-22',
    product_code: productCode,
    product_name: productName,
    daily_pnl: dailyPnl,
  });
}

test('current value derives from confirmed principal and product income without a snapshot', (t) => {
  const repository = openTemp(t);
  createTrade(repository.tradeStore, {
    product_code: '120026A',
    amount: 30000,
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
  addIncome(repository, '120026A', 0.6, '招银理财14天');

  const current = repository.holdingValuationStore.getCurrent(
    '2026-10-24',
    repository.tradeStore.getPortfolio(),
  );
  assert.equal(current.available, true);
  assert.equal(current.status, 'current');
  assert.equal(current.value_source, 'confirmed_holdings_plus_product_income');
  assert.equal(current.current_value, 30000.6);
  assert.equal(current.active_cost, 30000);
  assert.equal(current.product_income, 0.6);
  assert.equal(current.market_gain, 0.6);
  assert.equal(current.income_as_of_date, '2026-10-22');
  assert.equal(current.active_holding_count, 1);
  assert.equal(current.pending_buy_count, 1);
  assert.equal(current.pending_buy_amount, 16000);
  assert.equal(current.bank_reconciliation.status, 'missing');
  assert.equal(current.bank_reconciliation.available, false);
  assert.deepEqual(current.stale_reasons, []);
});

test('bank snapshot is reconciliation only and a one-cent difference is accepted', (t) => {
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
  addIncome(repository, '120026A', 2.5, '招银理财14天');
  addIncome(repository, '120056A', 3.53, '招银理财90天');

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

  const current = repository.holdingValuationStore.getCurrent(
    '2026-10-24',
    repository.tradeStore.getPortfolio(),
  );
  assert.equal(current.current_value, 30006.03);
  assert.equal(current.product_income, 6.03);
  assert.equal(current.bank_reconciliation.status, 'rounding');
  assert.equal(current.bank_reconciliation.bank_value, 30006.04);
  assert.equal(current.bank_reconciliation.difference, -0.01);
  assert.equal(current.bank_reconciliation.matched, true);
  assert.equal(current.bank_reconciliation.tolerance, 0.01);
  assert.deepEqual(current.stale_reasons, []);
});

test('a larger bank difference is surfaced while the derived value stays authoritative', (t) => {
  const repository = openTemp(t);
  createTrade(repository.tradeStore, { amount: 30000 });
  addIncome(repository, '120026A', 6.03, '招银理财14天');
  repository.holdingValuationStore.createSnapshot(
    {
      as_of_date: '2026-10-24',
      total_value: 30100,
      source: 'user-confirmed',
    },
    { today: '2026-10-24' },
  );

  const current = repository.holdingValuationStore.getCurrent(
    '2026-10-24',
    repository.tradeStore.getPortfolio(),
  );
  assert.equal(current.current_value, 30006.03);
  assert.equal(current.bank_reconciliation.status, 'mismatch');
  assert.equal(current.bank_reconciliation.matched, false);
  assert.equal(current.bank_reconciliation.difference, -93.97);
  assert.ok(current.stale_reasons.some((item) => /超过 ¥0.01 容差/.test(item)));
});

test('confirmed trades update the derived value even when the bank snapshot is old', (t) => {
  const repository = openTemp(t);
  createTrade(repository.tradeStore, {
    product_code: '107320A',
    product_name: '日开1号',
    amount: 30000,
    term_days: 0,
  });
  addIncome(repository, '107320A', 1, '日开1号');
  repository.holdingValuationStore.createSnapshot(
    {
      as_of_date: '2026-10-22',
      total_value: 30001,
      source: 'user-confirmed',
    },
    { today: '2026-10-24', now: '2026-10-22T12:00:00.000Z' },
  );
  createTrade(repository.tradeStore, {
    trade_date: '2026-10-23',
    confirm_date: '2026-10-23',
    product_code: '120056A',
    product_name: '招银理财90天',
    amount: 5000,
    term_days: 90,
  });
  addIncome(repository, '120056A', 0.5, '招银理财90天');

  const current = repository.holdingValuationStore.getCurrent(
    '2026-10-24',
    repository.tradeStore.getPortfolio(),
  );
  assert.equal(current.current_value, 35001.5);
  assert.equal(current.active_cost, 35000);
  assert.equal(current.bank_reconciliation.status, 'outdated');
  assert.equal(current.bank_reconciliation.comparison_valid, false);
  assert.ok(
    current.bank_reconciliation.stale_reasons.some((item) =>
      item.includes('2026-10-23'),
    ),
  );
});

test('per-product bank values must cover all active holdings and reconcile to total', (t) => {
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
