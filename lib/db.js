'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  loadProductsFromCsv,
  normalizeAllocationSettings,
} = require('./products');
const { createReviewStore } = require('./review-store');
const { createTradeStore } = require('./trade-store');
const { createAutomationStore } = require('./automation-store');
const {
  createDecisionProposalStore,
} = require('./decision-proposal-store');
const { createIncomeStore } = require('./income-store');
const { createInboxCenter } = require('./inbox-center');
const {
  createProductValuationStore,
} = require('./product-valuation-store');

const DAILY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS daily_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_date TEXT NOT NULL UNIQUE,
    principal REAL NOT NULL CHECK (principal > 0),
    daily_pnl REAL NOT NULL,
    action TEXT NOT NULL DEFAULT '无操作',
    notes TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    screenshot_id INTEGER,
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
    short_name TEXT NOT NULL DEFAULT '',
    issuer TEXT NOT NULL DEFAULT '',
    risk_level TEXT NOT NULL DEFAULT '',
    currency_code TEXT NOT NULL DEFAULT '',
    pub_prv TEXT NOT NULL DEFAULT '',
    soc_tag TEXT NOT NULL DEFAULT '',
    product_type TEXT NOT NULL DEFAULT '',
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
    capacity REAL,
    history_months REAL,
    fee_bps REAL,
    next_open_date TEXT NOT NULL DEFAULT ''
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
    source: row.source || 'manual',
    screenshot_id:
      row.screenshot_id === null || row.screenshot_id === undefined
        ? null
        : Number(row.screenshot_id),
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
        source TEXT NOT NULL DEFAULT 'manual',
        screenshot_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO daily_records_cash_removal (
        id, record_date, principal, daily_pnl, action, notes, source, screenshot_id,
        created_at, updated_at
      )
      SELECT id, record_date, principal, daily_pnl, action, notes, 'manual', NULL,
        created_at, updated_at
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

function ensureDailyRecordColumns(db) {
  const columns = new Set(
    db.prepare('PRAGMA table_info(daily_records)').all().map((column) => column.name),
  );
  if (!columns.has('source')) {
    db.exec("ALTER TABLE daily_records ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  }
  if (!columns.has('screenshot_id')) {
    db.exec('ALTER TABLE daily_records ADD COLUMN screenshot_id INTEGER');
  }
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
    short_name: row.short_name || '',
    issuer: row.issuer,
    risk_level: row.risk_level,
    currency_code: row.currency_code || '',
    pub_prv: row.pub_prv || '',
    soc_tag: row.soc_tag || '',
    product_type: row.product_type || '',
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
    history_months:
      row.history_months === null || row.history_months === undefined
        ? null
        : Number(row.history_months),
    fee_bps:
      row.fee_bps === null || row.fee_bps === undefined
        ? null
        : Number(row.fee_bps),
    next_open_date: row.next_open_date || '',
  };
}

function mapTradeToHolding(trade) {
  if (!trade) return null;
  return {
    id: trade.id,
    product_name: trade.product_name,
    product_code: trade.product_code,
    issuer: trade.issuer,
    risk_level: trade.risk_level,
    amount: trade.amount,
    purchase_date: trade.confirm_date || trade.trade_date,
    term_days: trade.term_days,
    maturity_date: trade.maturity_date,
    notes: trade.notes,
    created_at: trade.created_at,
    updated_at: trade.updated_at,
  };
}

function ensureProductColumns(db) {
  const columns = new Set(
    db.prepare('PRAGMA table_info(products)').all().map((column) => column.name),
  );
  const additions = [
    ['short_name', "TEXT NOT NULL DEFAULT ''"],
    ['currency_code', "TEXT NOT NULL DEFAULT ''"],
    ['pub_prv', "TEXT NOT NULL DEFAULT ''"],
    ['soc_tag', "TEXT NOT NULL DEFAULT ''"],
    ['product_type', "TEXT NOT NULL DEFAULT ''"],
    ['history_months', 'REAL'],
    ['fee_bps', 'REAL'],
    ['next_open_date', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE products ADD COLUMN ${name} ${definition}`);
    }
  }
}

function productSnapshotFingerprint(csvPath, rowCount) {
  if (!csvPath || !fs.existsSync(csvPath)) return '';
  const stat = fs.statSync(csvPath);
  return `${path.basename(csvPath)}:${stat.size}:${Math.round(stat.mtimeMs)}:${rowCount}`;
}

function readAppMeta(db, key) {
  try {
    return db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value || '';
  } catch {
    return '';
  }
}

function writeAppMeta(db, key, value) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO app_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now);
}

function insertProducts(db, products) {
  const statement = db.prepare(`
    INSERT OR IGNORE INTO products (
      name, code, short_name, issuer, risk_level, currency_code, pub_prv, soc_tag,
      product_type, term_days, score, min_amount, annualized_yield, benchmark,
      return_1m, return_3m, return_6m, return_1y, return_since_inception,
      status, source, data_date, notes, capacity, history_months, fee_bps,
      next_open_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const product of products) {
    statement.run(
      product.name,
      product.code,
      product.short_name,
      product.issuer,
      product.risk_level,
      product.currency_code,
      product.pub_prv,
      product.soc_tag,
      product.product_type,
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
      product.history_months,
      product.fee_bps,
      product.next_open_date,
    );
  }
}

function seedProducts(db, csvPath, logger = console) {
  const count = Number(db.prepare('SELECT COUNT(*) AS count FROM products').get().count);
  if (!csvPath || !fs.existsSync(csvPath)) {
    logger.warn(`产品快照不存在，跳过产品导入：${csvPath || '未配置'}`);
    return count;
  }

  const products = loadProductsFromCsv(csvPath);
  const fingerprint = productSnapshotFingerprint(csvPath, products.length);
  if (count > 0 && readAppMeta(db, 'product_snapshot_fingerprint') === fingerprint) {
    return count;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM products');
    insertProducts(db, products);
    writeAppMeta(db, 'product_snapshot_fingerprint', fingerprint);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  logger.info?.(`产品候选池已导入：${products.length} 只`);
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
    writeAppMeta(
      db,
      'product_snapshot_fingerprint',
      productSnapshotFingerprint(csvPath, products.length),
    );
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
  const reviewStore = createReviewStore(db);
  const tradeStore = createTradeStore(db, {
    inboxDir:
      options.tradeInboxDir || path.join(path.dirname(dbPath), 'trade-inbox'),
    logger: options.logger,
  });
  const productValuationStore = createProductValuationStore(db, { tradeStore });
  const decisionProposalStore = createDecisionProposalStore(db, {
    reviewStore,
    tradeStore,
  });
  const incomeStore = createIncomeStore(db, {
    inboxDir:
      options.incomeInboxDir || path.join(path.dirname(dbPath), 'income-inbox'),
  });
  tradeStore.migrateLegacyHoldings();
  const automationStore = createAutomationStore(db, {
    tradeStore,
    incomeStore,
    reviewStore,
    logger: options.logger,
  });
  migrateRemoveCashBalanceColumn(db);
  ensureDailyRecordColumns(db);
  migrateLegacyCapital(db);
  ensureProductColumns(db);
  seedProducts(db, options.productCsvPath, options.logger);
  const inboxCenter = createInboxCenter(db);

  const selectRecords = db.prepare(`
    SELECT * FROM daily_records
    ORDER BY record_date ASC
  `);
  const selectRecord = db.prepare('SELECT * FROM daily_records WHERE record_date = ?');
  const insertRecord = db.prepare(`
    INSERT INTO daily_records (
      record_date, principal, daily_pnl, action, notes, source, screenshot_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  function getAllocationSettings() {
    const raw = readAppMeta(db, 'product_allocation_settings_v1');
    let stored = {};
    if (raw) {
      try {
        stored = JSON.parse(raw);
      } catch {
        stored = {};
      }
    }
    const normalized = normalizeAllocationSettings(stored, reviewStore.listDecisions());
    return {
      ...normalized,
      quota_by_code: normalized.quota_by_code || {},
      updated_at: stored.updated_at || null,
    };
  }

  function saveAllocationSettings(patch = {}) {
    const current = getAllocationSettings();
    const quota =
      patch.quota_by_code && typeof patch.quota_by_code === 'object'
        ? {
            ...current.quota_by_code,
            ...patch.quota_by_code,
          }
        : current.quota_by_code;
    const next = normalizeAllocationSettings({
      ...current,
      ...patch,
      bucket_targets: {
        ...current.bucket_targets,
        ...(patch.bucket_targets || {}),
      },
      quota_by_code: quota,
    });
    next.quota_by_code = Object.fromEntries(
      Object.entries(next.quota_by_code).filter(([, value]) => {
        return (
          value &&
          (value.available !== null ||
            value.max_order !== null ||
            value.window ||
            value.verified_at)
        );
      }),
    );
    const stamp = new Date().toISOString();
    writeAppMeta(
      db,
      'product_allocation_settings_v1',
      JSON.stringify({ ...next, updated_at: stamp }),
    );
    return { ...next, updated_at: stamp };
  }

  return {
    ...reviewStore,
    tradeStore,
    productValuationStore,
    decisionProposalStore,
    incomeStore,
    automationStore,
    inboxCenter,
    db,
    dbPath,
    tradeInboxDir: tradeStore.inboxDir,
    incomeInboxDir: incomeStore.inboxDir,
    productCsvPath: options.productCsvPath || null,
    backupDir: path.join(path.dirname(dbPath), 'backups'),
    listHoldings() {
      return tradeStore.getPortfolio();
    },
    createHolding(holding) {
      const trade = tradeStore.createTrade(
        {
          trade_date: holding.purchase_date,
          confirm_date: holding.purchase_date,
          trade_type: 'buy',
          status: 'confirmed',
          product_code: holding.product_code || holding.product_name,
          product_name: holding.product_name,
          issuer: holding.issuer,
          risk_level: holding.risk_level,
          amount: holding.amount,
          term_days: holding.term_days,
          maturity_date: holding.maturity_date,
          source: 'holding-api',
          notes: holding.notes,
        },
        '通过持仓兼容接口创建',
      );
      return mapTradeToHolding(trade);
    },
    updateHolding(id, holding) {
      const trade = tradeStore.updateTrade(id, {
        trade_date: holding.purchase_date,
        trade_type: 'buy',
        product_code: holding.product_code || holding.product_name,
        product_name: holding.product_name,
        issuer: holding.issuer,
        risk_level: holding.risk_level,
        amount: holding.amount,
        term_days: holding.term_days,
        maturity_date: holding.maturity_date,
        notes: holding.notes,
      });
      return trade ? mapTradeToHolding(trade) : null;
    },
    deleteHolding(id) {
      return Boolean(tradeStore.cancelTrade(id, '通过持仓兼容接口撤销'));
    },
    getReviewWorkspace(args = {}) {
      const trades = args.trades || tradeStore.getOverview(args.today);
      return reviewStore.getReviewWorkspace({
        ...args,
        holdings: trades.holdings,
        trades,
      });
    },
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
        record.source || 'manual',
        record.screenshot_id ?? null,
        stamp,
        stamp,
      );
      return {
        ...record,
        principal,
        id: Number(result.lastInsertRowid),
        source: record.source || 'manual',
        screenshot_id: record.screenshot_id ?? null,
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
    listIncomeScreenshots() {
      return incomeStore.listInbox();
    },
    getIncomeScreenshot(id) {
      return incomeStore.getInboxItem(id);
    },
    applyIncomeScreenshot(id, overrides = {}) {
      const before = incomeStore.getInboxItem(id);
      if (!before) return null;
      if (before.status === 'applied' && before.record_date) {
        return {
          inbox: before,
          record: getRecord(before.record_date),
          duplicate: true,
          saved_valuations: [],
          valuation_conflicts: [],
          missing_product_codes: before.parsed?.missing_product_codes || [],
          reconciliation: productValuationStore.getReconciliationForDate(
            before.record_date,
          ),
        };
      }
      const parsed = { ...before.parsed, ...overrides };
      const date = String(parsed.date || before.record_date || '');
      const dailyPnl = Number(parsed.daily_pnl);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error('收益截图日期格式应为 YYYY-MM-DD');
      }
      if (!Number.isFinite(dailyPnl)) {
        throw new Error('收益截图缺少有效收益数字');
      }
      const principal = principalForDate(date);
      if (principal <= 0) throw new Error('该日期本金为 0，无法记录收益');
      const holdings = tradeStore.getPortfolio();
      const holdingByCode = new Map(
        holdings.map((holding) => [
          String(holding.product_code || '').toUpperCase(),
          holding,
        ]),
      );
      const productInputs = Array.isArray(parsed.products)
        ? parsed.products.map((item) => {
            const code = String(item.product_code || '').trim().toUpperCase();
            return {
              ...item,
              product_code: code,
              product_name:
                item.product_name ||
                holdingByCode.get(code)?.product_name ||
                '',
              valuation_date: item.valuation_date || date,
              yield_date: item.yield_date || date,
              source: 'income-screenshot',
              screenshot_id: id,
              confidence:
                item.confidence ?? parsed.confidence ?? before.parse_confidence,
            };
          })
        : [];
      const savableProductInputs = productInputs.filter(
        (item) =>
          item.product_code &&
          item.daily_pnl !== null &&
          item.daily_pnl !== undefined &&
          Number.isFinite(Number(item.daily_pnl)),
      );
      const savedValuations = productValuationStore.upsertMany(savableProductInputs, {
        source: 'income-screenshot',
        screenshotId: id,
        confidence: parsed.confidence ?? before.parse_confidence,
        preserveManual: true,
        auditNote: `收益截图 #${id} 入账`,
      });
      const capturedCodes = new Set(
        productInputs.map((item) => item.product_code).filter(Boolean),
      );
      const missingProductCodes = holdings
        .map((holding) => String(holding.product_code || '').toUpperCase())
        .filter((code) => code && !capturedCodes.has(code));
      const parsedWithProducts = {
        ...parsed,
        products: productInputs,
        missing_product_codes: missingProductCodes,
      };
      const existing = selectRecord.get(date);
      if (existing) {
        const sameValue = Math.abs(Number(existing.daily_pnl) - dailyPnl) < 0.005;
        const canOverwrite = existing.source === 'income-screenshot';
        if (canOverwrite) {
          const stamp = new Date().toISOString();
          updateRecord.run(
            principal,
            dailyPnl,
            parsed.action || existing.action || '无操作',
            parsed.notes || existing.notes || '',
            stamp,
            date,
          );
        }
        const reconciliation =
          productValuationStore.getReconciliationForDate(date);
        const warnings = [
          ...(parsedWithProducts.warnings || []),
          ...(missingProductCodes.length
            ? [`本次未拍到：${missingProductCodes.join('、')}`]
            : []),
          ...(reconciliation?.status === 'mismatch'
            ? [reconciliation.message]
            : []),
        ];
        const inbox = incomeStore.updateInbox(id, {
          parsed: {
            ...parsedWithProducts,
            reconciliation,
            warnings: [...new Set(warnings)],
          },
          parse_confidence:
            parsed.confidence ?? before.parse_confidence,
          record_date: date,
          status: 'applied',
          applied_at: new Date().toISOString(),
          error: sameValue
            ? ''
            : canOverwrite
              ? ''
            : '该日期已有手工收益记录，平台未覆盖；请核对截图与手工记录。',
        });
        return {
          inbox,
          record: mapRecord(selectRecord.get(date)),
          duplicate: true,
          matched_existing: true,
          overwritten: canOverwrite && !sameValue,
          saved_valuations: savedValuations.saved,
          valuation_conflicts: savedValuations.conflicts,
          missing_product_codes: missingProductCodes,
          reconciliation,
        };
      }
      const stamp = new Date().toISOString();
      const result = insertRecord.run(
        date,
        principal,
        dailyPnl,
        parsed.action || '无操作',
        parsed.notes || '由收益截图自动入账',
        'income-screenshot',
        id,
        stamp,
        stamp,
      );
      const reconciliation =
        productValuationStore.getReconciliationForDate(date);
      const warnings = [
        ...(parsedWithProducts.warnings || []),
        ...(missingProductCodes.length
          ? [`本次未拍到：${missingProductCodes.join('、')}`]
          : []),
        ...(reconciliation?.status === 'mismatch'
          ? [reconciliation.message]
          : []),
      ];
      const inbox = incomeStore.updateInbox(id, {
        parsed: {
          ...parsedWithProducts,
          reconciliation,
          warnings: [...new Set(warnings)],
        },
        parse_confidence: parsed.confidence ?? before.parse_confidence,
        record_date: date,
        status: 'applied',
        applied_at: stamp,
        error: '',
      });
      return {
        inbox,
        record: mapRecord(selectRecord.get(date)) || {
          ...parsed,
          id: Number(result.lastInsertRowid),
          date,
          principal,
          source: 'income-screenshot',
          screenshot_id: id,
          created_at: stamp,
          updated_at: stamp,
        },
        duplicate: false,
        matched_existing: false,
        overwritten: false,
        saved_valuations: savedValuations.saved,
        valuation_conflicts: savedValuations.conflicts,
        missing_product_codes: missingProductCodes,
        reconciliation,
      };
    },
    listProducts() {
      return selectProducts.all().map(mapProduct);
    },
    refreshProducts(csvPath = options.productCsvPath) {
      const nextPath = csvPath || options.productCsvPath;
      const refreshed = replaceProducts(db, nextPath, options.logger);
      options.productCsvPath = nextPath;
      this.productCsvPath = nextPath;
      return refreshed;
    },
    getCapitalState,
    getAllocationSettings,
    saveAllocationSettings,
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
