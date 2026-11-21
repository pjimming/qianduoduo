'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { parseYmd, todayShanghai, shiftDate } = require('./metrics');
const { effectiveCoveredYieldDates } = require('./product-income-coverage');
const { createTransactionManager } = require('./transaction');
const { toIncomeUnits, fromIncomeUnits, effectiveIncomeUnits, roundIncomeUnitsToCents } = require('./income-precision');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS product_holding_income_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_code TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  holding_income_cents INTEGER NOT NULL,
  holding_amount_cents INTEGER,
  evidence_id INTEGER NOT NULL,
  scope_trade_ids_json TEXT NOT NULL,
  scope_fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL,
  notes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(product_code, as_of_date)
);
CREATE TABLE IF NOT EXISTS product_holding_income_snapshot_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES product_holding_income_snapshots(id),
  version INTEGER NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(snapshot_id, version)
);`;

function migrated(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='product_holding_income_snapshots'").get());
}

function migrate(db) {
  return createTransactionManager(db).run(() => { db.exec(SCHEMA); return { version: 'product-holding-income-v1', migrated: true }; });
}

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const relevant = (t, code) => t.product_code === code || (t.trade_type === 'switch' && t.target_product_code === code);
const dateFor = t => t.confirm_date || t.trade_date;

function createProductHoldingIncomeStore(db, options = {}) {
  const transaction = options.transactionManager || createTransactionManager(db);
  const tradeStore = options.tradeStore;
  const getTrades = today => tradeStore?.getOverview?.(today)?.trades || [];
  const scopeFor = (code, date) => getTrades(date).filter(t => t.status === 'confirmed' && relevant(t, code) && dateFor(t) <= date)
    .sort((a, b) => a.id - b.id).map(t => ({ id: t.id, date: dateFor(t), type: t.trade_type, code: t.product_code,
      target: t.target_product_code, amount: t.amount, settlement_amount: t.settlement_amount, updated_at: t.updated_at }));
  const map = row => row ? { id: Number(row.id), product_code: row.product_code, as_of_date: row.as_of_date,
    holding_income: Number(row.holding_income_cents) / 100,
    holding_amount: row.holding_amount_cents == null ? null : Number(row.holding_amount_cents) / 100,
    source_screenshot_id: Number(row.evidence_id), evidence_id: Number(row.evidence_id),
    scope_trade_ids: JSON.parse(row.scope_trade_ids_json), scope_fingerprint: row.scope_fingerprint,
    version: Number(row.version), notes: row.notes, created_at: row.created_at, updated_at: row.updated_at } : null;

  function list(code) {
    if (!migrated(db)) return [];
    return db.prepare('SELECT * FROM product_holding_income_snapshots WHERE product_code=? ORDER BY as_of_date DESC,id DESC').all(code).map(map);
  }

  function save(input, context = {}) {
    if (!migrated(db)) throw new Error('银行持仓收益迁移尚未启用');
    const code = String(input.product_code || '').toUpperCase().trim();
    const date = String(input.as_of_date || '');
    const today = context.today || todayShanghai();
    if (!/^[A-Z0-9-]{4,32}$/.test(code) || !parseYmd(date) || date > today) throw new Error('产品代码或银行持仓收益截至日期无效');
    const cents = value => { const units = toIncomeUnits(value); if (units % 100) throw new Error('银行持仓收益快照金额最多两位小数'); return units / 100; };
    const income = cents(input.holding_income);
    const amount = input.holding_amount == null ? null : cents(input.holding_amount);
    if (amount !== null && amount < 0) throw new Error('持仓金额不能为负');
    const evidenceId = Number(input.evidence_id);
    const evidenceFile = options.getEvidenceFile?.(evidenceId);
    if (!Number.isSafeInteger(evidenceId) || !evidenceFile || !fs.existsSync(evidenceFile.path)) throw new Error('必须绑定可读取的原始银行持仓截图');
    const ids = [...new Set(input.scope_trade_ids || [])].map(Number).sort((a, b) => a - b);
    if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('持仓范围交易ID无效');
    const scope = scopeFor(code, date);
    // Empty scope is allowed only as historical evidence, never as a current balance.
    if (ids.length && JSON.stringify(ids) !== JSON.stringify(scope.map(t => t.id))) throw new Error('必须明确绑定截至日完整产品交易范围');
    const scopeHash = ids.length ? hash(scope) : '';
    const fact = { product_code: code, as_of_date: date, holding_income_cents: income, holding_amount_cents: amount,
      evidence_id: evidenceId, scope_trade_ids_json: JSON.stringify(ids), scope_fingerprint: scopeHash };
    const dedupe = hash(fact);
    return transaction.run(() => {
      const replay = db.prepare('SELECT snapshot_id FROM product_holding_income_snapshot_revisions WHERE dedupe_key=?').get(dedupe);
      if (replay) return { snapshot: map(db.prepare('SELECT * FROM product_holding_income_snapshots WHERE id=?').get(replay.snapshot_id)), duplicate: true };
      const before = db.prepare('SELECT * FROM product_holding_income_snapshots WHERE product_code=? AND as_of_date=?').get(code, date);
      if (before && Number(input.expected_version) !== Number(before.version)) throw new Error('同产品同日银行收益冲突；修正需携带当前版本');
      if (before && !String(input.correction_note || '').trim()) throw new Error('银行持仓收益修正必须说明原因');
      const stamp = context.now || new Date().toISOString();
      const version = before ? Number(before.version) + 1 : 1;
      let id;
      if (before) {
        id = before.id;
        db.prepare('UPDATE product_holding_income_snapshots SET holding_income_cents=?,holding_amount_cents=?,evidence_id=?,scope_trade_ids_json=?,scope_fingerprint=?,version=?,notes=?,updated_at=? WHERE id=?')
          .run(income, amount, evidenceId, fact.scope_trade_ids_json, scopeHash, version, String(input.notes || ''), stamp, id);
      } else {
        id = Number(db.prepare('INSERT INTO product_holding_income_snapshots(product_code,as_of_date,holding_income_cents,holding_amount_cents,evidence_id,scope_trade_ids_json,scope_fingerprint,version,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(code, date, income, amount, evidenceId, fact.scope_trade_ids_json, scopeHash, version, String(input.notes || ''), stamp, stamp).lastInsertRowid);
      }
      const after = db.prepare('SELECT * FROM product_holding_income_snapshots WHERE id=?').get(id);
      db.prepare('INSERT INTO product_holding_income_snapshot_revisions(snapshot_id,version,before_json,after_json,dedupe_key,reason,actor,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, version, JSON.stringify(before || {}), JSON.stringify(after), dedupe, String(input.correction_note || '用户截图确认银行持仓收益'), context.actor || 'user-confirmed', stamp);
      return { snapshot: map(after), duplicate: false };
    });
  }

  function latest(code, summary = {}, today = todayShanghai()) {
    const snapshot = list(code)[0];
    if (!snapshot) return null;
    const scope = scopeFor(code, snapshot.as_of_date);
    const currentScope = scopeFor(code, today);
    const scopeMatches = Boolean(snapshot.scope_fingerprint) && hash(scope) === snapshot.scope_fingerprint && hash(currentScope) === snapshot.scope_fingerprint;
    const evidenceFile = options.getEvidenceFile?.(snapshot.evidence_id);
    const evidence = Boolean(evidenceFile && fs.existsSync(evidenceFile.path));
    const rows = db.prepare('SELECT * FROM product_daily_valuations WHERE product_code=? AND yield_date<=?').all(code, snapshot.as_of_date);
    let units = rows.reduce((total, row) => { const next = total + effectiveIncomeUnits(row); if (!Number.isSafeInteger(next)) throw new Error('累计收益超出安全整数范围'); return next; }, 0);
    for (const trade of getTrades(snapshot.as_of_date).filter(t => t.status === 'confirmed' && t.product_code === code && ['redeem', 'switch'].includes(t.trade_type) && dateFor(t) <= snapshot.as_of_date)) {
      for (const allocation of trade.allocations || []) units -= toIncomeUnits(allocation.realized_pnl || 0);
    }
    const ledger = roundIncomeUnitsToCents(units) / 100;
    const costMatches = snapshot.holding_amount == null || summary.active_amount == null ||
      toIncomeUnits(snapshot.holding_amount) - toIncomeUnits(snapshot.holding_income) === toIncomeUnits(summary.active_amount);
    let scopeStatus = !scopeMatches || !evidence || !costMatches ? 'needs_review' : summary.status === 'active' && summary.last_yield_date && summary.last_yield_date <= snapshot.as_of_date ? 'current' : 'history';
    let currentIncomeUnits = toIncomeUnits(snapshot.holding_income);
    let projectionStatus = 'bank-confirmed';
    if (scopeStatus === 'history' && summary.status === 'active' && summary.last_yield_date > snapshot.as_of_date) {
      const later = db.prepare('SELECT * FROM product_daily_valuations WHERE product_code=? AND yield_date>? AND yield_date<=? ORDER BY yield_date')
        .all(code, snapshot.as_of_date, summary.last_yield_date);
      const covered = new Set();
      let ambiguous = false;
      for (const row of later) {
        const dates = [row.yield_date, ...effectiveCoveredYieldDates(row.notes, row.yield_date)];
        if (dates.some(date => date <= snapshot.as_of_date)) ambiguous = true;
        dates.forEach(date => covered.add(date));
        currentIncomeUnits += effectiveIncomeUnits(row);
        if (!Number.isSafeInteger(currentIncomeUnits)) throw new Error('累计收益超出安全整数范围');
      }
      let complete = later.length > 0;
      for (let date = shiftDate(snapshot.as_of_date, 1); date <= summary.last_yield_date; date = shiftDate(date, 1)) {
        if (!covered.has(date)) complete = false;
      }
      projectionStatus = ambiguous ? 'combined-period-ambiguous' : complete ? 'bank-anchor-plus-ledger' : 'missing-income';
      if (!ambiguous && complete) scopeStatus = 'rolled_forward';
    }
    return { ...snapshot, ledger_income: ledger, ledger_income_exact: fromIncomeUnits(units),
      difference: (toIncomeUnits(snapshot.holding_income) - toIncomeUnits(ledger)) / 10000,
      current_holding_income: ['current', 'rolled_forward'].includes(scopeStatus) ? roundIncomeUnitsToCents(currentIncomeUnits) / 100 : null,
      current_holding_income_1e4: ['current', 'rolled_forward'].includes(scopeStatus) ? currentIncomeUnits : null,
      projection_as_of_date: scopeStatus === 'rolled_forward' ? summary.last_yield_date : snapshot.as_of_date,
      projection_status: projectionStatus,
      scope_status: scopeStatus, precision_status: rows.every(r => r.daily_pnl_1e4 != null) ? 'recorded' : 'partial' };
  }

  return { list, save, latest, migrated: () => migrated(db) };
}

module.exports = { createProductHoldingIncomeStore, migrateProductHoldingIncome: migrate, hasProductHoldingIncomeSchema: migrated, PRODUCT_HOLDING_INCOME_SCHEMA: SCHEMA };
