'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTransactionManager } = require('./transaction');

const DAY_MS = 24 * 60 * 60 * 1000;
const MIGRATION_KEY = 'trade_migration_v1';

const TRADE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trade_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_date TEXT NOT NULL,
    confirm_date TEXT,
    trade_type TEXT NOT NULL CHECK (trade_type IN ('buy', 'redeem', 'switch')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled')),
    product_code TEXT NOT NULL,
    product_name TEXT NOT NULL,
    issuer TEXT NOT NULL DEFAULT '',
    risk_level TEXT NOT NULL DEFAULT 'R2',
    target_product_code TEXT NOT NULL DEFAULT '',
    target_product_name TEXT NOT NULL DEFAULT '',
    target_term_days INTEGER,
    target_maturity_date TEXT,
    amount REAL NOT NULL CHECK (amount > 0),
    settlement_amount REAL,
    shares REAL,
    term_days INTEGER,
    maturity_date TEXT,
    decision_id INTEGER,
    screenshot_id INTEGER,
    source TEXT NOT NULL DEFAULT 'manual',
    dedupe_key TEXT NOT NULL UNIQUE,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_trade_transactions_date
    ON trade_transactions(trade_date DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_trade_transactions_status
    ON trade_transactions(status, trade_date ASC, id ASC);

  CREATE TABLE IF NOT EXISTS trade_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    redeem_trade_id INTEGER NOT NULL,
    buy_trade_id INTEGER NOT NULL,
    principal REAL NOT NULL,
    realized_pnl REAL NOT NULL DEFAULT 0,
    days INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_trade_allocations_redeem
    ON trade_allocations(redeem_trade_id, id ASC);

  CREATE TABLE IF NOT EXISTS trade_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_name TEXT NOT NULL DEFAULT '',
    stored_name TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL DEFAULT '',
    bytes INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'applied', 'ignored')
    ),
    ocr_text TEXT NOT NULL DEFAULT '',
    parsed_json TEXT NOT NULL DEFAULT '{}',
    parse_confidence REAL NOT NULL DEFAULT 0,
    duplicate_of INTEGER,
    trade_id INTEGER,
    error TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    received_at TEXT NOT NULL,
    applied_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_trade_inbox_status
    ON trade_inbox(status, received_at ASC, id ASC);

  CREATE TABLE IF NOT EXISTS trade_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    before_json TEXT NOT NULL DEFAULT '',
    after_json TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_trade_audit_trade
    ON trade_audit(trade_id, id DESC);
`;

function round(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return 0;
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function parseYmd(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const stamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(stamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return stamp;
}

function addDays(date, days) {
  const stamp = parseYmd(date);
  if (stamp === null || !Number.isInteger(days) || days <= 0) return null;
  return new Date(stamp + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const start = parseYmd(from);
  const end = parseYmd(to);
  if (start === null || end === null) return 0;
  return Math.max(0, Math.round((end - start) / DAY_MS));
}

function holdingStartDate(trade) {
  return trade.confirm_date || trade.trade_date;
}

function tradeKey(trade) {
  return [
    trade.trade_date,
    trade.trade_type,
    String(trade.product_code || '').trim().toUpperCase(),
    round(trade.amount),
    trade.status,
  ].join('|');
}

function mapTrade(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    trade_date: row.trade_date,
    confirm_date: row.confirm_date || null,
    trade_type: row.trade_type,
    status: row.status,
    product_code: row.product_code,
    product_name: row.product_name,
    issuer: row.issuer || '',
    risk_level: row.risk_level || 'R2',
    target_product_code: row.target_product_code || '',
    target_product_name: row.target_product_name || '',
    target_term_days:
      row.target_term_days === null ? null : Number(row.target_term_days),
    target_maturity_date: row.target_maturity_date || null,
    amount: Number(row.amount),
    settlement_amount:
      row.settlement_amount === null ? null : Number(row.settlement_amount),
    shares: row.shares === null ? null : Number(row.shares),
    term_days: row.term_days === null ? null : Number(row.term_days),
    maturity_date: row.maturity_date || null,
    decision_id: row.decision_id === null ? null : Number(row.decision_id),
    screenshot_id:
      row.screenshot_id === null ? null : Number(row.screenshot_id),
    source: row.source || 'manual',
    notes: row.notes || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapInbox(row) {
  if (!row) return null;
  let parsed = {};
  try {
    parsed = JSON.parse(row.parsed_json || '{}');
  } catch {
    parsed = {};
  }
  return {
    id: Number(row.id),
    original_name: row.original_name || '',
    stored_name: row.stored_name || '',
    mime: row.mime || '',
    bytes: Number(row.bytes || 0),
    sha256: row.sha256,
    status: row.status,
    ocr_text: row.ocr_text || '',
    parsed,
    parse_confidence: Number(row.parse_confidence || 0),
    duplicate_of: row.duplicate_of === null ? null : Number(row.duplicate_of),
    trade_id: row.trade_id === null ? null : Number(row.trade_id),
    error: row.error || '',
    notes: row.notes || '',
    received_at: row.received_at,
    applied_at: row.applied_at || null,
    evidence_id:
      row.evidence_id === null || row.evidence_id === undefined
        ? null
        : Number(row.evidence_id),
    workflow_state: row.workflow_state || 'needs_correction',
    selected_event_id:
      row.selected_event_id === null ||
      row.selected_event_id === undefined
        ? null
        : Number(row.selected_event_id),
    state_version: Number(row.state_version || 0),
    last_request_id: row.last_request_id || '',
    image_url: row.stored_name ? `/api/trades/inbox/${row.id}/image` : null,
  };
}

function createTradeStore(db, options = {}) {
  db.exec(TRADE_SCHEMA);
  const inboxDir = options.inboxDir || path.join(process.cwd(), 'data', 'trade-inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  const logger = options.logger || console;
  const transactionManager =
    options.transactionManager || createTransactionManager(db);
  let dataTrustStore = options.dataTrustStore || null;

  const selectTrades = db.prepare(
    'SELECT * FROM trade_transactions ORDER BY trade_date DESC, id DESC',
  );
  const selectTrade = db.prepare('SELECT * FROM trade_transactions WHERE id = ?');
  const selectTradeByKey = db.prepare(
    'SELECT * FROM trade_transactions WHERE dedupe_key = ?',
  );
  const selectConfirmedDuplicate = db.prepare(`
    SELECT * FROM trade_transactions
    WHERE trade_date = ? AND trade_type = ? AND product_code = ?
      AND status = 'confirmed' AND ABS(amount - ?) < 0.005 AND id <> ?
    LIMIT 1
  `);
  const selectPotentialDuplicate = db.prepare(`
    SELECT * FROM trade_transactions
    WHERE trade_date = ? AND trade_type = ? AND product_code = ?
      AND ABS(amount - ?) < 0.005 AND status <> 'cancelled'
    ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `);
  const insertTrade = db.prepare(`
    INSERT INTO trade_transactions (
      trade_date, confirm_date, trade_type, status, product_code, product_name,
      issuer, risk_level, target_product_code, target_product_name,
      target_term_days, target_maturity_date, amount, settlement_amount, shares,
      term_days, maturity_date, decision_id, screenshot_id, source, dedupe_key,
      notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateTradeStatement = db.prepare(`
    UPDATE trade_transactions
    SET trade_date = ?, confirm_date = ?, trade_type = ?, status = ?,
        product_code = ?, product_name = ?, issuer = ?, risk_level = ?,
        target_product_code = ?, target_product_name = ?, target_term_days = ?,
        target_maturity_date = ?, amount = ?, settlement_amount = ?, shares = ?,
        term_days = ?, maturity_date = ?, decision_id = ?, screenshot_id = ?,
        source = ?, dedupe_key = ?, notes = ?, updated_at = ?
    WHERE id = ?
  `);
  const selectAllocations = db.prepare(`
    SELECT * FROM trade_allocations ORDER BY id ASC
  `);
  const selectAllocationsByRedeem = db.prepare(`
    SELECT * FROM trade_allocations WHERE redeem_trade_id = ? ORDER BY id ASC
  `);
  const insertAllocation = db.prepare(`
    INSERT INTO trade_allocations (
      redeem_trade_id, buy_trade_id, principal, realized_pnl, days, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const deleteAllocations = db.prepare('DELETE FROM trade_allocations');
  const insertAudit = db.prepare(`
    INSERT INTO trade_audit (
      trade_id, action, before_json, after_json, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const selectAudits = db.prepare(
    'SELECT * FROM trade_audit WHERE trade_id = ? ORDER BY id DESC',
  );

  const selectInbox = db.prepare(
    'SELECT * FROM trade_inbox ORDER BY received_at DESC, id DESC',
  );
  const selectInboxItem = db.prepare('SELECT * FROM trade_inbox WHERE id = ?');
  const selectInboxByHash = db.prepare('SELECT * FROM trade_inbox WHERE sha256 = ?');
  const insertInbox = db.prepare(`
    INSERT INTO trade_inbox (
      original_name, stored_name, mime, bytes, sha256, status, ocr_text,
      parsed_json, parse_confidence, duplicate_of, error, notes, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateInboxStatement = db.prepare(`
    UPDATE trade_inbox
    SET ocr_text = ?, parsed_json = ?, parse_confidence = ?, error = ?, notes = ?, duplicate_of = ?,
        status = ?, trade_id = ?, applied_at = ?, stored_name = ?
    WHERE id = ?
  `);

  const selectMeta = db.prepare('SELECT value FROM app_meta WHERE key = ?');
  const upsertMeta = db.prepare(`
    INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  function getMeta(key) {
    return selectMeta.get(key)?.value ?? null;
  }

  function setMeta(key, value) {
    upsertMeta.run(key, String(value), new Date().toISOString());
  }

  function listTrades() {
    return selectTrades.all().map(mapTrade);
  }

  function getTrade(id) {
    const trade = mapTrade(selectTrade.get(id));
    if (!trade) return null;
    trade.allocations = selectAllocationsByRedeem.all(id).map((row) => ({
      id: Number(row.id),
      redeem_trade_id: Number(row.redeem_trade_id),
      buy_trade_id: Number(row.buy_trade_id),
      principal: Number(row.principal),
      realized_pnl: Number(row.realized_pnl),
      days: Number(row.days),
      created_at: row.created_at,
    }));
    return trade;
  }

  function audit(tradeId, action, before, after, note = '') {
    const stamp = new Date().toISOString();
    const result = insertAudit.run(
      tradeId,
      action,
      before ? JSON.stringify(before) : '',
      after ? JSON.stringify(after) : '',
      note,
      stamp,
    );
    if (dataTrustStore?.enabled && after) {
      const revision = dataTrustStore.recordFactRevision({
        factType: 'trade',
        factKey: `trade:${tradeId}`,
        action,
        before: before || {},
        after,
        reason: note,
        sourceClass: after.screenshot_id ? 'screenshot' : (
          String(after.source || '').includes('migration')
            ? 'migration'
            : 'manual'
        ),
        actorType: 'human',
        actorRef: 'trade-service',
        operationId: `trade-audit:${Number(result.lastInsertRowid)}`,
        requestId: `trade-audit:${Number(result.lastInsertRowid)}`,
        createdAt: stamp,
      });
      if (revision && after.screenshot_id) {
        dataTrustStore.linkFactToInbox({
          factType: 'trade',
          factKey: `trade:${tradeId}`,
          revisionId: revision.id,
          inboxKind: 'trade',
          inboxId: after.screenshot_id,
          fieldPaths: [
            'trade_date',
            'trade_type',
            'product_code',
            'amount',
            'status',
          ],
          confidence: null,
        });
      }
    }
  }

  function withTransaction(callback) {
    return transactionManager.run(callback);
  }

  function setDataTrustStore(store) {
    dataTrustStore = store || null;
  }

  function normalizeTrade(input) {
    const tradeDate = String(input.trade_date || '');
    const type = input.trade_type;
    const maturityBaseDate =
      input.status === 'confirmed' && input.confirm_date
        ? String(input.confirm_date)
        : tradeDate;
    const termDays =
      input.term_days === null || input.term_days === undefined
        ? null
        : Number(input.term_days);
    const targetTermDays =
      input.target_term_days === null || input.target_term_days === undefined
        ? null
        : Number(input.target_term_days);
    return {
      trade_date: tradeDate,
      confirm_date: input.confirm_date || null,
      trade_type: type,
      status: input.status,
      product_code: String(input.product_code || '').trim(),
      product_name: String(input.product_name || '').trim(),
      issuer: String(input.issuer || '').trim(),
      risk_level: String(input.risk_level || 'R2').trim().toUpperCase(),
      target_product_code: String(input.target_product_code || '').trim(),
      target_product_name: String(input.target_product_name || '').trim(),
      target_term_days: targetTermDays,
      target_maturity_date:
        input.target_maturity_date ||
        (targetTermDays && targetTermDays > 0
          ? addDays(maturityBaseDate, targetTermDays)
          : null),
      amount: round(input.amount),
      settlement_amount:
        input.settlement_amount === null || input.settlement_amount === undefined
          ? null
          : round(input.settlement_amount),
      shares:
        input.shares === null || input.shares === undefined
          ? null
          : round(input.shares, 4),
      term_days: termDays,
      maturity_date:
        input.maturity_date ||
        (termDays && termDays > 0 ? addDays(maturityBaseDate, termDays) : null),
      decision_id:
        input.decision_id === null || input.decision_id === undefined
          ? null
          : Number(input.decision_id),
      screenshot_id:
        input.screenshot_id === null || input.screenshot_id === undefined
          ? null
          : Number(input.screenshot_id),
      source: input.source || 'manual',
      notes: String(input.notes || '').trim(),
    };
  }

  function insertTradeRow(trade, id = null) {
    const stamp = new Date().toISOString();
    const key = tradeKey(trade);
    if (id === null) {
      const result = insertTrade.run(
        trade.trade_date,
        trade.confirm_date,
        trade.trade_type,
        trade.status,
        trade.product_code,
        trade.product_name,
        trade.issuer,
        trade.risk_level,
        trade.target_product_code,
        trade.target_product_name,
        trade.target_term_days,
        trade.target_maturity_date,
        trade.amount,
        trade.settlement_amount,
        trade.shares,
        trade.term_days,
        trade.maturity_date,
        trade.decision_id,
        trade.screenshot_id,
        trade.source,
        key,
        trade.notes,
        stamp,
        stamp,
      );
      return Number(result.lastInsertRowid);
    }
    updateTradeStatement.run(
      trade.trade_date,
      trade.confirm_date,
      trade.trade_type,
      trade.status,
      trade.product_code,
      trade.product_name,
      trade.issuer,
      trade.risk_level,
      trade.target_product_code,
      trade.target_product_name,
      trade.target_term_days,
      trade.target_maturity_date,
      trade.amount,
      trade.settlement_amount,
      trade.shares,
      trade.term_days,
      trade.maturity_date,
      trade.decision_id,
      trade.screenshot_id,
      trade.source,
      key,
      trade.notes,
      stamp,
      id,
    );
    return id;
  }

  function createTrade(input, auditNote = '') {
    const trade = normalizeTrade(input);
    if (selectTradeByKey.get(tradeKey(trade))) {
      const error = new Error('已存在交易日期、类型、产品、金额和状态都相同的交易');
      error.code = 'DUPLICATE_TRADE';
      throw error;
    }
    const id = withTransaction(() => {
      const insertedId = insertTradeRow(trade);
      rebuildAllocations();
      audit(insertedId, 'create', null, getTrade(insertedId), auditNote);
      return insertedId;
    });
    return getTrade(id);
  }

  function updateTrade(id, input, note = '') {
    const before = getTrade(id);
    if (!before) return null;
    const next = normalizeTrade({ ...before, ...input });
    const duplicate = selectTradeByKey.get(tradeKey(next));
    if (duplicate && Number(duplicate.id) !== Number(id)) {
      const error = new Error('修改后与另一笔交易完全重复');
      error.code = 'DUPLICATE_TRADE';
      throw error;
    }
    if (next.status === 'confirmed') {
      const confirmedDuplicate = selectConfirmedDuplicate.get(
        next.trade_date,
        next.trade_type,
        next.product_code,
        next.amount,
        id,
      );
      if (confirmedDuplicate) {
        const error = new Error('已有一笔字段相同的已确认交易');
        error.code = 'DUPLICATE_TRADE';
        throw error;
      }
    }
    withTransaction(() => {
      insertTradeRow(next, id);
      rebuildAllocations();
      audit(id, 'update', before, getTrade(id), note);
    });
    return getTrade(id);
  }

  function confirmTrade(id, confirmDate, note = '') {
    const before = getTrade(id);
    if (!before) return null;
    const nextConfirmDate =
      confirmDate || before.confirm_date || before.trade_date;
    const next = {
      ...before,
      status: 'confirmed',
      confirm_date: nextConfirmDate,
    };
    if (before.status !== 'confirmed') {
      if (
        (before.trade_type === 'buy' || before.trade_type === 'switch') &&
        Number.isInteger(before.term_days) &&
        before.term_days > 0
      ) {
        next.maturity_date = addDays(nextConfirmDate, before.term_days);
      }
      if (
        before.trade_type === 'switch' &&
        Number.isInteger(before.target_term_days) &&
        before.target_term_days > 0
      ) {
        next.target_maturity_date = addDays(
          nextConfirmDate,
          before.target_term_days,
        );
      }
    }
    const duplicate = selectConfirmedDuplicate.get(
      next.trade_date,
      next.trade_type,
      next.product_code,
      next.amount,
      id,
    );
    if (duplicate) {
      const error = new Error('已有一笔字段相同的已确认交易，未重复确认');
      error.code = 'DUPLICATE_TRADE';
      throw error;
    }
    withTransaction(() => {
      insertTradeRow(normalizeTrade(next), id);
      rebuildAllocations();
      audit(id, 'confirm', before, getTrade(id), note);
    });
    return getTrade(id);
  }

  function cancelTrade(id, note = '') {
    const before = getTrade(id);
    if (!before) return null;
    if (before.status === 'cancelled') return before;
    const next = { ...before, status: 'cancelled' };
    withTransaction(() => {
      insertTradeRow(normalizeTrade(next), id);
      rebuildAllocations();
      audit(id, 'cancel', before, getTrade(id), note);
    });
    return getTrade(id);
  }

  function allocate(code, needAmount, trade, lots, allocations, profitTotal) {
    let remaining = round(needAmount);
    const productLots = lots.get(code) || [];
    for (const lot of productLots) {
      if (remaining <= 0.004) break;
      if (lot.remaining <= 0.004) continue;
      const take = round(Math.min(lot.remaining, remaining));
      if (take <= 0) continue;
      const share = needAmount > 0 ? take / needAmount : 0;
      const realized = round(profitTotal * share);
      lot.remaining = round(lot.remaining - take);
      lot.allocated = round(lot.allocated + take);
      lot.realized_pnl = round(lot.realized_pnl + realized);
      allocations.push({
        redeem_trade_id: trade.id,
        buy_trade_id: lot.trade_id,
        principal: take,
        realized_pnl: realized,
        days: daysBetween(lot.acquisition_date, holdingStartDate(trade)),
      });
      remaining = round(remaining - take);
    }
    if (remaining > 0.004) {
      const error = new Error(
        `${trade.product_name}（${code}）可匹配本金不足，尚缺 ¥${remaining.toFixed(2)}`,
      );
      error.code = 'ALLOCATION_SHORTFALL';
      throw error;
    }
  }

  function rebuildAllocations() {
    deleteAllocations.run();
    const trades = listTrades()
      .filter((trade) => trade.status === 'confirmed')
      .sort(
        (a, b) =>
          holdingStartDate(a).localeCompare(holdingStartDate(b)) ||
          a.trade_date.localeCompare(b.trade_date) ||
          a.id - b.id,
      );
    const lots = new Map();
    const allocations = [];

    for (const trade of trades) {
      if (trade.trade_type === 'buy') {
        const list = lots.get(trade.product_code) || [];
        list.push({
          trade_id: trade.id,
          acquisition_date: holdingStartDate(trade),
          original: trade.amount,
          remaining: trade.amount,
          allocated: 0,
          realized_pnl: 0,
          term_days: trade.term_days,
          maturity_date: trade.maturity_date,
        });
        lots.set(trade.product_code, list);
        continue;
      }
      const profitTotal =
        trade.settlement_amount === null
          ? 0
          : round(trade.settlement_amount - trade.amount);
      allocate(
        trade.product_code,
        trade.amount,
        trade,
        lots,
        allocations,
        profitTotal,
      );
      if (trade.trade_type === 'switch') {
        const targetCode = trade.target_product_code || trade.product_code;
        const targetList = lots.get(targetCode) || [];
        targetList.push({
          trade_id: trade.id,
          acquisition_date: holdingStartDate(trade),
          original: round(trade.settlement_amount ?? trade.amount),
          remaining: round(trade.settlement_amount ?? trade.amount),
          allocated: 0,
          realized_pnl: 0,
          term_days: trade.target_term_days,
          maturity_date: trade.target_maturity_date,
        });
        lots.set(targetCode, targetList);
      }
    }

    const stamp = new Date().toISOString();
    for (const item of allocations) {
      insertAllocation.run(
        item.redeem_trade_id,
        item.buy_trade_id,
        item.principal,
        item.realized_pnl,
        item.days,
        stamp,
      );
    }
    return { allocations, lots };
  }

  function getPortfolio() {
    const { lots } = rebuildAllocations();
    const tradeMap = new Map(listTrades().map((trade) => [trade.id, trade]));
    const holdings = [];
    for (const [code, list] of lots.entries()) {
      for (const lot of list) {
        if (lot.remaining <= 0.004) continue;
        const trade = tradeMap.get(lot.trade_id);
        if (!trade) continue;
        const isSwitchTarget =
          trade.trade_type === 'switch' && code === trade.target_product_code;
        holdings.push({
          id: lot.trade_id,
          lot_id: `${lot.trade_id}:${code}`,
          product_name: isSwitchTarget
            ? trade.target_product_name || trade.product_name
            : trade.product_name,
          product_code: code,
          issuer: trade.issuer || '',
          risk_level: trade.risk_level || 'R2',
          amount: round(lot.remaining),
          original_amount: round(lot.original),
          allocated_principal: round(lot.allocated),
          realized_pnl: round(lot.realized_pnl),
          purchase_date: lot.acquisition_date,
          term_days: lot.term_days,
          maturity_date: lot.maturity_date,
          notes: trade.notes || '',
          source_trade_id: lot.trade_id,
          created_at: trade.created_at,
          updated_at: trade.updated_at,
        });
      }
    }
    holdings.sort(
      (a, b) =>
        a.purchase_date.localeCompare(b.purchase_date) ||
        a.source_trade_id - b.source_trade_id,
    );
    return holdings;
  }

  function getOverview(today) {
    const trades = listTrades();
    const inbox = listInbox();
    const holdings = getPortfolio();
    const allocations = selectAllocations.all().map((row) => ({
      id: Number(row.id),
      redeem_trade_id: Number(row.redeem_trade_id),
      buy_trade_id: Number(row.buy_trade_id),
      principal: Number(row.principal),
      realized_pnl: Number(row.realized_pnl),
      days: Number(row.days),
      created_at: row.created_at,
    }));
    const allocationsByTrade = new Map();
    for (const item of allocations) {
      const list = allocationsByTrade.get(item.redeem_trade_id) || [];
      list.push(item);
      allocationsByTrade.set(item.redeem_trade_id, list);
    }
    const pending = trades.filter((trade) => trade.status === 'pending');
    const confirmed = trades.filter((trade) => trade.status === 'confirmed');
    const cancelled = trades.filter((trade) => trade.status === 'cancelled');
    const realizedPnl = allocations.reduce(
      (sum, item) => sum + item.realized_pnl,
      0,
    );
    const pendingBuys = pending.filter(
      (trade) => trade.trade_type === 'buy' || trade.trade_type === 'switch',
    );
    const pendingRedeems = pending.filter(
      (trade) => trade.trade_type === 'redeem' || trade.trade_type === 'switch',
    );
    const openPrincipal = holdings.reduce(
      (sum, holding) => sum + holding.amount,
      0,
    );
    const matured = holdings.filter(
      (holding) =>
        holding.maturity_date && holding.maturity_date < today,
    );
    const reconciliation = buildReconciliation({
      today,
      trades,
      inbox,
      allocationsByTrade,
    });

    return {
      trades: trades.map((trade) => ({
        ...trade,
        allocations: allocationsByTrade.get(trade.id) || [],
        has_screenshot: Boolean(trade.screenshot_id),
      })),
      inbox,
      allocations,
      holdings,
      summary: {
        trade_count: trades.length,
        pending_count: pending.length,
        pending_buy_amount: round(
          pendingBuys.reduce((sum, trade) => sum + trade.amount, 0),
        ),
        pending_redeem_amount: round(
          pendingRedeems.reduce((sum, trade) => sum + trade.amount, 0),
        ),
        confirmed_count: confirmed.length,
        cancelled_count: cancelled.length,
        open_principal: round(openPrincipal),
        open_count: holdings.length,
        realized_pnl: round(realizedPnl),
        matured_count: matured.length,
        matured_amount: round(
          matured.reduce((sum, holding) => sum + holding.amount, 0),
        ),
        unprocessed_inbox: inbox.filter((item) => item.status === 'pending').length,
      },
      reconciliation,
    };
  }

  function buildReconciliation({ today, trades, inbox, allocationsByTrade }) {
    const items = [];
    const inboxById = new Map(inbox.map((item) => [item.id, item]));

    for (const trade of trades) {
      if (trade.status === 'pending') {
        const age = daysBetween(trade.trade_date, today);
        if (age >= 3) {
          items.push({
            level: age >= 7 ? 'warn' : 'info',
            code: 'stale-pending',
            trade_id: trade.id,
            text: `${trade.product_name} 自 ${trade.trade_date} 起仍待确认，已 ${age} 天。`,
          });
        }
      }
      if (!trade.screenshot_id && trade.source !== 'migration') {
        items.push({
          level: 'warn',
          code: 'missing-screenshot',
          trade_id: trade.id,
          text: `${trade.product_name}（${trade.product_code}）缺少成交截图。`,
        });
      } else if (!trade.screenshot_id && trade.source === 'migration') {
        items.push({
          level: 'info',
          code: 'migration-no-screenshot',
          trade_id: trade.id,
          text: `${trade.product_name} 由持仓迁移而来，尚未附成交截图。`,
        });
      }
      if (trade.status === 'confirmed' && trade.settlement_amount === null) {
        if (trade.trade_type === 'redeem' || trade.trade_type === 'switch') {
          items.push({
            level: 'info',
            code: 'missing-settlement',
            trade_id: trade.id,
            text: `${trade.product_name} 尚未填写实际到账金额，已实现盈亏暂按 0 计。`,
          });
        }
      }
      if (trade.screenshot_id) {
        const inboxItem = inboxById.get(trade.screenshot_id);
        const parsed = inboxItem?.parsed || {};
        if (
          parsed.amount &&
          Math.abs(Number(parsed.amount) - trade.amount) > 0.01
        ) {
          items.push({
            level: 'warn',
            code: 'amount-mismatch',
            trade_id: trade.id,
            text: `${trade.product_name} 截图金额 ¥${Number(
              parsed.amount,
            ).toFixed(2)} 与流水 ¥${trade.amount.toFixed(2)} 不一致。`,
          });
        }
        if (
          parsed.product_code &&
          String(parsed.product_code).toUpperCase() !==
            String(trade.product_code).toUpperCase()
        ) {
          items.push({
            level: 'warn',
            code: 'code-mismatch',
            trade_id: trade.id,
            text: `${trade.product_name} 截图代码 ${parsed.product_code} 与流水 ${trade.product_code} 不一致。`,
          });
        }
      }
      if (
        (trade.trade_type === 'redeem' || trade.trade_type === 'switch') &&
        trade.status === 'confirmed' &&
        !(allocationsByTrade.get(trade.id) || []).length
      ) {
        items.push({
          level: 'warn',
          code: 'no-allocation',
          trade_id: trade.id,
          text: `${trade.product_name} 的赎回没有匹配到买入批次。`,
        });
      }
    }

    for (const item of inbox) {
      if (item.status !== 'pending') continue;
      const age = daysBetween(item.received_at.slice(0, 10), today);
      items.push({
        level: age >= 1 ? 'info' : 'info',
        code: 'inbox-unprocessed',
        inbox_id: item.id,
        text: `收件箱有未处理截图：${item.original_name || `#${item.id}`}，来自 ${
          item.received_at.slice(0, 10)
        }。`,
      });
    }

    const levelOrder = { warn: 0, info: 1 };
    items.sort(
      (a, b) =>
        (levelOrder[a.level] ?? 2) - (levelOrder[b.level] ?? 2) ||
        a.text.localeCompare(b.text),
    );
    return {
      generated_for: today,
      counts: {
        warn: items.filter((item) => item.level === 'warn').length,
        info: items.filter((item) => item.level === 'info').length,
        missing_screenshot: items.filter(
          (item) => item.code === 'missing-screenshot',
        ).length,
        amount_mismatch: items.filter(
          (item) => item.code === 'amount-mismatch',
        ).length,
        stale_pending: items.filter((item) => item.code === 'stale-pending')
          .length,
      },
      items,
    };
  }

  function listInbox() {
    return selectInbox.all().map(mapInbox);
  }

  function getInboxItem(id) {
    return mapInbox(selectInboxItem.get(id));
  }

  function getInboxByHash(sha256) {
    return mapInbox(selectInboxByHash.get(sha256));
  }

  function addInbox(input) {
    const stamp = new Date().toISOString();
    const result = insertInbox.run(
      input.original_name || '',
      input.stored_name || '',
      input.mime || '',
      Number(input.bytes || 0),
      input.sha256,
      'pending',
      input.ocr_text || '',
      JSON.stringify(input.parsed || {}),
      Number(input.parse_confidence || 0),
      input.duplicate_of ?? null,
      input.error || '',
      input.notes || '',
      stamp,
    );
    return getInboxItem(Number(result.lastInsertRowid));
  }

  function updateInbox(id, input) {
    const before = getInboxItem(id);
    if (!before) return null;
    const next = {
      ...before,
      ...input,
      parsed: input.parsed || before.parsed,
    };
    updateInboxStatement.run(
      next.ocr_text ?? before.ocr_text,
      JSON.stringify(next.parsed || {}),
      Number(next.parse_confidence ?? before.parse_confidence),
      next.error ?? before.error,
      next.notes ?? before.notes,
      next.duplicate_of ?? before.duplicate_of,
      next.status ?? before.status,
      next.trade_id ?? before.trade_id,
      next.applied_at ?? before.applied_at,
      next.stored_name ?? before.stored_name,
      id,
    );
    return getInboxItem(id);
  }

  function applyInbox(id, overrides = {}) {
    return withTransaction(() => applyInboxCore(id, overrides));
  }

  function applyInboxCore(id, overrides = {}) {
    const before = getInboxItem(id);
    if (!before) return null;
    if (before.status === 'applied' && before.trade_id) {
      return {
        inbox: before,
        trade: getTrade(before.trade_id),
        matched: true,
        duplicate: true,
      };
    }
    const parsed = { ...before.parsed, ...overrides };
    const input = {
      trade_date: parsed.trade_date,
      confirm_date: parsed.confirm_date,
      trade_type: parsed.trade_type,
      status: parsed.status || 'pending',
      product_code: parsed.product_code,
      product_name: parsed.product_name,
      issuer: parsed.issuer,
      risk_level: parsed.risk_level || 'R2',
      amount: parsed.amount,
      settlement_amount: parsed.settlement_amount,
      shares: parsed.shares,
      term_days: parsed.term_days,
      maturity_date: parsed.maturity_date,
      decision_id: parsed.decision_id,
      source: 'inbox',
      screenshot_id: id,
      notes: parsed.notes || before.notes || '',
    };
    const trade = normalizeTrade(input);
    const existing =
      selectTradeByKey.get(tradeKey(trade)) ||
      selectConfirmedDuplicate.get(
        trade.trade_date,
        trade.trade_type,
        trade.product_code,
        trade.amount,
        -1,
      ) ||
      selectPotentialDuplicate.get(
        trade.trade_date,
        trade.trade_type,
        trade.product_code,
        trade.amount,
      );
    if (existing) {
      const existingTrade = mapTrade(existing);
      let updated = existingTrade;
      if (existingTrade.status === 'pending' && trade.status === 'confirmed') {
        updated = confirmTrade(
          existingTrade.id,
          trade.confirm_date || trade.trade_date,
          '收件箱截图确认已有待确认交易',
        );
      }
      if (!existingTrade.screenshot_id) {
        updated = updateTrade(
          updated.id,
          {
            ...updated,
            screenshot_id: id,
            confirm_date: updated.confirm_date,
            notes: updated.notes,
          },
          '收件箱截图匹配到已有交易',
        );
      }
      if (!updated.decision_id && trade.decision_id) {
        updated = updateTrade(
          updated.id,
          {
            ...updated,
            decision_id: trade.decision_id,
          },
          '收件箱截图补充关联决策',
        );
      }
      const inbox = updateInbox(id, {
        status: 'applied',
        trade_id: updated.id,
        duplicate_of: updated.id,
        applied_at: new Date().toISOString(),
        parsed,
        parse_confidence: parsed.confidence ?? before.parse_confidence,
      });
      return {
        inbox,
        trade: updated,
        matched: true,
        duplicate: true,
      };
    }
    const created = createTrade(trade, '由交易收件箱创建');
    const inbox = updateInbox(id, {
      status: 'applied',
      trade_id: created.id,
      applied_at: new Date().toISOString(),
      parsed,
      parse_confidence: parsed.confidence ?? before.parse_confidence,
    });
    return { inbox, trade: created, matched: false, duplicate: false };
  }

  function findMatchingTrade(input) {
    const trade = normalizeTrade(input);
    const row =
      selectTradeByKey.get(tradeKey(trade)) ||
      selectConfirmedDuplicate.get(
        trade.trade_date,
        trade.trade_type,
        trade.product_code,
        trade.amount,
        -1,
      ) ||
      selectPotentialDuplicate.get(
        trade.trade_date,
        trade.trade_type,
        trade.product_code,
        trade.amount,
      );
    return row ? mapTrade(row) : null;
  }

  function ignoreInbox(id, note = '') {
    const before = getInboxItem(id);
    if (!before) return null;
    return updateInbox(id, {
      status: 'ignored',
      applied_at: new Date().toISOString(),
      notes: note || before.notes,
    });
  }

  function getInboxFilePath(id) {
    const item = getInboxItem(id);
    if (!item || !item.stored_name) return null;
    const target = path.resolve(inboxDir, item.stored_name);
    const prefix = `${path.resolve(inboxDir)}${path.sep}`;
    if (!target.startsWith(prefix)) return null;
    if (!fs.existsSync(target)) return null;
    return { path: target, mime: item.mime || 'image/png' };
  }

  function saveInboxImage({ buffer, mime, originalName }) {
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const existing = getInboxByHash(sha256);
    if (existing) {
      return { item: existing, duplicate: true, sha256 };
    }
    const extensions = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
    };
    const extension = extensions[mime] || '.png';
    const storedName = `${Date.now()}-${sha256.slice(0, 12)}${extension}`;
    fs.writeFileSync(path.join(inboxDir, storedName), buffer);
    return {
      item: { stored_name: storedName, mime, bytes: buffer.length, sha256, original_name: originalName },
      duplicate: false,
      sha256,
    };
  }

  function pruneScreenshots({ today, olderThanDays = 180 } = {}) {
    const thresholdStamp = parseYmd(today) - olderThanDays * DAY_MS;
    const threshold = new Date(thresholdStamp).toISOString().slice(0, 10);
    const rows = selectInbox.all();
    let removed = 0;
    for (const row of rows) {
      if (!row.stored_name) continue;
      if (!['applied', 'ignored'].includes(row.status)) continue;
      if (row.evidence_id) {
        const linked = db
          .prepare(`
            SELECT 1 FROM fact_evidence_links
            WHERE evidence_id = ? AND link_status = 'active'
            LIMIT 1
          `)
          .get(row.evidence_id);
        if (linked) continue;
      }
      if (row.received_at.slice(0, 10) >= threshold) continue;
      const target = path.resolve(inboxDir, row.stored_name);
      const prefix = `${path.resolve(inboxDir)}${path.sep}`;
      if (target.startsWith(prefix) && fs.existsSync(target)) {
        fs.unlinkSync(target);
        removed += 1;
      }
      updateInboxStatement.run(
        row.ocr_text,
        row.parsed_json,
        row.parse_confidence,
        row.error,
        row.notes,
        row.duplicate_of,
        row.status,
        row.trade_id,
        row.applied_at,
        '',
        row.id,
      );
    }
    return { removed, threshold };
  }

  function migrateLegacyHoldings() {
    if (getMeta(MIGRATION_KEY)) return { migrated: 0, skipped: true };
    const existingTrades = Number(
      db.prepare('SELECT COUNT(*) AS count FROM trade_transactions').get().count,
    );
    if (existingTrades > 0) {
      setMeta(MIGRATION_KEY, new Date().toISOString());
      return { migrated: 0, skipped: true };
    }
    const rows = db
      .prepare('SELECT * FROM holdings ORDER BY purchase_date ASC, id ASC')
      .all();
    let migrated = 0;
    let skipped = 0;
    for (const row of rows) {
      try {
        createTrade(
          {
            trade_date: row.purchase_date,
            confirm_date: null,
            trade_type: 'buy',
            status: 'pending',
            product_code: row.product_code || row.product_name,
            product_name: row.product_name,
            issuer: row.issuer,
            risk_level: row.risk_level || 'R2',
            amount: row.amount,
            term_days: row.term_days,
            maturity_date: row.maturity_date,
            source: 'migration',
            notes: row.notes || '由持仓快照迁移为待确认买入',
          },
          '持仓快照迁移',
        );
        migrated += 1;
      } catch (error) {
        skipped += 1;
        logger.warn?.(`持仓迁移跳过：${row.product_name}：${error.message}`);
      }
    }
    setMeta(MIGRATION_KEY, new Date().toISOString());
    return { migrated, skipped: false, skippedCount: skipped };
  }

  function getAudits(tradeId) {
    return selectAudits.all(tradeId).map((row) => {
      let before = null;
      let after = null;
      try {
        before = row.before_json ? JSON.parse(row.before_json) : null;
      } catch {
        before = null;
      }
      try {
        after = row.after_json ? JSON.parse(row.after_json) : null;
      } catch {
        after = null;
      }
      return {
        id: Number(row.id),
        trade_id: Number(row.trade_id),
        action: row.action,
        before,
        after,
        note: row.note || '',
        created_at: row.created_at,
      };
    });
  }

  return {
    inboxDir,
    tradeKey,
    listTrades,
    getTrade,
    createTrade,
    updateTrade,
    confirmTrade,
    cancelTrade,
    getPortfolio,
    getOverview,
    rebuildAllocations,
    listInbox,
    getInboxItem,
    getInboxByHash,
    addInbox,
    updateInbox,
    applyInbox,
    findMatchingTrade,
    ignoreInbox,
    getInboxFilePath,
    saveInboxImage,
    pruneScreenshots,
    migrateLegacyHoldings,
    getAudits,
    getMeta,
    setMeta,
    setDataTrustStore,
  };
}

module.exports = {
  MIGRATION_KEY,
  TRADE_SCHEMA,
  createTradeStore,
  mapInbox,
  mapTrade,
  tradeKey,
};
