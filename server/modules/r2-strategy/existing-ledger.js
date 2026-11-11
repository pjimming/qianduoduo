'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createTradeStore } = require('../../../lib/trade-store');
const { createReviewStore } = require('../../../lib/review-store');
const { createTransactionManager } = require('../../../lib/transaction');
const { mapProduct, principalAt } = require('../../../lib/db');
const { normalizeAllocationSettings } = require('../../../lib/products');

// Existing-schema adapter for workers/CLI. In particular it does NOT call
// openDatabase, import a CSV, replay migrations or update migration timestamps.
function openStrategyLedger(file, { readOnly = false } = {}) {
  const dbPath = path.resolve(file);
  if (!fs.existsSync(dbPath)) throw new Error('策略输入账本不存在；禁止隐式初始化');
  const db = new DatabaseSync(dbPath, { readOnly });
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000');
    const transactionManager = createTransactionManager(db);
    const tradeStore = createTradeStore(db, { initialize: false, transactionManager,
      inboxDir: path.join(path.dirname(dbPath), 'trade-inbox') });
    const reviewStore = createReviewStore(db, { initialize: false, transactionManager });
    const selectProducts = db.prepare('SELECT * FROM products ORDER BY term_days ASC, name ASC');
    return { db, dbPath, transactionManager, tradeStore, listDecisions: reviewStore.listDecisions,
      listProducts() { return selectProducts.all().map(mapProduct); },
      getCapitalState(date) {
        const raw = db.prepare('SELECT * FROM capital_settings WHERE id=1').get();
        if (!raw) return { current_principal: 0, initialized: false };
        const settings = { initial_principal: raw.initial_principal, initial_date: raw.initial_date };
        const events = db.prepare('SELECT event_date AS date,event_type AS type,amount FROM capital_events ORDER BY event_date,id').all();
        return { current_principal: principalAt(settings, events, date), initial_date: settings.initial_date, initialized: true };
      },
      getAllocationSettings() {
        const raw = db.prepare("SELECT value FROM app_meta WHERE key='product_allocation_settings_v1'").get();
        const settings = raw ? JSON.parse(raw.value) : {};
        return normalizeAllocationSettings(settings, reviewStore.listDecisions());
      },
      close() { db.close(); },
    };
  } catch (error) { db.close(); throw error; }
}

module.exports = { openStrategyLedger };
