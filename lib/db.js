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
const {
  createHoldingValuationStore,
} = require('./holding-valuation-store');
const { createTransactionManager } = require('./transaction');
const {
  ensureDataTrustReady,
} = require('./data-trust-migration');
const { createDataTrustStore } = require('./data-trust-store');

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
  const transactionManager = createTransactionManager(db);
  db.exec(DAILY_SCHEMA);
  const reviewStore = createReviewStore(db, { transactionManager });
  const tradeStore = createTradeStore(db, {
    inboxDir:
      options.tradeInboxDir || path.join(path.dirname(dbPath), 'trade-inbox'),
    transactionManager,
    logger: options.logger,
  });
  const holdingValuationStore = createHoldingValuationStore(db, {
    tradeStore,
    transactionManager,
    evidenceDir:
      options.holdingValuationEvidenceDir ||
      path.join(path.dirname(dbPath), 'holding-valuation-evidence'),
  });
  const productValuationStore = createProductValuationStore(db, {
    tradeStore,
    transactionManager,
  });
  const decisionProposalStore = createDecisionProposalStore(db, {
    reviewStore,
    tradeStore,
    transactionManager,
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
    decisionProposalStore,
    productValuationStore,
    logger: options.logger,
  });
  migrateRemoveCashBalanceColumn(db);
  ensureDailyRecordColumns(db);
  migrateLegacyCapital(db);
  ensureProductColumns(db);
  seedProducts(db, options.productCsvPath, options.logger);
  const inboxCenter = createInboxCenter(db);
  const dataTrustMigration = ensureDataTrustReady(db, {
    dbPath,
    migrationPolicy: options.migrationPolicy || 'auto',
    tradeInboxDir: tradeStore.inboxDir,
    incomeInboxDir: incomeStore.inboxDir,
    logger: options.logger,
  });
  const dataTrustStore =
    options.migrationPolicy === 'defer' && !dataTrustMigration.schema.complete
      ? null
      : createDataTrustStore(db, {
          transactionManager,
          mode:
            options.dataTrustMode ||
            process.env.R2_DATA_TRUST_MODE ||
            'shadow',
        });
  holdingValuationStore.ensureMigrationRecord();
  holdingValuationStore.setDataTrustStore(dataTrustStore);
  holdingValuationStore.setProductValuationStore(productValuationStore);
  tradeStore.setDataTrustStore(dataTrustStore);
  productValuationStore.setDataTrustStore(dataTrustStore);
  reviewStore.setDataTrustStore(dataTrustStore);

  function flagIncomeRecordConflict({
    date,
    existing,
    incoming,
    source = 'manual',
  }) {
    const existingValue = Math.round(Number(existing.daily_pnl) * 100);
    const incomingValue = Math.round(Number(incoming) * 100);
    return automationStore.saveNotification({
      dedupe_key: `income-record-conflict:${date}:${existingValue}:${incomingValue}:${source}`,
      kind: 'agent_confirmation',
      level: 'warn',
      title: `${date} 收益金额不一致`,
      message: `已有收益 ¥${(existingValue / 100).toFixed(2)}，本次提供 ¥${(
        incomingValue / 100
      ).toFixed(2)}。平台未覆盖原记录，请人工核对来源后修改。`,
      data: {
        category: 'action',
        severity: 'warn',
        action_label: '人工核对收益',
        action_url: '/ledger/daily#recordForm',
        source,
        date,
        existing_daily_pnl: existingValue / 100,
        incoming_daily_pnl: incomingValue / 100,
      },
    });
  }

  function flagProductIncomeConflict({
    date,
    productCode,
    existing,
    incoming,
    source = 'manual',
  }) {
    const code = String(productCode || '').toUpperCase();
    const existingValue = Math.round(Number(existing) * 100);
    const incomingValue = Math.round(Number(incoming) * 100);
    return automationStore.saveNotification({
      dedupe_key: `product-income-conflict:${date}:${code}:${existingValue}:${incomingValue}:${source}`,
      kind: 'agent_confirmation',
      level: 'warn',
      title: `${code} 在 ${date} 的产品收益不一致`,
      message: `已有产品收益 ¥${(existingValue / 100).toFixed(2)}，本次提供 ¥${(
        incomingValue / 100
      ).toFixed(2)}。平台未覆盖原记录，请人工核对后修改。`,
      data: {
        category: 'action',
        severity: 'warn',
        action_label: '人工核对产品收益',
        action_url: '/ledger/trades#valuations',
        source,
        date,
        product_code: code,
        existing_daily_pnl: existingValue / 100,
        incoming_daily_pnl: incomingValue / 100,
      },
    });
  }

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
  const updateDerivedRecord = db.prepare(`
    UPDATE daily_records
    SET principal = ?, daily_pnl = ?, source = 'product-income-summary',
        updated_at = ?
    WHERE record_date = ?
  `);
  const updateRecordPrincipal = db.prepare(
    'UPDATE daily_records SET principal = ? WHERE record_date = ?',
  );
  const deleteRecord = db.prepare('DELETE FROM daily_records WHERE record_date = ?');
  const selectProductIncomeSummary = db.prepare(`
    SELECT
      COUNT(*) AS product_count,
      COALESCE(SUM(CAST(ROUND(daily_pnl * 100) AS INTEGER)), 0) AS total_cents
    FROM product_daily_valuations
    WHERE yield_date = ?
  `);
  const selectProductIncomeDates = db.prepare(`
    SELECT DISTINCT yield_date
    FROM product_daily_valuations
    ORDER BY yield_date ASC
  `);
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
    if (!settings) {
      const error = new Error('尚未初始化本金账户');
      error.code = 'CAPITAL_NOT_INITIALIZED';
      throw error;
    }
    const principal = principalAt(settings, getEvents(settings), date);
    if (principal === null) {
      const error = new Error('该日期早于本金账户起始日期');
      error.code = 'BEFORE_CAPITAL_START';
      throw error;
    }
    return principal;
  };

  function getProductIncomeSummary(date) {
    const row = selectProductIncomeSummary.get(date);
    const productCount = Number(row?.product_count || 0);
    return {
      date,
      product_count: productCount,
      daily_pnl: Number(row?.total_cents || 0) / 100,
      available: productCount > 0,
    };
  }

  function syncAccountRecordFromProducts(date, writeOptions = {}) {
    return transactionManager.run(() => {
      const summary = getProductIncomeSummary(date);
      const before = mapRecord(selectRecord.get(date));
      if (!summary.available) {
        if (before?.source === 'product-income-summary') {
          deleteRecord.run(date);
          if (dataTrustStore?.enabled) {
            const stamp = new Date().toISOString();
            const operationId =
              writeOptions.operationId ||
              `product-project:${date}:${stamp}`;
            dataTrustStore.recordFactRevision({
              factType: 'account_income',
              factKey: `account_income:${before.id}`,
              action: 'delete',
              before,
              after: {},
              reason:
                '产品收益日期迁移后旧日期已无产品，删除派生账户总账',
              sourceClass: 'derived',
              actorType: 'system',
              actorRef: 'product-income-summary',
              operationId: `${operationId}:delete`,
              requestId: writeOptions.requestId || operationId,
              createdAt: stamp,
            });
          }
        }
        return null;
      }
      let principal;
      try {
        principal = principalForDate(date);
      } catch (error) {
        if (
          error.code === 'CAPITAL_NOT_INITIALIZED' ||
          error.code === 'BEFORE_CAPITAL_START'
        ) {
          return null;
        }
        throw error;
      }
      if (principal <= 0) return null;
      const stamp = new Date().toISOString();
      if (before) {
        updateDerivedRecord.run(
          principal,
          summary.daily_pnl,
          stamp,
          date,
        );
      } else {
        insertRecord.run(
          date,
          principal,
          summary.daily_pnl,
          '无操作',
          '由逐产品每日收益汇总生成',
          'product-income-summary',
          null,
          stamp,
          stamp,
        );
      }
      const after = mapRecord(selectRecord.get(date));
      if (
        dataTrustStore?.enabled &&
        (!before ||
          before.daily_pnl !== after.daily_pnl ||
          before.principal !== after.principal ||
          before.source !== after.source)
      ) {
        const operationId =
          writeOptions.operationId ||
          `product-project:${date}:${stamp}`;
        const revision = dataTrustStore.recordFactRevision({
          factType: 'account_income',
          factKey: `account_income:${after.id}`,
          action: before ? 'update' : 'create',
          before: before || {},
          after,
          reason: '按逐产品每日收益汇总重算账户总账',
          sourceClass: 'derived',
          actorType: 'system',
          actorRef: 'product-income-summary',
          operationId,
          requestId: writeOptions.requestId || operationId,
          createdAt: stamp,
        });
        if (revision && writeOptions.screenshotId) {
          dataTrustStore.linkFactToInbox({
            factType: 'account_income',
            factKey: `account_income:${after.id}`,
            revisionId: revision.id,
            inboxKind: 'income',
            inboxId: writeOptions.screenshotId,
            fieldPaths: ['date', 'daily_pnl'],
            confidence: null,
          });
        }
        if (!before || before.principal !== after.principal) {
          dataTrustStore.recordFactRevision({
            factType: 'principal_snapshot',
            factKey: `principal_snapshot:${after.id}`,
            action: before ? 'recalculate' : 'create',
            before: before ? { principal: before.principal } : {},
            after: {
              record_date: after.date,
              principal: after.principal,
            },
            reason: '产品收益汇总投影时重算本金快照',
            sourceClass: 'derived',
            actorType: 'system',
            actorRef: 'product-income-summary',
            operationId: `${operationId}:principal`,
            relatedFactType: 'account_income',
            relatedFactKey: `account_income:${after.id}`,
            createdAt: stamp,
          });
        }
      }
      return after;
    });
  }

  productValuationStore.setAccountIncomeProjector(
    syncAccountRecordFromProducts,
  );

  function syncAllAccountRecordsFromProducts(writeOptions = {}) {
    return selectProductIncomeDates
      .all()
      .map((row) =>
        syncAccountRecordFromProducts(row.yield_date, writeOptions),
      );
  }

  function recordPrincipalChanges({
    beforePrincipals,
    reason,
    operationPrefix,
    relatedFactType,
    relatedFactKey,
    stamp,
  }) {
    if (!dataTrustStore?.enabled) return;
    for (const row of selectRecords.all()) {
      const before = beforePrincipals.get(Number(row.id));
      if (before === Number(row.principal)) continue;
      dataTrustStore.recordFactRevision({
        factType: 'principal_snapshot',
        factKey: `principal_snapshot:${row.id}`,
        action: 'recalculate',
        before:
          before === undefined ? {} : { principal: Number(before) },
        after: {
          record_date: row.record_date,
          principal: Number(row.principal),
        },
        reason,
        sourceClass: 'derived',
        actorType: 'system',
        actorRef: 'capital-service',
        operationId: `${operationPrefix}:${row.id}:${stamp}`,
        relatedFactType,
        relatedFactKey,
        createdAt: stamp,
      });
    }
  }

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
    transactionManager,
    dataTrustStore,
    dataTrustMigration,
    tradeStore,
    holdingValuationStore,
    productValuationStore,
    decisionProposalStore,
    incomeStore,
    automationStore,
    inboxCenter,
    flagIncomeRecordConflict,
    flagProductIncomeConflict,
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
    getProductIncomeSummary,
    syncAccountRecordFromProducts,
    syncAllAccountRecordsFromProducts,
    getRecord(date) {
      return mapRecord(selectRecord.get(date));
    },
    createRecord(record) {
      return transactionManager.run(() => {
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
        const created = mapRecord(selectRecord.get(record.date));
        const revision = dataTrustStore?.enabled
          ? dataTrustStore.recordFactRevision({
              factType: 'account_income',
              factKey: `account_income:${created.id}`,
              action: 'create',
              before: {},
              after: created,
              reason: record.reason || record.notes || '创建账户收益',
              sourceClass:
                record.source === 'income-screenshot'
                  ? 'screenshot'
                  : 'manual',
              actorType: record.actorType || 'human',
              actorRef: record.actorRef || 'ledger-service',
              operationId:
                record.operationId ||
                `account-create:${created.id}:${stamp}`,
              requestId: record.requestId || '',
              createdAt: stamp,
            })
          : null;
        if (revision && created.screenshot_id) {
          dataTrustStore.linkFactToInbox({
            factType: 'account_income',
            factKey: `account_income:${created.id}`,
            revisionId: revision.id,
            inboxKind: 'income',
            inboxId: created.screenshot_id,
            fieldPaths: ['date', 'daily_pnl'],
            confidence: null,
          });
        }
        if (dataTrustStore?.enabled) {
          dataTrustStore.recordFactRevision({
            factType: 'principal_snapshot',
            factKey: `principal_snapshot:${created.id}`,
            action: 'recalculate',
            before: {},
            after: {
              record_date: created.date,
              principal: created.principal,
            },
            reason: '创建收益记录时计算本金快照',
            sourceClass: 'derived',
            actorType: 'system',
            actorRef: 'ledger-service',
            operationId:
              record.principalOperationId ||
              `principal-create:${created.id}:${stamp}`,
            relatedFactType: 'account_income',
            relatedFactKey: `account_income:${created.id}`,
            createdAt: stamp,
          });
        }
        return created;
      });
    },
    updateRecord(date, record) {
      return transactionManager.run(() => {
        const before = mapRecord(selectRecord.get(date));
        if (!before) return null;
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
        const after = mapRecord(selectRecord.get(date));
        if (dataTrustStore?.enabled) {
          dataTrustStore.recordFactRevision({
            factType: 'account_income',
            factKey: `account_income:${after.id}`,
            action: 'update',
            before,
            after,
            reason:
              record.reason ||
              record.correction_note ||
              '更新账户收益',
            sourceClass:
              record.source === 'income-screenshot'
                ? 'screenshot'
                : 'manual',
            actorType: record.actorType || 'human',
            actorRef: record.actorRef || 'ledger-service',
            operationId:
              record.operationId || `account-update:${after.id}:${stamp}`,
            requestId: record.requestId || '',
            createdAt: stamp,
          });
        }
        return after;
      });
    },
    deleteRecord(date) {
      return transactionManager.run(() => {
        const before = mapRecord(selectRecord.get(date));
        if (!before) return false;
        const result = deleteRecord.run(date);
        if (Number(result.changes) === 0) return false;
        if (dataTrustStore?.enabled) {
          const stamp = new Date().toISOString();
          dataTrustStore.recordFactRevision({
            factType: 'account_income',
            factKey: `account_income:${before.id}`,
            action: 'delete',
            before,
            after: { deleted: true },
            reason: '删除账户收益',
            sourceClass: 'manual',
            actorType: 'human',
            actorRef: 'ledger-service',
            operationId: `account-delete:${before.id}:${stamp}`,
            requestId: `account-delete:${before.id}:${stamp}`,
            createdAt: stamp,
          });
        }
        return true;
      });
    },
    listIncomeScreenshots() {
      return incomeStore.listInbox();
    },
    getIncomeScreenshot(id) {
      return incomeStore.getInboxItem(id);
    },
    applyIncomeScreenshot(id, overrides = {}, options = {}) {
      return transactionManager.run(() => {
        const before = incomeStore.getInboxItem(id);
        if (!before) return null;
        const operationId =
          options.operationId ||
          `income-apply:${id}:${before.selected_event_id || 'legacy'}`;
        if (
          dataTrustStore?.enabled &&
          (!before.evidence_id || !before.selected_event_id)
        ) {
          dataTrustStore.registerInboxEvidence('income', id, {
            workflowState: before.workflow_state || 'needs_correction',
            actorType: 'migration',
            actorRef: 'compatibility-backfill',
            requestId: operationId,
            events: [
              {
                event_type: 'legacy_snapshot',
                actor_type: 'migration',
                actor_ref: 'compatibility-backfill',
                payload: {
                  ocr_text: before.ocr_text || '',
                  parsed_json_raw: JSON.stringify(before.parsed || {}),
                  parse_confidence: before.parse_confidence,
                  legacy_status: before.status,
                },
                dedupe_key: `legacy-lazy:${before.sha256}`,
                created_at: before.received_at,
              },
            ],
          });
        }
        if (
          before.status === 'applied' &&
          before.record_date &&
          before.workflow_state === 'posted'
        ) {
          return {
            inbox: before,
            record: mapRecord(selectRecord.get(before.record_date)),
            duplicate: true,
            matched_existing: true,
            ignored: true,
            overwritten: false,
            conflict: null,
            saved_valuations: [],
            valuation_conflicts: [],
            missing_product_codes:
              before.parsed?.missing_product_codes || [],
            reconciliation:
              productValuationStore.getReconciliationForDate(
                before.record_date,
                { today: options.today },
              ),
          };
        }
        const parsed = { ...before.parsed, ...overrides };
        if (
          dataTrustStore?.enabled &&
          options.actorType === 'human' &&
          Object.keys(overrides).length
        ) {
          const correction = dataTrustStore.appendInboxEvent(
            'income',
            id,
            {
              event_type: 'human_corrected',
              actor_type: 'human',
              actor_ref: options.actorRef || 'income-apply',
              payload: {
                before: before.parsed || {},
                after: parsed,
                reason: options.reason || '人工校正收益截图',
              },
              dedupe_key: `human:${operationId}`,
              created_at: new Date().toISOString(),
            },
            { requestId: operationId },
          );
          if (correction) {
            dataTrustStore.selectInboxEvent('income', id, correction);
          }
        }
        const date = String(parsed.date || before.record_date || '');
        const hasAccountPnl =
          parsed.daily_pnl !== null &&
          parsed.daily_pnl !== undefined &&
          parsed.daily_pnl !== '';
        const dailyPnl = hasAccountPnl ? Number(parsed.daily_pnl) : null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          throw new Error('收益截图日期格式应为 YYYY-MM-DD');
        }
        if (hasAccountPnl && !Number.isFinite(dailyPnl)) {
          throw new Error('收益截图中的账户总收益数字无效');
        }
        const holdings = tradeStore.getPortfolio();
        const today =
          String(options.today || '').trim() ||
          new Date().toISOString().slice(0, 10);
        if (date > today) {
          throw new Error('不能记录未来日期的收益');
        }
        const principal = principalForDate(date);
        if (hasAccountPnl && principal <= 0) {
          throw new Error('该日期本金为 0，无法记录收益');
        }
        const holdingByCode = new Map(
          holdings.map((holding) => [
            String(holding.product_code || '').toUpperCase(),
            holding,
          ]),
        );
        const productInputs = Array.isArray(parsed.products)
          ? parsed.products.map((item) => {
              const code = String(item.product_code || '')
                .trim()
                .toUpperCase();
              const yieldDate = String(item.yield_date || date).trim();
              const creditDate = String(item.credit_date || date).trim();
              if (yieldDate > today) {
                throw new Error(
                  `产品 ${code} 的收益归属日不能晚于今天`,
                );
              }
              if (creditDate < yieldDate) {
                throw new Error(
                  `产品 ${code} 的到账/可见日期不能早于收益归属日`,
                );
              }
              return {
                ...item,
                product_code: code,
                product_name:
                  item.product_name ||
                  holdingByCode.get(code)?.product_name ||
                  '',
                valuation_date: date,
                credit_date: creditDate,
                yield_date: yieldDate,
                source: 'income-screenshot',
                screenshot_id: id,
                confidence:
                  item.confidence ??
                  parsed.confidence ??
                  before.parse_confidence,
              };
            })
          : [];
        const capturedCodes = new Set(
          productInputs.map((item) => item.product_code).filter(Boolean),
        );
        const expectedProductCodes =
          productValuationStore.getExpectedProductCodesOnDate(date) ||
          holdings.map((holding) =>
            String(holding.product_code || '').toUpperCase(),
          );
        const missingProductCodes = expectedProductCodes
          .filter((code) => code && !capturedCodes.has(code));
        const parsedWithProducts = {
          ...parsed,
          products: productInputs,
          missing_product_codes: missingProductCodes,
        };
        const existing = selectRecord.get(date);
        const accountMismatch = Boolean(
          hasAccountPnl &&
            missingProductCodes.length === 0 &&
            Math.abs(
              Number(
                productInputs.reduce(
                  (sum, item) => sum + Number(item.daily_pnl || 0),
                  0,
                ),
              ) - dailyPnl,
            ) >= 0.005,
        );
        const productPlans = productInputs
          .filter(
            (item) =>
              item.product_code &&
              item.daily_pnl !== null &&
              item.daily_pnl !== undefined &&
              Number.isFinite(Number(item.daily_pnl)),
          )
          .map((item) => {
            const current = productValuationStore.getValuationByKey(
              item.product_code,
              item.yield_date,
            );
            const conflict =
              current &&
              Math.abs(
                Number(current.daily_pnl) - Number(item.daily_pnl),
              ) > 0.005;
            return {
              item,
              current,
              conflict: Boolean(conflict),
              creates: !current,
            };
          });
        if (productPlans.length === 0) {
          throw new Error(
            '收益截图需要至少一条有效产品收益明细；账户总收益由产品汇总生成',
          );
        }
        const valuationConflicts = productPlans
          .filter((plan) => plan.conflict)
          .map((plan) => ({
            product_code: plan.item.product_code,
            yield_date: plan.item.yield_date,
            reason: 'different-daily-pnl',
            existing: plan.current,
          }));
        const markReady = () => {
          if (!dataTrustStore?.enabled) return;
          let lineage = dataTrustStore.getInboxLineage('income', id);
          if (
            lineage?.inbox?.workflow_state &&
            lineage.inbox.workflow_state !== 'ready_to_post' &&
            lineage.inbox.workflow_state !== 'posted' &&
            lineage.inbox.workflow_state !== 'duplicate_resolved'
          ) {
            dataTrustStore.transitionInbox('income', id, {
              toState: 'ready_to_post',
              actorType: options.actorType || 'human',
              actorRef: options.actorRef || 'income-apply',
              reason: '通过入账预检，进入待入账',
              requestId: operationId,
              dedupeKey: `ready:${operationId}`,
            });
          }
        };
        markReady();
        if (valuationConflicts.length) {
          const reconciliation =
            productValuationStore.getReconciliationForDate(date, { today });
          const warnings = [
            ...(parsedWithProducts.warnings || []),
            ...(missingProductCodes.length
              ? [
                  reconciliation?.status === 'waiting'
                    ? `等待到账：${missingProductCodes.join('、')} 尚未全部披露，最终披露日 ${reconciliation.final_disclosure_date}`
                    : `最终仍缺产品收益：${missingProductCodes.join('、')}`,
                ]
              : []),
            ...([
              'mismatch',
              'missing-product-details',
            ].includes(reconciliation?.status)
              ? [reconciliation.message]
              : []),
          ];
          for (const conflict of valuationConflicts) {
            const incoming = productInputs.find(
              (item) =>
                item.product_code === conflict.product_code &&
                item.yield_date === conflict.yield_date,
            )?.daily_pnl;
            flagProductIncomeConflict({
              date: conflict.yield_date,
              productCode: conflict.product_code,
              existing: conflict.existing?.daily_pnl,
              incoming,
              source: `income-screenshot:${id}`,
            });
          }
          const inbox = incomeStore.updateInbox(id, {
            parsed: {
              ...parsedWithProducts,
              reconciliation,
              warnings: [...new Set(warnings)],
            },
            parse_confidence:
              parsed.confidence ?? before.parse_confidence,
            record_date: date,
            status: 'pending',
            applied_at: null,
            error:
              '截图包含与现有收益不一致的数据，平台未写入，请核对后人工修正。',
          });
          if (dataTrustStore?.enabled) {
            dataTrustStore.transitionInbox('income', id, {
              toState: 'conflict_pending',
              actorType: options.actorType || 'human',
              actorRef: options.actorRef || 'income-apply',
              reason: '预检发现账户或产品收益冲突',
              requestId: operationId,
              details: {
                account_conflict: false,
                valuation_conflicts: valuationConflicts,
              },
              dedupeKey: `conflict:${operationId}`,
            });
          }
          return {
            inbox: incomeStore.getInboxItem(id) || inbox,
            record: mapRecord(existing),
            duplicate: false,
            matched_existing: Boolean(existing),
            ignored: false,
            overwritten: false,
            conflict: null,
            saved_valuations: [],
            valuation_conflicts: valuationConflicts,
            missing_product_codes: missingProductCodes,
            reconciliation,
          };
        }
        const savableProductInputs = productPlans.map((plan) => plan.item);
        const savedValuations = productValuationStore.upsertMany(
          savableProductInputs,
          {
            source: 'income-screenshot',
            screenshotId: id,
            confidence: parsed.confidence ?? before.parse_confidence,
            preserveManual: true,
            auditNote: `收益截图 #${id} 入账`,
            operationId,
            requestId: operationId,
          },
        );
        const stamp = new Date().toISOString();
        const record = mapRecord(selectRecord.get(date));
        const reconciliation =
          productValuationStore.getReconciliationForDate(date, { today });
        const warnings = [
          ...(parsedWithProducts.warnings || []),
          ...(missingProductCodes.length
            ? [
                reconciliation?.status === 'waiting'
                  ? `等待到账：${missingProductCodes.join('、')} 尚未全部披露，最终披露日 ${reconciliation.final_disclosure_date}`
                  : `最终仍缺产品收益：${missingProductCodes.join('、')}`,
              ]
            : []),
          ...([
            'mismatch',
            'missing-product-details',
          ].includes(reconciliation?.status)
            ? [reconciliation.message]
            : []),
          ...(accountMismatch
            ? [
                `截图账户总额 ¥${dailyPnl.toFixed(
                  2,
                )} 与产品汇总 ¥${Number(
                  record?.daily_pnl || 0,
                ).toFixed(2)} 不一致；产品汇总已写入，账户总额仅作核对。`,
              ]
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
        const createdNewFacts =
          productPlans.some((plan) => plan.creates) ||
          !existing;
        if (dataTrustStore?.enabled) {
          dataTrustStore.transitionInbox('income', id, {
            toState: createdNewFacts ? 'posted' : 'duplicate_resolved',
            actorType: options.actorType || 'human',
            actorRef: options.actorRef || 'income-apply',
            reason: createdNewFacts
              ? '收益截图事务入账完成'
              : '事实已存在且金额一致，仅补充证据链接',
            requestId: operationId,
            dedupeKey: `posted:${operationId}`,
          });
          dataTrustStore.appendInboxEvent(
            'income',
            id,
            {
              event_type: 'posted',
              actor_type: options.actorType || 'human',
              actor_ref: options.actorRef || 'income-apply',
              payload: {
                account_record_id: record?.id ?? null,
                product_valuation_ids: savedValuations.saved.map(
                  (item) => item.id,
                ),
                created_new_facts: createdNewFacts,
                duplicate_account_total: Boolean(existing),
              },
              dedupe_key: `posted-fact:${operationId}`,
              created_at: stamp,
            },
            { requestId: operationId },
          );
        }
        return {
          inbox: incomeStore.getInboxItem(id) || inbox,
          record,
          duplicate: Boolean(existing),
          matched_existing: Boolean(existing),
          ignored: !createdNewFacts,
          overwritten: false,
          conflict: null,
          saved_valuations: savedValuations.saved,
          valuation_conflicts: savedValuations.conflicts,
          valuation_notifications: [],
          missing_product_codes: missingProductCodes,
          reconciliation,
        };
      });
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
      return transactionManager.run(() => {
        const beforePrincipals = new Map(
          records.map((row) => [Number(row.id), Number(row.principal)]),
        );
        insertCapitalSettings.run(initialPrincipal, initialDate, note, stamp, stamp);
        const settings = getSettings();
        recalculateRecordPrincipals(db, updateRecordPrincipal, settings, []);
        syncAllAccountRecordsFromProducts({
          operationId: `capital-init-project:${stamp}`,
          requestId: `capital-init-project:${stamp}`,
        });
        if (dataTrustStore?.enabled) {
          dataTrustStore.recordFactRevision({
            factType: 'capital_initial',
            factKey: 'capital_initial:1',
            action: 'create',
            before: {},
            after: settings,
            reason: note || '初始化本金账户',
            sourceClass: 'manual',
            actorType: 'human',
            actorRef: 'capital-service',
            operationId: `capital-init:${stamp}`,
            requestId: `capital-init:${stamp}`,
            createdAt: stamp,
          });
          recordPrincipalChanges({
            beforePrincipals,
            reason: '本金初始化后重算历史本金快照',
            operationPrefix: 'capital-init-principal',
            relatedFactType: 'capital_initial',
            relatedFactKey: 'capital_initial:1',
            stamp,
          });
        }
        return getCapitalState();
      });
    },
    updateCapitalInitial(initialPrincipal, initialDate) {
      const settings = getSettings();
      if (!settings) throw new Error('本金账户尚未初始化');
      const events = getEvents(settings);
      if (events.some((event) => event.date < initialDate)) {
        throw new Error('起始日期不能晚于已有转入/转出记录');
      }
      const stamp = new Date().toISOString();
      return transactionManager.run(() => {
        const beforePrincipals = new Map(
          selectRecords
            .all()
            .map((row) => [Number(row.id), Number(row.principal)]),
        );
        updateCapitalSettings.run(initialPrincipal, initialDate, stamp);
        const nextSettings = getSettings();
        recalculateRecordPrincipals(db, updateRecordPrincipal, nextSettings, events);
        syncAllAccountRecordsFromProducts({
          operationId: `capital-update-project:${stamp}`,
          requestId: `capital-update-project:${stamp}`,
        });
        if (dataTrustStore?.enabled) {
          dataTrustStore.recordFactRevision({
            factType: 'capital_initial',
            factKey: 'capital_initial:1',
            action: 'update',
            before: settings,
            after: nextSettings,
            reason: '修改初始本金或起始日期',
            sourceClass: 'manual',
            actorType: 'human',
            actorRef: 'capital-service',
            operationId: `capital-init-update:${stamp}`,
            requestId: `capital-init-update:${stamp}`,
            createdAt: stamp,
          });
          recordPrincipalChanges({
            beforePrincipals,
            reason: '修改本金设置后重算历史本金快照',
            operationPrefix: 'capital-update-principal',
            relatedFactType: 'capital_initial',
            relatedFactKey: 'capital_initial:1',
            stamp,
          });
        }
        return getCapitalState();
      });
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
      return transactionManager.run(() => {
        const beforePrincipals = new Map(
          selectRecords
            .all()
            .map((row) => [Number(row.id), Number(row.principal)]),
        );
        const result = insertCapitalEvent.run(
          event.date,
          event.type,
          event.amount,
          event.note,
          stamp,
        );
        const newId = Number(result.lastInsertRowid);
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
        syncAllAccountRecordsFromProducts({
          operationId: `capital-event-project:${stamp}`,
          requestId: `capital-event-project:${stamp}`,
        });
        const created = { ...event, id: newId };
        if (dataTrustStore?.enabled) {
          dataTrustStore.recordFactRevision({
            factType: 'capital_event',
            factKey: `capital_event:${newId}`,
            action: 'create',
            before: {},
            after: created,
            reason: event.note || '创建本金事件',
            sourceClass: 'manual',
            actorType: 'human',
            actorRef: 'capital-service',
            operationId: `capital-event-create:${newId}:${stamp}`,
            requestId: `capital-event-create:${newId}:${stamp}`,
            createdAt: stamp,
          });
          recordPrincipalChanges({
            beforePrincipals,
            reason: '本金事件后重算历史本金快照',
            operationPrefix: 'capital-event-principal',
            relatedFactType: 'capital_event',
            relatedFactKey: `capital_event:${newId}`,
            stamp,
          });
        }
        return created;
      });
    },
    deleteCapitalEvent(id) {
      const rawEvent = selectCapitalEvent.get(id);
      if (!rawEvent) return false;
      const event = mapCapitalEvent(rawEvent);
      const settings = getSettings();
      return transactionManager.run(() => {
        const beforePrincipals = new Map(
          selectRecords
            .all()
            .map((row) => [Number(row.id), Number(row.principal)]),
        );
        deleteCapitalEventStatement.run(id);
        const events = getEvents(settings);
        recalculateRecordPrincipals(db, updateRecordPrincipal, settings, events);
        syncAllAccountRecordsFromProducts({
          operationId: `capital-delete-project:${id}`,
          requestId: `capital-delete-project:${id}`,
        });
        if (dataTrustStore?.enabled) {
          const stamp = new Date().toISOString();
          dataTrustStore.recordFactRevision({
            factType: 'capital_event',
            factKey: `capital_event:${id}`,
            action: 'delete',
            before: event,
            after: { deleted: true },
            reason: '删除本金事件',
            sourceClass: 'manual',
            actorType: 'human',
            actorRef: 'capital-service',
            operationId: `capital-event-delete:${id}:${stamp}`,
            requestId: `capital-event-delete:${id}:${stamp}`,
            createdAt: stamp,
          });
          recordPrincipalChanges({
            beforePrincipals,
            reason: '删除本金事件后重算历史本金快照',
            operationPrefix: 'capital-event-delete-principal',
            relatedFactType: 'capital_event',
            relatedFactKey: `capital_event:${id}`,
            stamp,
          });
        }
        return true;
      });
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
