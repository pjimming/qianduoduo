'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createProductHoldingIncomeStore, migrateProductHoldingIncome } = require('../lib/product-holding-income-store');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-holding-income-'));
  const file = path.join(dir, 'evidence.jpg'); fs.writeFileSync(file, 'test-evidence');
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  db.exec('CREATE TABLE product_daily_valuations(id INTEGER PRIMARY KEY,product_code TEXT,yield_date TEXT,daily_pnl REAL,daily_pnl_1e4 INTEGER)');
  db.prepare('INSERT INTO product_daily_valuations VALUES(1,?,?,?,?)').run('AB1234', '2026-11-19', .59, 5944);
  let trades = [{ id: 1, product_code: 'AB1234', confirm_date: '2026-11-13', status: 'confirmed', trade_type: 'buy', amount: 6000, updated_at: 'a' }];
  const store = createProductHoldingIncomeStore(db, { getEvidenceFile: id => id === 4 ? { path: file } : null,
    tradeStore: { getOverview: () => ({ trades }) } });
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const input = { product_code: 'AB1234', as_of_date: '2026-11-19', holding_income: .60, holding_amount: 6000.60, evidence_id: 4, scope_trade_ids: [1] };
  return { db, store, input, changeTrades: v => { trades = v; } };
}

test('bank cumulative snapshots are explicit, versioned and do not alter daily income', t => {
  const { db, store, input } = fixture(t);
  assert.deepEqual(store.list('AB1234'), []);
  assert.throws(() => store.save(input), /迁移/);
  migrateProductHoldingIncome(db); migrateProductHoldingIncome(db);
  const original = store.save(input);
  assert.equal(original.snapshot.version, 1);
  assert.equal(store.save(input).duplicate, true);
  assert.throws(() => store.save({ ...input, holding_income: .61 }), /版本/);
  assert.throws(() => store.save({ ...input, holding_income: .61, expected_version: 1 }), /原因/);
  const updated = store.save({ ...input, holding_income: .61, expected_version: 1, correction_note: '银行更正' });
  assert.equal(updated.snapshot.version, 2);
  assert.equal(store.save(input).snapshot.holding_income, .61, 'old replay never restores an old fact');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM product_holding_income_snapshot_revisions').get().n, 2);
  assert.equal(db.prepare('SELECT daily_pnl_1e4 FROM product_daily_valuations').get().daily_pnl_1e4, 5944);
});

test('bank snapshots separate bank/ledger difference and invalidate changed holding scope', t => {
  const { db, store, input, changeTrades } = fixture(t); migrateProductHoldingIncome(db); store.save(input);
  const summary = { status: 'active', active_amount: 6000, last_yield_date: '2026-11-19' };
  const current = store.latest('AB1234', summary, '2026-11-20');
  assert.equal(current.scope_status, 'current'); assert.equal(current.ledger_income, .59); assert.equal(current.difference, .01);
  assert.equal(store.latest('AB1234', { ...summary, last_yield_date: '2026-11-20' }, '2026-11-20').scope_status, 'history');
  assert.equal(store.latest('AB1234', { ...summary, active_amount: 7000 }, '2026-11-20').scope_status, 'needs_review');
  changeTrades([{ id: 1, product_code: 'AB1234', confirm_date: '2026-11-13', status: 'confirmed', trade_type: 'buy', amount: 6000, updated_at: 'changed' }]);
  assert.equal(store.latest('AB1234', summary, '2026-11-20').scope_status, 'needs_review');
});

test('bank snapshot writes reject missing evidence, invalid dates, amount precision and incomplete multiple lots', t => {
  const { db, store, input, changeTrades } = fixture(t); migrateProductHoldingIncome(db);
  assert.throws(() => store.save({ ...input, evidence_id: 99 }), /截图/);
  assert.throws(() => store.save({ ...input, as_of_date: '2026-02-30' }), /日期/);
  assert.throws(() => store.save({ ...input, as_of_date: '2026-11-21' }, { today: '2026-11-20' }), /日期/);
  assert.throws(() => store.save({ ...input, holding_income: .5944 }), /两位/);
  changeTrades([1, 2].map(id => ({ id, product_code: 'AB1234', confirm_date: '2026-11-13', status: 'confirmed', trade_type: 'buy', amount: 3000 })));
  assert.throws(() => store.save(input), /完整产品交易范围/);
  assert.equal(store.save({ ...input, scope_trade_ids: [1, 2] }).snapshot.scope_trade_ids.length, 2);
});

test('bank anchor rolls forward exact subsequent income, without reintroducing old residuals or crossing gaps', t => {
  const { db, store, input } = fixture(t); migrateProductHoldingIncome(db); store.save(input);
  db.prepare('INSERT INTO product_daily_valuations VALUES(2,?,?,?,?)').run('AB1234', '2026-11-20', .98, 9827);
  const summary = { status: 'active', active_amount: 6000, last_yield_date: '2026-11-20' };
  const next = store.latest('AB1234', summary, '2026-11-20');
  assert.equal(next.scope_status, 'rolled_forward');
  assert.equal(next.current_holding_income_1e4, 15827);
  assert.equal(next.current_holding_income, 1.58);
  assert.equal(next.holding_income, .60, 'bank snapshot itself remains immutable');
  assert.equal(next.difference, .01, 'original reconciliation residual remains visible');
  db.prepare('INSERT INTO product_daily_valuations VALUES(3,?,?,?,?)').run('AB1234', '2026-11-24', .98, 9827);
  const gap = store.latest('AB1234', { ...summary, last_yield_date: '2026-11-24' }, '2026-11-24');
  assert.equal(gap.scope_status, 'history');
  assert.equal(gap.projection_status, 'missing-income');
  assert.equal(gap.current_holding_income, null);
});

test('Monday combined income rolls forward weekend coverage but cannot overlap a bank anchor', t => {
  const { db, store, input } = fixture(t); migrateProductHoldingIncome(db);
  store.save({ ...input, as_of_date: '2026-11-20' }, { today: '2026-11-23' });
  db.prepare('INSERT INTO product_daily_valuations VALUES(2,?,?,?,?)').run('AB1234', '2026-11-23', .98, 9827);
  const summary = { status: 'active', active_amount: 6000, last_yield_date: '2026-11-23' };
  assert.equal(store.latest('AB1234', summary, '2026-11-23').scope_status, 'rolled_forward');
  store.save({ ...input, as_of_date: '2026-11-22' }, { today: '2026-11-23' });
  const overlapping = store.latest('AB1234', summary, '2026-11-23');
  assert.equal(overlapping.scope_status, 'history');
  assert.equal(overlapping.projection_status, 'combined-period-ambiguous');
});
