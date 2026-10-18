'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { loadProductsFromCsv } = require('./products');

const DAILY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS daily_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_date TEXT NOT NULL UNIQUE,
    principal REAL NOT NULL CHECK (principal > 0),
    daily_pnl REAL NOT NULL,
    action TEXT NOT NULL DEFAULT '无操作',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_daily_records_date
    ON daily_records(record_date DESC);

  CREATE TABLE IF NOT EXISTS capital_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    initial_principal REAL NOT NULL CHECK (initial_principal > 0),
    initial_date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS capital_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_date TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('deposit', 'withdraw')),
    amount REAL NOT NULL CHECK (amount > 0),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_capital_events_date
    ON capital_events(event_date ASC, id ASC);

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    issuer TEXT NOT NULL DEFAULT '',
    risk_level TEXT NOT NULL DEFAULT '',
    term_days INTEGER,
    score REAL,
    min_amount REAL,
    annualized_yield REAL,
    benchmark TEXT NOT NULL DEFAULT '',
    return_1m REAL,
    return_3m REAL,
    return_6m REAL,
    return_1y REAL,
    return_since_inception REAL,
    status TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    data_date TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    capacity REAL
  );
`;

function mapRecord(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    date: row.record_date,
    principal: Number(row.principal),
    daily_pnl: Number(row.daily_pnl),
    action: row.action,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function migrateRemoveCashBalanceColumn(db) {
  const columns = db.prepare('PRAGMA table_info(daily_records)').all();
  if (!columns.some((column) => column.name === 'cash_balance')) return false;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      DROP TABLE IF EXISTS daily_records_cash_removal;
      CREATE TABLE daily_records_cash_removal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_date TEXT NOT NULL UNIQUE,
        principal REAL NOT NULL CHECK (principal > 0),
        daily_pnl REAL NOT NULL,
        action TEXT NOT NULL DEFAULT '无操作',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO daily_records_cash_removal (
        id, record_date, principal, daily_pnl, action, notes, created_at, updated_at
      )
      SELECT id, record_date, principal, daily_pnl, action, notes, created_at, updated_at
      FROM daily_records;
      DROP TABLE daily_records;
      ALTER TABLE daily_records_cash_removal RENAME TO daily_records;
      CREATE INDEX IF NOT EXISTS idx_daily_records_date
        ON daily_records(record_date DESC);
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function mapCapitalSettings(row) {
  if (!row) return null;
  return {
    initial_principal: Number(row.initial_principal),
    initial_date: row.initial_date,
    note: row.note || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapCapitalEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    date: row.event_date,
    type: row.event_type,
    amount: Number(row.amount),
    note: row.note || '',
    created_at: row.created_at,
  };
}

function principalAt(settings, events, date) {
  if (!settings || !date || date < settings.initial_date) return null;
  let principal = Number(settings.initial_principal);
  for (const event of events) {
    if (event.date > date) break;
    principal += event.type === 'deposit' ? event.amount : -event.amount;
  }
  return roundMoney(principal);
}

function migrateLegacyCapital(db) {
  const existing = db.prepare('SELECT * FROM capital_settings WHERE id = 1').get();
  if (existing) return mapCapitalSettings(existing);

  const records = db
    .prepare('SELECT record_date, principal FROM daily_records ORDER BY record_date ASC')
    .all();
  if (!records.length) return null;

  const stamp = new Date().toISOString();
  const first = records[0];
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO capital_settings (
        id, initial_principal, initial_date, note, created_at, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?)
    `).run(
      Number(first.principal),
      first.record_date,
      '已根据最早一条历史记录自动初始化',
      stamp,
      stamp,
    );

    let current = Number(first.principal);
    for (const record of records.slice(1)) {
      const next = Number(record.principal);
      const difference = roundMoney(next - current);
      if (Math.abs(difference) < 0.005) continue;
      db.prepare(`
        INSERT INTO capital_events (
          event_date, event_type, amount, note, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        record.record_date,
        difference > 0 ? 'deposit' : 'withdraw',
        Math.abs(difference),
        '由历史本金变化自动迁移',
        stamp,
      );
      current = next;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return mapCapitalSettings(db.prepare('SELECT * FROM capital_settings WHERE id = 1').get());
}

function recalculateRecordPrincipals(db, updateStatement, settings, events) {
  const rows = db
    .prepare('SELECT record_date FROM daily_records ORDER BY record_date ASC')
    .all();
  const updates = [];
  for (const row of rows) {
    const principal = principalAt(settings, events, row.record_date);
    if (principal === null) {
      throw new Error(`记录 ${row.record_date} 早于本金账户起始日期`);
    }
    if (principal <= 0) {
      throw new Error(`记录 ${row.record_date} 对应的本金为 0，无法继续调整本金`);
    }
    updates.push([principal, row.record_date]);
  }
  for (const [principal, date] of updates) {
    updateStatement.run(principal, date);
  }
  return updates.length;
}

function mapProduct(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    code: row.code,
    issuer: row.issuer,
    risk_level: row.risk_level,
    term_days: row.term_days === null ? null : Number(row.term_days),
    score: row.score === null ? null : Number(row.score),
    min_amount: row.min_amount === null ? null : Number(row.min_amount),
    annualized_yield:
      row.annualized_yield === null ? null : Number(row.annualized_yield),
    benchmark: row.benchmark,
    return_1m: row.return_1m === null ? null : Number(row.return_1m),
    return_3m: row.return_3m === null ? null : Number(row.return_3m),
    return_6m: row.return_6m === null ? null : Number(row.return_6m),
    return_1y: row.return_1y === null ? null : Number(row.return_1y),
    return_since_inception:
      row.return_since_inception === null ? null : Number(row.return_since_inception),
    status: row.status,
    source: row.source,
    data_date: row.data_date,
    notes: row.notes,
    capacity: row.capacity === null ? null : Number(row.capacity),
  };
}

function insertProducts(db, products) {
  const statement = db.prepare(`
    INSERT OR IGNORE INTO products (
      name, code, issuer, risk_level, term_days, score, min_amount, annualized_yield,
      benchmark, return_1m, return_3m, return_6m, return_1y, return_since_inception,
      status, source, data_date, notes, capacity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const product of products) {
    statement.run(
      product.name,
      product.code,
      product.issuer,
      product.risk_level,
      product.term_days,
      product.score,
      product.min_amount,
      product.annualized_yield,
      product.benchmark,
      product.return_1m,
      product.return_3m,
      product.return_6m,
      product.return_1y,
      product.return_since_inception,
      product.status,
      product.source,
      product.data_date,
      product.notes,
      product.capacity,
    );
  }
}

function seedProducts(db, csvPath, logger = console) {
  const count = Number(db.prepare('SELECT COUNT(*) AS count FROM products').get().count);
  if (count > 0) return count;
  if (!csvPath || !fs.existsSync(csvPath)) {
    logger.warn(`产品快照不存在，跳过产品导入：${csvPath || '未配置'}`);
    return 0;
  }

  const products = loadProductsFromCsv(csvPath);
  db.exec('BEGIN IMMEDIATE');
  try {
    insertProducts(db, products);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return products.length;
}

function replaceProducts(db, csvPath, logger = console) {
  if (!csvPath || !fs.existsSync(csvPath)) {
    throw new Error('产品快照文件不存在');
  }
  const products = loadProductsFromCsv(csvPath);
  if (!products.length) {
    throw new Error('产品快照没有有效数据');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM products');
    insertProducts(db, products);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  logger.info?.(`产品快照已刷新：${products.length} 只`);
  return products.length;
}

function openDatabase(options = {}) {
  const dbPath = path.resolve(options.dbPath || path.join(process.cwd(), 'data', 'r2_ledger.sqlite'));
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  db.exec(DAILY_SCHEMA);
  migrateRemoveCashBalanceColumn(db);
  migrateLegacyCapital(db);
  seedProducts(db, options.productCsvPath, options.logger);

  const selectRecords = db.prepare(`
    SELECT * FROM daily_records
    ORDER BY record_date ASC
  `);
  const selectRecord = db.prepare('SELECT * FROM daily_records WHERE record_date = ?');
  const insertRecord = db.prepare(`
    INSERT INTO daily_records (
      record_date, principal, daily_pnl, action, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateRecord = db.prepare(`
    UPDATE daily_records
    SET principal = ?, daily_pnl = ?, action = ?, notes = ?, updated_at = ?
    WHERE record_date = ?
  `);
  const updateRecordPrincipal = db.prepare(
    'UPDATE daily_records SET principal = ? WHERE record_date = ?',
  );
  const deleteRecord = db.prepare('DELETE FROM daily_records WHERE record_date = ?');
  const selectProducts = db.prepare('SELECT * FROM products ORDER BY term_days ASC, name ASC');
  const selectCapitalSettings = db.prepare('SELECT * FROM capital_settings WHERE id = 1');
  const selectCapitalEvents = db.prepare(`
    SELECT * FROM capital_events ORDER BY event_date ASC, id ASC
  `);
  const selectCapitalEvent = db.prepare('SELECT * FROM capital_events WHERE id = ?');
  const insertCapitalSettings = db.prepare(`
    INSERT INTO capital_settings (
      id, initial_principal, initial_date, note, created_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?)
  `);
  const updateCapitalSettings = db.prepare(`
    UPDATE capital_settings
    SET initial_principal = ?, initial_date = ?, updated_at = ?
    WHERE id = 1
  `);
  const insertCapitalEvent = db.prepare(`
    INSERT INTO capital_events (
      event_date, event_type, amount, note, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const deleteCapitalEventStatement = db.prepare('DELETE FROM capital_events WHERE id = ?');

  const getSettings = () => mapCapitalSettings(selectCapitalSettings.get());
  const getEvents = (settings = getSettings()) => {
    if (!settings) return [];
    let running = settings.initial_principal;
    return selectCapitalEvents.all().map((row) => {
      const event = mapCapitalEvent(row);
      running += event.type === 'deposit' ? event.amount : -event.amount;
      return { ...event, principal_after: roundMoney(running) };
    });
  };
  const principalForDate = (date) => {
    const settings = getSettings();
    if (!settings) throw new Error('尚未初始化本金账户');
    const principal = principalAt(settings, getEvents(settings), date);
    if (principal === null) throw new Error('该日期早于本金账户起始日期');
    return principal;
  };

  function getCapitalState(today = new Date().toISOString().slice(0, 10)) {
    const settings = getSettings();
    if (!settings) {
      return {
        initialized: false,
        as_of: today,
        initial_principal: null,
        initial_date: null,
        current_principal: 0,
        total_deposits: 0,
        total_withdrawals: 0,
        note: '',
        events: [],
      };
    }
    const events = getEvents(settings);
    const totalDeposits = events
      .filter((event) => event.type === 'deposit')
      .reduce((sum, event) => sum + event.amount, 0);
    const totalWithdrawals = events
      .filter((event) => event.type === 'withdraw')
      .reduce((sum, event) => sum + event.amount, 0);
    return {
      initialized: true,
      as_of: today,
      initial_principal: settings.initial_principal,
      initial_date: settings.initial_date,
      current_principal: principalAt(settings, events, today),
      total_deposits: roundMoney(totalDeposits),
      total_withdrawals: roundMoney(totalWithdrawals),
      note: settings.note,
      events,
    };
  }

  return {
    dbPath,
    listRecords() {
      return selectRecords.all().map(mapRecord);
    },
    getRecord(date) {
      return mapRecord(selectRecord.get(date));
    },
    createRecord(record) {
      const principal = principalForDate(record.date);
      if (principal <= 0) throw new Error('该日期本金为 0，无法记录收益');
      const stamp = new Date().toISOString();
      const result = insertRecord.run(
        record.date,
        principal,
        record.daily_pnl,
        record.action,
        record.notes,
        stamp,
        stamp,
      );
      return {
        ...record,
        principal,
        id: Number(result.lastInsertRowid),
        created_at: stamp,
        updated_at: stamp,
      };
    },
    updateRecord(date, record) {
      const principal = principalForDate(date);
      if (principal <= 0) throw new Error('该日期本金为 0，无法记录收益');
      const stamp = new Date().toISOString();
      const result = updateRecord.run(
        principal,
        record.daily_pnl,
        record.action,
        record.notes,
        stamp,
        date,
      );
      if (Number(result.changes) === 0) return null;
      return mapRecord(selectRecord.get(date));
    },
    deleteRecord(date) {
      const result = deleteRecord.run(date);
      return Number(result.changes) > 0;
    },
    listProducts() {
      return selectProducts.all().map(mapProduct);
    },
    refreshProducts() {
      return replaceProducts(db, options.productCsvPath, options.logger);
    },
    getCapitalState,
    getPrincipalForDate(date) {
      return principalForDate(date);
    },
    initializeCapital(initialPrincipal, initialDate, note = '') {
      if (getSettings()) throw new Error('本金账户已经初始化');
      const records = selectRecords.all();
      if (records.some((record) => record.record_date < initialDate)) {
        throw new Error('起始日期不能晚于已有收益记录');
      }
      const stamp = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        insertCapitalSettings.run(initialPrincipal, initialDate, note, stamp, stamp);
        const settings = getSettings();
        recalculateRecordPrincipals(db, updateRecordPrincipal, settings, []);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return getCapitalState();
    },
    updateCapitalInitial(initialPrincipal, initialDate) {
      const settings = getSettings();
      if (!settings) throw new Error('本金账户尚未初始化');
      const events = getEvents(settings);
      if (events.some((event) => event.date < initialDate)) {
        throw new Error('起始日期不能晚于已有转入/转出记录');
      }
      const stamp = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        updateCapitalSettings.run(initialPrincipal, initialDate, stamp);
        const nextSettings = getSettings();
        recalculateRecordPrincipals(db, updateRecordPrincipal, nextSettings, events);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return getCapitalState();
    },
    createCapitalEvent(event) {
      const settings = getSettings();
      if (!settings) throw new Error('请先初始化本金账户');
      const events = getEvents(settings);
      if (event.date < settings.initial_date) {
        throw new Error('转入/转出日期不能早于本金账户起始日期');
      }
      const before = principalAt(settings, events, event.date);
      if (before === null) throw new Error('转入/转出日期无效');
      if (event.type === 'withdraw' && before + 0.005 < event.amount) {
        throw new Error(`可转出本金不足，该日可用于转出的本金为 ¥${before.toFixed(2)}`);
      }
      const stamp = new Date().toISOString();
      let newId;
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = insertCapitalEvent.run(
          event.date,
          event.type,
          event.amount,
          event.note,
          stamp,
        );
        newId = Number(result.lastInsertRowid);
        const nextEvents = [
          ...events,
          {
            id: newId,
            date: event.date,
            type: event.type,
            amount: event.amount,
            note: event.note,
          },
        ].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
        recalculateRecordPrincipals(db, updateRecordPrincipal, settings, nextEvents);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { ...event, id: newId };
    },
    deleteCapitalEvent(id) {
      const event = selectCapitalEvent.get(id);
      if (!event) return false;
      const settings = getSettings();
      db.exec('BEGIN IMMEDIATE');
      try {
        deleteCapitalEventStatement.run(id);
        const events = getEvents(settings);
        recalculateRecordPrincipals(db, updateRecordPrincipal, settings, events);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return true;
    },
    close() {
      db.close();
    },
  };
}

module.exports = {
  mapProduct,
  mapRecord,
  migrateLegacyCapital,
  migrateRemoveCashBalanceColumn,
  openDatabase,
  principalAt,
  replaceProducts,
  seedProducts,
};
