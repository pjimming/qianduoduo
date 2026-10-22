'use strict';

const PRODUCT_VALUATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS product_daily_valuations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    valuation_date TEXT NOT NULL,
    credit_date TEXT NOT NULL DEFAULT '',
    yield_date TEXT NOT NULL,
    product_code TEXT NOT NULL,
    product_name TEXT NOT NULL DEFAULT '',
    holding_amount REAL,
    daily_pnl REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual-correction',
    screenshot_id INTEGER,
    confidence REAL NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(product_code, yield_date)
  );

  CREATE INDEX IF NOT EXISTS idx_product_daily_valuations_yield
    ON product_daily_valuations(yield_date DESC, product_code ASC);

  CREATE INDEX IF NOT EXISTS idx_product_daily_valuations_product
    ON product_daily_valuations(product_code, yield_date DESC);

  CREATE TABLE IF NOT EXISTS product_daily_valuation_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    valuation_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create', 'update')),
    before_json TEXT NOT NULL DEFAULT '{}',
    after_json TEXT NOT NULL DEFAULT '{}',
    note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_product_valuation_audit_valuation
    ON product_daily_valuation_audit(valuation_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS product_yield_settings (
    product_code TEXT PRIMARY KEY,
    yield_lag_days INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'default',
    notes TEXT NOT NULL DEFAULT '',
    verified_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS product_yield_setting_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_code TEXT NOT NULL,
    before_json TEXT NOT NULL DEFAULT '{}',
    after_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_product_yield_setting_audit_product
    ON product_yield_setting_audit(product_code, created_at DESC);
`;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_YIELD_LAG_DAYS = 1;
const MAX_YIELD_LAG_DAYS = 5;
const YIELD_LAG_SOURCES = new Set([
  'default',
  'product-document',
  'app-rule',
  'user-confirmed',
]);

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || '') ?? fallback;
  } catch {
    return fallback;
  }
}

function parseYmd(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) ? stamp : null;
}

function shiftDate(date, days) {
  const stamp = parseYmd(date);
  if (stamp === null) return date;
  return new Date(stamp + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const start = parseYmd(from);
  const end = parseYmd(to);
  if (start === null || end === null) return 0;
  return Math.max(0, Math.round((end - start) / DAY_MS));
}

function mapValuation(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    valuation_date: row.valuation_date,
    credit_date: row.credit_date || row.valuation_date,
    yield_date: row.yield_date,
    product_code: row.product_code,
    product_name: row.product_name || '',
    holding_amount:
      row.holding_amount === null || row.holding_amount === undefined
        ? null
        : Number(row.holding_amount),
    daily_pnl: Number(row.daily_pnl),
    source: row.source || 'manual-correction',
    screenshot_id:
      row.screenshot_id === null || row.screenshot_id === undefined
        ? null
        : Number(row.screenshot_id),
    confidence: Number(row.confidence || 0),
    notes: row.notes || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapYieldSetting(row, productCode = '') {
  const code = String(row?.product_code || productCode || '').toUpperCase();
  const lag = Number(row?.yield_lag_days ?? DEFAULT_YIELD_LAG_DAYS);
  const source = YIELD_LAG_SOURCES.has(row?.source)
    ? row.source
    : 'default';
  return {
    product_code: code,
    yield_lag_days:
      Number.isInteger(lag) && lag >= 0 && lag <= MAX_YIELD_LAG_DAYS
        ? lag
        : DEFAULT_YIELD_LAG_DAYS,
    source,
    verified: source !== 'default',
    label:
      source === 'default'
        ? `T+${DEFAULT_YIELD_LAG_DAYS}（默认，待核）`
        : `T+${Number(row?.yield_lag_days ?? DEFAULT_YIELD_LAG_DAYS)}`,
    notes: row?.notes || '',
    verified_at: row?.verified_at || '',
    updated_at: row?.updated_at || '',
  };
}

function mapAudit(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    valuation_id: Number(row.valuation_id),
    action: row.action,
    before: parseJson(row.before_json, {}),
    after: parseJson(row.after_json, {}),
    note: row.note || '',
    source: row.source || '',
    created_at: row.created_at,
  };
}

function normalizeValuation(input = {}, options = {}) {
  const stamp = new Date().toISOString();
  const yieldDate = String(input.yield_date || input.date || '').trim();
  const valuationDate = String(
    input.valuation_date || input.capture_date || yieldDate,
  ).trim();
  const creditDate = String(
    input.credit_date || input.posting_date || valuationDate,
  ).trim();
  const productCode = String(input.product_code || '')
    .trim()
    .toUpperCase();
  const productName = String(input.product_name || '').trim();
  const dailyPnl = Number(input.daily_pnl);
  const holdingAmount =
    input.holding_amount === null ||
    input.holding_amount === undefined ||
    input.holding_amount === ''
      ? null
      : Number(input.holding_amount);
  const confidence = Math.max(
    0,
    Math.min(100, Number(input.confidence ?? options.confidence ?? 0)),
  );

  if (!parseYmd(yieldDate)) {
    throw new Error('产品收益日期格式应为 YYYY-MM-DD');
  }
  if (!parseYmd(valuationDate)) {
    throw new Error('产品估值日期格式应为 YYYY-MM-DD');
  }
  if (!parseYmd(creditDate)) {
    throw new Error('产品收益到账/可见日期格式应为 YYYY-MM-DD');
  }
  if (!/^[A-Z0-9-]{4,32}$/.test(productCode)) {
    throw new Error('产品代码格式不正确');
  }
  if (!Number.isFinite(dailyPnl)) {
    throw new Error(`产品 ${productCode} 缺少有效当日收益`);
  }
  if (holdingAmount !== null && (!Number.isFinite(holdingAmount) || holdingAmount < 0)) {
    throw new Error(`产品 ${productCode} 的持仓金额不正确`);
  }

  return {
    valuation_date: valuationDate,
    credit_date: creditDate,
    yield_date: yieldDate,
    product_code: productCode,
    product_name: productName,
    holding_amount:
      holdingAmount === null ? null : roundMoney(holdingAmount),
    daily_pnl: roundMoney(dailyPnl),
    source: String(options.source || input.source || 'manual-correction'),
    screenshot_id:
      input.screenshot_id === null || input.screenshot_id === undefined
        ? options.screenshotId ?? null
        : Number(input.screenshot_id),
    confidence,
    notes: String(input.notes || ''),
    created_at: stamp,
    updated_at: stamp,
  };
}

function createProductValuationStore(db, options = {}) {
  db.exec(PRODUCT_VALUATION_SCHEMA);
  const tradeStore = options.tradeStore || null;
  const valuationColumns = db
    .prepare('PRAGMA table_info(product_daily_valuations)')
    .all()
    .map((column) => column.name);
  if (!valuationColumns.includes('credit_date')) {
    db.exec(
      "ALTER TABLE product_daily_valuations ADD COLUMN credit_date TEXT NOT NULL DEFAULT ''",
    );
  }
  db.exec(`
    UPDATE product_daily_valuations
    SET credit_date = valuation_date
    WHERE credit_date IS NULL OR credit_date = ''
  `);

  const selectAll = db.prepare(`
    SELECT * FROM product_daily_valuations
    ORDER BY yield_date DESC, id DESC
  `);
  const selectByProduct = db.prepare(`
    SELECT * FROM product_daily_valuations
    WHERE product_code = ?
    ORDER BY yield_date ASC, id ASC
  `);
  const selectOne = db.prepare('SELECT * FROM product_daily_valuations WHERE id = ?');
  const selectUnique = db.prepare(`
    SELECT * FROM product_daily_valuations
    WHERE product_code = ? AND yield_date = ?
  `);
  const insertValuation = db.prepare(`
    INSERT INTO product_daily_valuations (
      valuation_date, credit_date, yield_date, product_code, product_name,
      holding_amount, daily_pnl, source, screenshot_id, confidence, notes,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateValuation = db.prepare(`
    UPDATE product_daily_valuations
    SET valuation_date = ?, credit_date = ?, yield_date = ?, product_name = ?,
        holding_amount = ?, daily_pnl = ?, source = ?, screenshot_id = ?,
        confidence = ?, notes = ?, updated_at = ?
    WHERE id = ?
  `);
  const insertAudit = db.prepare(`
    INSERT INTO product_daily_valuation_audit (
      valuation_id, action, before_json, after_json, note, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const selectAudit = db.prepare(`
    SELECT * FROM product_daily_valuation_audit
    WHERE valuation_id = ?
    ORDER BY created_at DESC, id DESC
  `);
  const selectAuditForProduct = db.prepare(`
    SELECT a.*
    FROM product_daily_valuation_audit a
    JOIN product_daily_valuations v ON v.id = a.valuation_id
    WHERE v.product_code = ?
    ORDER BY a.created_at DESC, a.id DESC
  `);
  const selectHoldingStart = db.prepare(`
    SELECT MIN(COALESCE(NULLIF(confirm_date, ''), trade_date)) AS holding_start
    FROM trade_transactions
    WHERE status = 'confirmed' AND (
      (trade_type = 'buy' AND UPPER(product_code) = ?)
      OR (trade_type = 'switch' AND UPPER(target_product_code) = ?)
    )
  `);
  const selectHoldingEnd = db.prepare(`
    SELECT MAX(COALESCE(NULLIF(confirm_date, ''), trade_date)) AS holding_end
    FROM trade_transactions
    WHERE status = 'confirmed'
      AND trade_type IN ('redeem', 'switch')
      AND UPPER(product_code) = ?
  `);
  const selectReconciliation = db.prepare(`
    SELECT
      v.valuation_date AS account_date,
      GROUP_CONCAT(DISTINCT v.yield_date) AS yield_dates,
      SUM(v.daily_pnl) AS product_pnl,
      COUNT(*) AS product_count,
      d.daily_pnl AS account_pnl,
      d.id AS record_id
    FROM product_daily_valuations v
    LEFT JOIN daily_records d ON d.record_date = v.valuation_date
    GROUP BY v.valuation_date
    ORDER BY v.valuation_date DESC
  `);
  const selectYieldSetting = db.prepare(
    'SELECT * FROM product_yield_settings WHERE product_code = ?',
  );
  const selectAllYieldSettings = db.prepare(
    'SELECT * FROM product_yield_settings ORDER BY product_code ASC',
  );
  const upsertYieldSetting = db.prepare(`
    INSERT INTO product_yield_settings (
      product_code, yield_lag_days, source, notes, verified_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_code) DO UPDATE SET
      yield_lag_days = excluded.yield_lag_days,
      source = excluded.source,
      notes = excluded.notes,
      verified_at = excluded.verified_at,
      updated_at = excluded.updated_at
  `);
  const insertYieldSettingAudit = db.prepare(`
    INSERT INTO product_yield_setting_audit (
      product_code, before_json, after_json, created_at
    ) VALUES (?, ?, ?, ?)
  `);

  function activeHoldings() {
    if (!tradeStore || typeof tradeStore.getPortfolio !== 'function') return [];
    return tradeStore.getPortfolio();
  }

  function listValuations({ productCode = '', limit = null } = {}) {
    const rows = productCode
      ? selectByProduct.all(String(productCode).trim().toUpperCase())
      : selectAll.all();
    const mapped = rows.map(mapValuation);
    return limit && limit > 0 ? mapped.slice(0, Number(limit)) : mapped;
  }

  function getYieldSetting(productCode) {
    const code = String(productCode || '').trim().toUpperCase();
    if (!code) throw new Error('缺少产品代码');
    return mapYieldSetting(selectYieldSetting.get(code), code);
  }

  function listYieldSettings() {
    return selectAllYieldSettings
      .all()
      .map((row) => mapYieldSetting(row, row.product_code));
  }

  function saveYieldSetting(productCode, input = {}) {
    const code = String(productCode || input.product_code || '')
      .trim()
      .toUpperCase();
    if (!/^[A-Z0-9-]{4,32}$/.test(code)) {
      throw new Error('产品代码格式不正确');
    }
    const lag = Number(input.yield_lag_days ?? DEFAULT_YIELD_LAG_DAYS);
    if (
      !Number.isInteger(lag) ||
      lag < 0 ||
      lag > MAX_YIELD_LAG_DAYS
    ) {
      throw new Error(
        `产品收益延迟需要是 0–${MAX_YIELD_LAG_DAYS} 的整数自然日`,
      );
    }
    const source = String(input.source || '').trim();
    if (!YIELD_LAG_SOURCES.has(source) || source === 'default') {
      throw new Error('请选择产品文档、App 规则或本人确认作为核验来源');
    }
    const stamp = new Date().toISOString();
    const verifiedAt =
      String(input.verified_at || '').trim() ||
      new Date().toISOString().slice(0, 10);
    if (!parseYmd(verifiedAt)) {
      throw new Error('核验日期格式应为 YYYY-MM-DD');
    }
    const before = getYieldSetting(code);
    db.exec('BEGIN IMMEDIATE');
    try {
      upsertYieldSetting.run(
        code,
        lag,
        source,
        String(input.notes || '').trim(),
        verifiedAt,
        stamp,
      );
      const after = getYieldSetting(code);
      insertYieldSettingAudit.run(
        code,
        JSON.stringify(before),
        JSON.stringify(after),
        stamp,
      );
      db.exec('COMMIT');
      return after;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function getDisclosurePolicy(today, holdings = activeHoldings()) {
    const activeCodes = [
      ...new Set(
        (holdings || [])
          .map((holding) => String(holding.product_code || '').trim().toUpperCase())
          .filter(Boolean),
      ),
    ].sort();
    const settings = activeCodes.map((code) => {
      const setting = getYieldSetting(code);
      return {
        ...setting,
        expected_latest_yield_date: shiftDate(
          today,
          -setting.yield_lag_days,
        ),
        todays_yield_visible_date: shiftDate(
          today,
          setting.yield_lag_days,
        ),
      };
    });
    return {
      basis: 'user-provided-date-with-cmb-daily-reminder',
      default_yield_lag_days: DEFAULT_YIELD_LAG_DAYS,
      reporting_lag_days: DEFAULT_YIELD_LAG_DAYS,
      reporting_date: shiftDate(today, -DEFAULT_YIELD_LAG_DAYS),
      active_product_count: settings.length,
      unverified_product_codes: settings
        .filter((item) => !item.verified)
        .map((item) => item.product_code),
      products: settings,
    };
  }

  function getValuation(id) {
    return mapValuation(selectOne.get(id));
  }

  function getAudit(valuationId = null) {
    const rows =
      valuationId === null
        ? db
            .prepare(
              'SELECT * FROM product_daily_valuation_audit ORDER BY created_at DESC, id DESC',
            )
            .all()
        : selectAudit.all(valuationId);
    return rows.map(mapAudit);
  }

  function getProductAudit(productCode) {
    return selectAuditForProduct
      .all(String(productCode).trim().toUpperCase())
      .map(mapAudit);
  }

  function upsertValuation(input = {}, writeOptions = {}) {
    const normalized = normalizeValuation(input, writeOptions);
    const beforeRow = selectUnique.get(
      normalized.product_code,
      normalized.yield_date,
    );
    const before = mapValuation(beforeRow);
    if (
      before &&
      Math.abs(Number(before.daily_pnl) - normalized.daily_pnl) <= 0.005
    ) {
      return {
        valuation: before,
        conflict: null,
        unchanged: true,
      };
    }
    if (before) {
      return {
        valuation: before,
        conflict: 'different-daily-pnl',
        unchanged: false,
      };
    }
    let id;
    if (before) {
      updateValuation.run(
        normalized.valuation_date,
        normalized.credit_date,
        normalized.yield_date,
        normalized.product_name || before.product_name,
        normalized.holding_amount ?? before.holding_amount,
        normalized.daily_pnl,
        writeOptions.preserveManual && before.source === 'manual-correction'
          ? before.source
          : normalized.source,
        normalized.screenshot_id ?? before.screenshot_id,
        normalized.confidence || before.confidence,
        normalized.notes || before.notes,
        normalized.updated_at,
        before.id,
      );
      id = before.id;
    } else {
      const result = insertValuation.run(
        normalized.valuation_date,
        normalized.credit_date,
        normalized.yield_date,
        normalized.product_code,
        normalized.product_name,
        normalized.holding_amount,
        normalized.daily_pnl,
        normalized.source,
        normalized.screenshot_id,
        normalized.confidence,
        normalized.notes,
        normalized.created_at,
        normalized.updated_at,
      );
      id = Number(result.lastInsertRowid);
    }
    const after = getValuation(id);
    insertAudit.run(
      id,
      before ? 'update' : 'create',
      JSON.stringify(before || {}),
      JSON.stringify(after || {}),
      String(writeOptions.auditNote || input.correction_note || ''),
      normalized.source,
      normalized.updated_at,
    );
    return { valuation: after, conflict: null };
  }

  function updateValuationById(id, input = {}, writeOptions = {}) {
    const before = getValuation(id);
    if (!before) return null;
    const normalized = normalizeValuation(
      {
        ...before,
        ...input,
        product_code: before.product_code,
      },
      writeOptions,
    );
    const conflict = selectUnique.get(
      normalized.product_code,
      normalized.yield_date,
    );
    if (conflict && Number(conflict.id) !== Number(id)) {
      throw new Error(
        `产品 ${normalized.product_code} 在 ${normalized.yield_date} 已有收益记录`,
      );
    }
    updateValuation.run(
      normalized.valuation_date,
      normalized.credit_date,
      normalized.yield_date,
      normalized.product_name || before.product_name,
      normalized.holding_amount ?? before.holding_amount,
      normalized.daily_pnl,
      normalized.source,
      normalized.screenshot_id ?? before.screenshot_id,
      normalized.confidence || before.confidence,
      normalized.notes || before.notes,
      normalized.updated_at,
      before.id,
    );
    const after = getValuation(id);
    insertAudit.run(
      id,
      'update',
      JSON.stringify(before),
      JSON.stringify(after || {}),
      String(writeOptions.auditNote || input.correction_note || ''),
      normalized.source,
      normalized.updated_at,
    );
    return { valuation: after, conflict: null };
  }

  function upsertMany(entries = [], writeOptions = {}) {
    const saved = [];
    const conflicts = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of entries) {
        const result = upsertValuation(entry, writeOptions);
        if (result.conflict) {
          conflicts.push({
            product_code: String(entry.product_code || '').toUpperCase(),
            yield_date: entry.yield_date || entry.date || '',
            reason: result.conflict,
            existing: result.valuation,
          });
        } else if (result.valuation) {
          saved.push(result.valuation);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { saved, conflicts };
  }

  function getReconciliation({ limit = null } = {}) {
    const allItems = selectReconciliation.all().map((row) => {
      const productPnl = roundMoney(row.product_pnl);
      const accountPnl =
        row.account_pnl === null || row.account_pnl === undefined
          ? null
          : roundMoney(row.account_pnl);
      const difference =
        accountPnl === null ? null : roundMoney(accountPnl - productPnl);
      const status =
        accountPnl === null
          ? 'missing-account-total'
          : Math.abs(difference) <= 0.01
            ? 'matched'
            : 'mismatch';
      const message =
        status === 'matched'
          ? '产品合计与账户总收益一致'
          : status === 'missing-account-total'
            ? '产品收益已归档，但该日尚无账户总收益'
            : `产品合计与账户总收益相差 ¥${difference.toFixed(2)}，请核对漏识别、重复或代码`;
      return {
        account_date: row.account_date,
        yield_dates: String(row.yield_dates || '')
          .split(',')
          .filter(Boolean)
          .sort(),
        product_pnl: productPnl,
        product_count: Number(row.product_count || 0),
        account_pnl: accountPnl,
        difference,
        status,
        message,
        record_id:
          row.record_id === null || row.record_id === undefined
            ? null
            : Number(row.record_id),
      };
    });
    const items =
      limit && limit > 0 ? allItems.slice(0, Number(limit)) : allItems;
    return {
      items,
      counts: {
        matched: allItems.filter((item) => item.status === 'matched').length,
        mismatch: allItems.filter((item) => item.status === 'mismatch').length,
        missing_account_total: allItems.filter(
          (item) => item.status === 'missing-account-total',
        ).length,
      },
    };
  }

  function getReconciliationForDate(yieldDate) {
    return (
      getReconciliation().items.find((item) => item.account_date === yieldDate) ||
      null
    );
  }

  function getSummaries(today, holdings = activeHoldings()) {
    const activeByCode = new Map();
    for (const holding of holdings) {
      const code = String(holding.product_code || '').toUpperCase();
      activeByCode.set(code, roundMoney((activeByCode.get(code) || 0) + holding.amount));
    }
    const grouped = new Map();
    for (const valuation of listValuations()) {
      const list = grouped.get(valuation.product_code) || [];
      list.push(valuation);
      grouped.set(valuation.product_code, list);
    }

    return [...grouped.entries()]
      .map(([productCode, rows]) => {
        const ordered = rows
          .slice()
          .sort((a, b) => a.yield_date.localeCompare(b.yield_date) || a.id - b.id);
        const latest = ordered.at(-1);
        const startResult = selectHoldingStart.get(productCode, productCode);
        const endResult = selectHoldingEnd.get(productCode);
        const activeAmount = activeByCode.get(productCode) || 0;
        const status = activeByCode.has(productCode) ? 'active' : 'redeemed';
        const yieldSetting = getYieldSetting(productCode);
        const holdingStart =
          startResult?.holding_start || ordered[0]?.yield_date || '';
        const holdingEnd = status === 'active'
          ? today
          : endResult?.holding_end || latest?.yield_date || holdingStart;
        const worst = ordered.reduce(
          (result, item) =>
            !result || item.daily_pnl < result.daily_pnl ? item : result,
          null,
        );
        const best = ordered.reduce(
          (result, item) =>
            !result || item.daily_pnl > result.daily_pnl ? item : result,
          null,
        );
        return {
          product_code: productCode,
          product_name: latest?.product_name || '',
          status,
          active_amount: activeAmount,
          latest_holding_amount: latest?.holding_amount ?? null,
          first_yield_date: ordered[0]?.yield_date || '',
          last_yield_date: latest?.yield_date || '',
          holding_start: holdingStart,
          holding_end: holdingEnd,
          holding_days:
            holdingStart && holdingEnd
              ? daysBetween(holdingStart, holdingEnd) + 1
              : 0,
          observed_days: ordered.length,
          cumulative_pnl: roundMoney(
            ordered.reduce((sum, item) => sum + item.daily_pnl, 0),
          ),
          negative_days: ordered.filter((item) => item.daily_pnl < 0).length,
          latest_daily_pnl: latest?.daily_pnl ?? null,
          yield_lag_days: yieldSetting.yield_lag_days,
          yield_lag_source: yieldSetting.source,
          yield_lag_verified: yieldSetting.verified,
          yield_lag_label: yieldSetting.label,
          yield_lag_notes: yieldSetting.notes,
          yield_lag_updated_at: yieldSetting.updated_at,
          expected_latest_yield_date:
            status === 'active'
              ? shiftDate(today, -yieldSetting.yield_lag_days)
              : '',
          todays_yield_visible_date:
            status === 'active'
              ? shiftDate(today, yieldSetting.yield_lag_days)
              : '',
          worst_day: worst
            ? { yield_date: worst.yield_date, daily_pnl: worst.daily_pnl }
            : null,
          best_day: best
            ? { yield_date: best.yield_date, daily_pnl: best.daily_pnl }
            : null,
        };
      })
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
        return b.last_yield_date.localeCompare(a.last_yield_date);
      });
  }

  function getWorkspace(today, holdings = activeHoldings()) {
    const summaries = getSummaries(today, holdings);
    const reconciliation = getReconciliation({ limit: 12 });
    const disclosurePolicy = getDisclosurePolicy(today, holdings);
    return {
      product_valuation_summaries: summaries,
      product_valuation_reconciliation: reconciliation,
      product_valuation_disclosure_policy: disclosurePolicy,
      product_valuation_summary: {
        products: summaries.length,
        active: summaries.filter((item) => item.status === 'active').length,
        redeemed: summaries.filter((item) => item.status === 'redeemed').length,
        valuation_days: new Set(summaries.map((item) => item.last_yield_date)).size,
        latest_date:
          summaries
            .map((item) => item.last_yield_date)
            .filter(Boolean)
            .sort()
            .at(-1) || null,
        max_yield_lag_days: disclosurePolicy.reporting_lag_days,
        unverified_product_codes: disclosurePolicy.unverified_product_codes,
      },
    };
  }

  function getProductDetail(productCode, today = new Date().toISOString().slice(0, 10)) {
    const normalizedCode = String(productCode || '').trim().toUpperCase();
    if (!normalizedCode) throw new Error('缺少产品代码');
    const summaries = getSummaries(today);
    return {
      summary:
        summaries.find((item) => item.product_code === normalizedCode) || null,
      yield_setting: getYieldSetting(normalizedCode),
      valuations: listValuations({ productCode: normalizedCode }),
      audit: getProductAudit(normalizedCode),
    };
  }

  return {
    DEFAULT_YIELD_LAG_DAYS,
    MAX_YIELD_LAG_DAYS,
    listValuations,
    getValuation,
    getAudit,
    getProductAudit,
    upsertValuation,
    updateValuationById,
    upsertMany,
    getReconciliation,
    getReconciliationForDate,
    getSummaries,
    getWorkspace,
    getProductDetail,
    getYieldSetting,
    listYieldSettings,
    saveYieldSetting,
    getDisclosurePolicy,
  };
}

module.exports = {
  PRODUCT_VALUATION_SCHEMA,
  createProductValuationStore,
  mapValuation,
  normalizeValuation,
};
