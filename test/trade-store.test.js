'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../lib/db');

function openTemp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-trade-store-'));
  const dbPath = path.join(directory, 'test.sqlite');
  const repository = openDatabase({
    dbPath,
    productCsvPath: null,
    logger: { warn() {} },
  });
  t.after(() => {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, dbPath, repository, store: repository.tradeStore };
}

function buy(store, overrides = {}) {
  return store.createTrade({
    trade_date: '2026-10-01',
    confirm_date: '2026-10-01',
    trade_type: 'buy',
    status: 'confirmed',
    product_code: '120056A',
    product_name: '招银理财90天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 10000,
    term_days: 90,
    source: 'manual',
    notes: '',
    ...overrides,
  });
}

test('pending trades stay out of holdings until confirmed', (t) => {
  const { store } = openTemp(t);
  const pending = store.createTrade({
    trade_date: '2026-10-19',
    trade_type: 'buy',
    status: 'pending',
    product_code: '120026A',
    product_name: '14天产品',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 6000,
    term_days: 14,
    source: 'manual',
    notes: '',
  });
  let overview = store.getOverview('2026-10-19');
  assert.equal(overview.summary.pending_count, 1);
  assert.equal(overview.summary.pending_buy_amount, 6000);
  assert.equal(overview.summary.open_principal, 0);
  assert.equal(overview.holdings.length, 0);

  store.confirmTrade(pending.id, '2026-10-19');
  overview = store.getOverview('2026-10-19');
  assert.equal(overview.summary.pending_count, 0);
  assert.equal(overview.summary.open_principal, 6000);
  assert.equal(overview.holdings.length, 1);
  assert.equal(overview.holdings[0].maturity_date, '2026-11-02');
});

test('confirmation recalibrates maturity from the confirmation date', (t) => {
  const { store } = openTemp(t);
  const pending = store.createTrade({
    trade_date: '2026-10-18',
    trade_type: 'buy',
    status: 'pending',
    product_code: '120026A',
    product_name: '14天产品',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 6000,
    term_days: 14,
    source: 'manual',
    notes: '',
  });
  assert.equal(pending.maturity_date, '2026-11-01');
  const confirmed = store.confirmTrade(pending.id, '2026-10-19');
  assert.equal(confirmed.confirm_date, '2026-10-19');
  assert.equal(confirmed.maturity_date, '2026-11-02');
  assert.equal(store.getPortfolio()[0].maturity_date, '2026-11-02');
  assert.equal(store.getPortfolio()[0].purchase_date, '2026-10-19');
});

test('partial redemption matches FIFO lots and computes realized pnl', (t) => {
  const { store } = openTemp(t);
  const first = buy(store, { amount: 4000, trade_date: '2026-10-01', confirm_date: '2026-10-01' });
  const second = buy(store, { amount: 6000, trade_date: '2026-10-02', confirm_date: '2026-10-02' });
  const redemption = store.createTrade({
    trade_date: '2026-10-10',
    confirm_date: '2026-10-10',
    trade_type: 'redeem',
    status: 'confirmed',
    product_code: '120056A',
    product_name: '招银理财90天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 5000,
    settlement_amount: 5050,
    source: 'manual',
    notes: '',
  });

  const overview = store.getOverview('2026-10-19');
  assert.equal(overview.summary.open_principal, 5000);
  assert.equal(overview.summary.realized_pnl, 50);
  assert.equal(overview.allocations.length, 2);
  assert.deepEqual(
    overview.allocations.map((item) => [item.buy_trade_id, item.principal]),
    [
      [first.id, 4000],
      [second.id, 1000],
    ],
  );
  const remaining = overview.holdings.find((item) => item.source_trade_id === second.id);
  assert.equal(remaining.amount, 5000);
  assert.equal(remaining.realized_pnl, 10);

  store.cancelTrade(redemption.id, '测试撤销');
  const restored = store.getOverview('2026-10-19');
  assert.equal(restored.summary.open_principal, 10000);
  assert.equal(restored.summary.realized_pnl, 0);
  assert.equal(restored.allocations.length, 0);
});

test('switch redeems source lot and creates target lot', (t) => {
  const { store } = openTemp(t);
  buy(store, { amount: 10000 });
  store.createTrade({
    trade_date: '2026-10-18',
    confirm_date: '2026-10-18',
    trade_type: 'switch',
    status: 'confirmed',
    product_code: '120056A',
    product_name: '招银理财90天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 10000,
    settlement_amount: 10080,
    target_product_code: '13328D',
    target_product_name: '招银理财180天',
    target_term_days: 180,
    source: 'manual',
    notes: '',
  });
  const overview = store.getOverview('2026-10-19');
  assert.equal(overview.summary.open_principal, 10080);
  assert.equal(overview.summary.realized_pnl, 80);
  assert.equal(overview.holdings[0].product_code, '13328D');
  assert.equal(overview.holdings[0].amount, 10080);
});

test('duplicate business key is rejected', (t) => {
  const { store } = openTemp(t);
  buy(store);
  assert.throws(() => buy(store), /已存在/);
});

test('legacy holdings migrate once as pending buys', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-trade-migrate-'));
  const dbPath = path.join(directory, 'test.sqlite');
  let repository = openDatabase({
    dbPath,
    productCsvPath: null,
    logger: { warn() {} },
  });
  const stamp = new Date().toISOString();
  repository.db
    .prepare(`
      INSERT INTO holdings (
        product_name, product_code, issuer, risk_level, amount, purchase_date,
        term_days, maturity_date, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      '招银理财某14天',
      '120026A',
      '招银理财',
      'R2',
      6000,
      '2026-10-19',
      14,
      '2026-11-02',
      '交易进行中',
      stamp,
      stamp,
    );
  repository.db.exec('DELETE FROM trade_transactions');
  repository.db.exec("DELETE FROM app_meta WHERE key = 'trade_migration_v1'");
  repository.close();

  repository = openDatabase({
    dbPath,
    productCsvPath: null,
    logger: { warn() {} },
  });
  const trades = repository.tradeStore.listTrades();
  assert.equal(trades.length, 1);
  assert.equal(trades[0].status, 'pending');
  assert.equal(trades[0].source, 'migration');
  assert.equal(trades[0].amount, 6000);
  assert.equal(repository.listHoldings().length, 0);
  repository.close();

  repository = openDatabase({
    dbPath,
    productCsvPath: null,
    logger: { warn() {} },
  });
  assert.equal(repository.tradeStore.listTrades().length, 1);
  repository.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('inbox confirmed screenshot confirms an existing pending trade instead of duplicating', (t) => {
  const { repository, store } = openTemp(t);
  const pending = store.createTrade({
    trade_date: '2026-10-19',
    trade_type: 'buy',
    status: 'pending',
    product_code: '120026A',
    product_name: '14天产品',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 6000,
    term_days: 14,
    source: 'migration',
    notes: '',
  });
  const item = store.addInbox({
    original_name: 'trade.png',
    stored_name: 'trade.png',
    mime: 'image/png',
    bytes: 100,
    sha256: 'abc',
    ocr_text: '交易金额 6,000.00',
    parsed: {
      trade_date: '2026-10-19',
      trade_type: 'buy',
      status: 'confirmed',
      confirm_date: '2026-10-19',
      product_code: '120026A',
      product_name: '14天产品',
      amount: 6000,
      term_days: 14,
    },
  });
  const result = store.applyInbox(item.id, {
    amount: 6000,
    status: 'confirmed',
    confirm_date: '2026-10-19',
  });
  assert.equal(result.matched, true);
  assert.equal(result.trade.id, pending.id);
  assert.equal(result.trade.status, 'confirmed');
  assert.equal(result.trade.screenshot_id, item.id);
  assert.equal(store.listTrades().length, 1);
  assert.equal(store.getPortfolio().length, 1);
  assert.equal(repository.tradeStore.listInbox()[0].status, 'applied');
});

test('trade edits keep audit history and old screenshots can be pruned', (t) => {
  const { repository, store } = openTemp(t);
  const trade = buy(store);
  store.updateTrade(trade.id, { ...trade, notes: '补充备注' }, '测试修改');
  const audits = store.getAudits(trade.id);
  assert.equal(audits.length, 2);
  assert.equal(audits[0].action, 'update');
  assert.equal(audits[1].action, 'create');

  const storedName = 'old-trade.png';
  fs.writeFileSync(path.join(store.inboxDir, storedName), Buffer.from('old'));
  const item = store.addInbox({
    original_name: 'old-trade.png',
    stored_name: storedName,
    mime: 'image/png',
    bytes: 3,
    sha256: 'old-hash',
    ocr_text: '',
    parsed: {},
  });
  repository.db
    .prepare(
      "UPDATE trade_inbox SET status = 'applied', received_at = '2026-01-01T00:00:00.000Z', applied_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
    )
    .run(item.id);
  const result = store.pruneScreenshots({ today: '2026-10-19', olderThanDays: 180 });
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(path.join(store.inboxDir, storedName)), false);
  assert.equal(store.getInboxItem(item.id).stored_name, '');
  assert.equal(store.getInboxItem(item.id).status, 'applied');
});
