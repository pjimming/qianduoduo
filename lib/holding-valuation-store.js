'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createTransactionManager } = require('./transaction');

const HOLDING_VALUATION_MIGRATION_ID = 'holding-valuation-v1';
const HOLDING_VALUATION_EVIDENCE_TYPE = 'bank-statement';
const IMAGE_MIME_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

const HOLDING_VALUATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS holding_valuation_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    as_of_date TEXT NOT NULL,
    as_of_at TEXT NOT NULL,
    total_value REAL NOT NULL CHECK (total_value >= 0),
    source TEXT NOT NULL DEFAULT 'user-confirmed',
    evidence_id INTEGER,
    notes TEXT NOT NULL DEFAULT '',
    dedupe_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_holding_valuation_snapshots_as_of
    ON holding_valuation_snapshots(as_of_date DESC, as_of_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS holding_valuation_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id INTEGER NOT NULL
      REFERENCES holding_valuation_snapshots(id) ON DELETE CASCADE,
    product_code TEXT NOT NULL,
    product_name TEXT NOT NULL DEFAULT '',
    market_value REAL NOT NULL CHECK (market_value >= 0),
    active_cost REAL,
    created_at TEXT NOT NULL,
    UNIQUE(snapshot_id, product_code)
  );

  CREATE INDEX IF NOT EXISTS idx_holding_valuation_items_snapshot
    ON holding_valuation_items(snapshot_id, product_code ASC);
`;

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function parseYmd(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
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

function todayShanghai() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeProductCode(value) {
  return String(value || '').trim().toUpperCase();
}

function stableItems(items) {
  return [...items].sort((a, b) =>
    a.product_code.localeCompare(b.product_code),
  );
}

function snapshotDedupeKey({ asOfDate, totalValue, source, evidenceId, items }) {
  const payload = JSON.stringify({
    as_of_date: asOfDate,
    total_value: roundMoney(totalValue),
    source,
    evidence_id: evidenceId,
    items: stableItems(items).map((item) => ({
      product_code: item.product_code,
      market_value: roundMoney(item.market_value),
      active_cost:
        item.active_cost === null ? null : roundMoney(item.active_cost),
    })),
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function mapSnapshotRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    as_of_date: row.as_of_date,
    as_of_at: row.as_of_at,
    total_value: Number(row.total_value),
    source: row.source,
    evidence_id:
      row.evidence_id === null || row.evidence_id === undefined
        ? null
        : Number(row.evidence_id),
    notes: row.notes || '',
    dedupe_key: row.dedupe_key,
    created_at: row.created_at,
  };
}

function mapItemRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    snapshot_id: Number(row.snapshot_id),
    product_code: row.product_code,
    product_name: row.product_name || '',
    market_value: Number(row.market_value),
    active_cost:
      row.active_cost === null || row.active_cost === undefined
        ? null
        : Number(row.active_cost),
    created_at: row.created_at,
  };
}

function createHoldingValuationStore(db, options = {}) {
  const transactionManager =
    options.transactionManager || createTransactionManager(db);
  const tradeStore = options.tradeStore || null;
  const evidenceDir =
    options.evidenceDir ||
    path.join(process.cwd(), 'data', 'holding-valuation-evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  let dataTrustStore = options.dataTrustStore || null;
  db.exec(HOLDING_VALUATION_SCHEMA);

  const selectLatestSnapshot = db.prepare(`
    SELECT * FROM holding_valuation_snapshots
    ORDER BY as_of_date DESC, as_of_at DESC, id DESC
    LIMIT 1
  `);
  const selectPreviousSnapshot = db.prepare(`
    SELECT * FROM holding_valuation_snapshots
    ORDER BY as_of_date DESC, as_of_at DESC, id DESC
    LIMIT 1 OFFSET 1
  `);
  const selectSnapshotById = db.prepare(`
    SELECT * FROM holding_valuation_snapshots WHERE id = ?
  `);
  const selectSnapshotByDedupe = db.prepare(`
    SELECT * FROM holding_valuation_snapshots WHERE dedupe_key = ?
  `);
  const selectItemsBySnapshot = db.prepare(`
    SELECT * FROM holding_valuation_items
    WHERE snapshot_id = ?
    ORDER BY product_code ASC, id ASC
  `);
  const insertSnapshot = db.prepare(`
    INSERT INTO holding_valuation_snapshots (
      as_of_date, as_of_at, total_value, source, evidence_id,
      notes, dedupe_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO holding_valuation_items (
      snapshot_id, product_code, product_name, market_value,
      active_cost, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const selectConfirmedChanges = db.prepare(`
    SELECT confirm_date, trade_date, trade_type, product_code, updated_at
    FROM trade_transactions
    WHERE status = 'confirmed'
      AND trade_type IN ('buy', 'redeem', 'switch')
    ORDER BY COALESCE(NULLIF(confirm_date, ''), trade_date) DESC,
             id DESC
  `);
  const selectPendingBuys = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
    FROM trade_transactions
    WHERE status = 'pending'
      AND trade_type IN ('buy', 'switch')
  `);

  function getSnapshot(id) {
    const snapshot = mapSnapshotRow(selectSnapshotById.get(Number(id)));
    if (!snapshot) return null;
    return {
      ...snapshot,
      items: selectItemsBySnapshot.all(snapshot.id).map(mapItemRow),
    };
  }

  function getLatestSnapshot() {
    const snapshot = mapSnapshotRow(selectLatestSnapshot.get());
    if (!snapshot) return null;
    return {
      ...snapshot,
      items: selectItemsBySnapshot.all(snapshot.id).map(mapItemRow),
    };
  }

  function setDataTrustStore(store) {
    dataTrustStore = store || null;
  }

  function saveEvidenceImage(input) {
    if (!dataTrustStore?.enabled) {
      throw new Error('证据链未启用，暂时不能保存市值截图');
    }
    const extension = IMAGE_MIME_EXTENSIONS[input.mime];
    if (!extension) throw new Error('只支持 PNG、JPEG 或 WebP 截图');
    const sha256 = crypto
      .createHash('sha256')
      .update(input.buffer)
      .digest('hex');
    const existing = dataTrustStore.getEvidenceByHash(
      HOLDING_VALUATION_EVIDENCE_TYPE,
      sha256,
    );
    if (existing) {
      return { evidence: existing, duplicate: true };
    }
    const storedName = `${sha256}${extension}`;
    const filePath = path.join(evidenceDir, storedName);
    const createdFile = !fs.existsSync(filePath);
    if (createdFile) {
      fs.writeFileSync(filePath, input.buffer);
    }
    const stamp = new Date().toISOString();
    let evidence;
    try {
      evidence = transactionManager.run(() => {
        const created = dataTrustStore.recordEvidenceAsset({
          evidence_type: HOLDING_VALUATION_EVIDENCE_TYPE,
          source_channel: 'web-upload',
          sha256,
          original_name: input.original_name || '',
          storage_namespace: 'holding-valuation-evidence',
          storage_name: storedName,
          mime: input.mime,
          bytes: input.buffer.length,
          received_at: stamp,
          available: true,
          status: 'active',
          created_at: stamp,
        });
        if (!created) throw new Error('市值截图证据写入失败');
        dataTrustStore.appendEvent({
          evidence_id: created.id,
          event_type: 'received',
          actor_type: 'human',
          actor_ref: 'holding-valuation-upload',
          payload: {
            original_name: input.original_name || '',
            mime: input.mime,
            bytes: input.buffer.length,
            sha256,
          },
          request_id: `holding-valuation-evidence:${created.id}`,
          dedupe_key: `received:${created.id}`,
          created_at: stamp,
        });
        return created;
      });
    } catch (error) {
      if (createdFile) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Preserve the database error; an orphan cache file is harmless.
        }
      }
      throw error;
    }
    return { evidence, duplicate: false };
  }

  function getEvidenceFile(id) {
    const evidence = dataTrustStore?.getEvidenceAsset(Number(id));
    if (
      !evidence ||
      evidence.evidence_type !== HOLDING_VALUATION_EVIDENCE_TYPE ||
      evidence.storage_namespace !== 'holding-valuation-evidence' ||
      !evidence.storage_name
    ) {
      return null;
    }
    const filePath = path.resolve(evidenceDir, evidence.storage_name);
    const root = `${path.resolve(evidenceDir)}${path.sep}`;
    if (!filePath.startsWith(root)) return null;
    return {
      path: filePath,
      mime: evidence.mime || 'application/octet-stream',
      evidence,
    };
  }

  function normalizeItems(items, activeByCode, totalValue) {
    const input = Array.isArray(items) ? items : [];
    if (!input.length) return [];
    const normalized = [];
    const seen = new Set();
    for (const item of input) {
      const code = normalizeProductCode(item?.product_code);
      if (!code) throw new Error('逐产品市值缺少产品代码');
      if (seen.has(code)) throw new Error(`产品 ${code} 的市值重复`);
      seen.add(code);
      const marketValue = Number(item.market_value);
      if (!Number.isFinite(marketValue) || marketValue < 0) {
        throw new Error(`产品 ${code} 的市值必须是不小于 0 的数字`);
      }
      const active = activeByCode.get(code);
      if (!active) {
        throw new Error(`产品 ${code} 不是当前已确认持仓，不能写入本次快照`);
      }
      normalized.push({
        product_code: code,
        product_name: String(
          item.product_name || active.product_name || '',
        ).trim(),
        market_value: roundMoney(marketValue),
        active_cost: roundMoney(active.amount),
      });
    }
    const activeCodes = [...activeByCode.keys()].sort();
    const itemCodes = normalized.map((item) => item.product_code).sort();
    if (
      activeCodes.length !== itemCodes.length ||
      activeCodes.some((code, index) => code !== itemCodes[index])
    ) {
      throw new Error(
        '逐产品市值必须覆盖全部当前已确认持仓；如只掌握银行总市值，请留空逐产品明细',
      );
    }
    const itemTotal = roundMoney(
      normalized.reduce((sum, item) => sum + item.market_value, 0),
    );
    if (Math.abs(itemTotal - roundMoney(totalValue)) > 0.01) {
      throw new Error(
        `逐产品市值合计 ¥${itemTotal.toFixed(2)} 与总市值 ¥${roundMoney(
          totalValue,
        ).toFixed(2)} 不一致`,
      );
    }
    return stableItems(normalized);
  }

  function createSnapshot(input = {}, context = {}) {
    const asOfDate = String(input.as_of_date || context.today || '').trim();
    if (!parseYmd(asOfDate)) {
      throw new Error('市值快照日期格式应为 YYYY-MM-DD');
    }
    const today = context.today || todayShanghai();
    if (asOfDate > today) throw new Error('市值快照日期不能晚于今天');
    const totalValue = Number(
      input.total_value ?? input.current_value ?? input.value,
    );
    if (!Number.isFinite(totalValue) || totalValue < 0) {
      throw new Error('当前持仓总市值必须是不小于 0 的数字');
    }
    const source = String(input.source || 'user-confirmed').trim();
    if (!source) throw new Error('市值快照需要来源');
    const evidenceId =
      input.evidence_id === null || input.evidence_id === undefined
        ? null
        : Number(input.evidence_id);
    if (
      evidenceId !== null &&
      (!Number.isInteger(evidenceId) || evidenceId <= 0)
    ) {
      throw new Error('证据 ID 必须是正整数');
    }
    if (evidenceId !== null) {
      const evidence = dataTrustStore?.getEvidenceAsset(evidenceId);
      if (
        !evidence ||
        evidence.evidence_type !== HOLDING_VALUATION_EVIDENCE_TYPE
      ) {
        throw new Error('没有找到对应的市值截图证据');
      }
    }
    const holdings =
      typeof tradeStore?.getPortfolio === 'function'
        ? tradeStore.getPortfolio()
        : [];
    const activeByCode = new Map();
    for (const holding of holdings) {
      const code = normalizeProductCode(holding.product_code);
      if (!code) continue;
      const current = activeByCode.get(code) || {
        amount: 0,
        product_name: holding.product_name || '',
      };
      current.amount = roundMoney(current.amount + Number(holding.amount || 0));
      current.product_name = current.product_name || holding.product_name || '';
      activeByCode.set(code, current);
    }
    const items = normalizeItems(input.items, activeByCode, totalValue);
    const stamp = String(context.now || new Date().toISOString());
    const asOfAt = String(input.as_of_at || stamp).trim();
    if (Number.isNaN(new Date(asOfAt).getTime())) {
      throw new Error('市值快照时间格式不正确');
    }
    const dedupeKey = snapshotDedupeKey({
      asOfDate,
      totalValue,
      source,
      evidenceId,
      items,
    });
    const existing = mapSnapshotRow(selectSnapshotByDedupe.get(dedupeKey));
    if (existing) {
      return {
        created: false,
        snapshot: getSnapshot(existing.id),
      };
    }
    const snapshotId = transactionManager.run(() => {
      const result = insertSnapshot.run(
        asOfDate,
        asOfAt,
        roundMoney(totalValue),
        source,
        evidenceId,
        String(input.notes || '').trim(),
        dedupeKey,
        stamp,
      );
      const id = Number(result.lastInsertRowid);
      for (const item of items) {
        insertItem.run(
          id,
          item.product_code,
          item.product_name,
          item.market_value,
          item.active_cost,
          stamp,
        );
      }
      return id;
    });
    return {
      created: true,
      snapshot: getSnapshot(snapshotId),
    };
  }

  function getCurrent(today = todayShanghai(), holdings = null) {
    const activeHoldings =
      holdings ||
      (typeof tradeStore?.getPortfolio === 'function'
        ? tradeStore.getPortfolio()
        : []);
    const activeByCode = new Map();
    for (const holding of activeHoldings) {
      const code = normalizeProductCode(holding.product_code);
      if (!code) continue;
      const current = activeByCode.get(code) || {
        amount: 0,
        product_name: holding.product_name || '',
      };
      current.amount = roundMoney(current.amount + Number(holding.amount || 0));
      current.product_name = current.product_name || holding.product_name || '';
      activeByCode.set(code, current);
    }
    const activeCost = roundMoney(
      [...activeByCode.values()].reduce(
        (sum, item) => sum + item.amount,
        0,
      ),
    );
    const pending = selectPendingBuys.get();
    const latestSnapshot = getLatestSnapshot();
    const previousSnapshot = mapSnapshotRow(selectPreviousSnapshot.get());
    if (!latestSnapshot) {
      return {
        available: false,
        status: 'missing',
        current_value: null,
        as_of_date: null,
        as_of_at: null,
        source: null,
        notes: '',
        evidence_id: null,
        active_holding_count: activeHoldings.length,
        active_product_count: activeByCode.size,
        active_cost: activeCost,
        market_gain: null,
        pending_buy_count: Number(pending.count),
        pending_buy_amount: roundMoney(pending.amount),
        items: [],
        items_complete: false,
        stale_reasons: ['尚未录入银行当前持仓市值快照'],
      previous_value: previousSnapshot?.total_value ?? null,
      previous_as_of_date: previousSnapshot?.as_of_date ?? null,
      change_since_previous: null,
      };
    }
    const staleReasons = [];
    const latestChange = selectConfirmedChanges.get();
    const latestChangeDate = latestChange
      ? latestChange.confirm_date || latestChange.trade_date
      : null;
    const latestChangeAt = latestChange?.updated_at || '';
    const changedAfterSnapshot =
      latestChangeDate &&
      (latestChangeDate > latestSnapshot.as_of_date ||
        (latestChangeDate === latestSnapshot.as_of_date &&
          latestChangeAt > latestSnapshot.as_of_at));
    if (changedAfterSnapshot) {
      staleReasons.push(
        `快照后已有交易确认（${latestChangeDate} ${latestChange.trade_type} ${latestChange.product_code}）`,
      );
    }
    if (latestSnapshot.items.length) {
      const activeCodes = [...activeByCode.keys()].sort();
      const itemCodes = latestSnapshot.items
        .map((item) => item.product_code)
        .sort();
      if (
        activeCodes.length !== itemCodes.length ||
        activeCodes.some((code, index) => code !== itemCodes[index])
      ) {
        staleReasons.push('逐产品市值对应的持仓集合已经变化');
      }
    }
    return {
      available: true,
      status: staleReasons.length ? 'stale' : 'current',
      current_value: latestSnapshot.total_value,
      as_of_date: latestSnapshot.as_of_date,
      as_of_at: latestSnapshot.as_of_at,
      source: latestSnapshot.source,
      notes: latestSnapshot.notes,
      evidence_id: latestSnapshot.evidence_id,
      active_holding_count: activeHoldings.length,
      active_product_count: activeByCode.size,
      active_cost: activeCost,
      market_gain: roundMoney(latestSnapshot.total_value - activeCost),
      pending_buy_count: Number(pending.count),
      pending_buy_amount: roundMoney(pending.amount),
      items: latestSnapshot.items,
      items_complete: latestSnapshot.items.length > 0,
      stale_reasons: staleReasons,
      latest_confirmed_change_date: latestChangeDate,
      snapshot_id: latestSnapshot.id,
      previous_value: previousSnapshot?.total_value ?? null,
      previous_as_of_date: previousSnapshot?.as_of_date ?? null,
      change_since_previous:
        previousSnapshot === null
          ? null
          : roundMoney(
              latestSnapshot.total_value - previousSnapshot.total_value,
            ),
    };
  }

  function listSnapshots(limit = 20) {
    return db
      .prepare(`
        SELECT * FROM holding_valuation_snapshots
        ORDER BY as_of_date DESC, as_of_at DESC, id DESC
        LIMIT ?
      `)
      .all(Math.max(1, Math.min(200, Number(limit) || 20)))
      .map((row) => {
        const snapshot = mapSnapshotRow(row);
        return {
          ...snapshot,
          items: selectItemsBySnapshot.all(snapshot.id).map(mapItemRow),
        };
      });
  }

  function ensureMigrationRecord() {
    const migrationTable = db
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
      )
      .get();
    if (!Number(migrationTable.count)) return false;
    const hash = crypto
      .createHash('sha256')
      .update(HOLDING_VALUATION_SCHEMA)
      .digest('hex');
    const stamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO schema_migrations (
        id, script_sha256, status, started_at, completed_at, error
      ) VALUES (?, ?, 'completed', ?, ?, '')
      ON CONFLICT(id) DO UPDATE SET
        script_sha256 = excluded.script_sha256,
        status = 'completed',
        completed_at = excluded.completed_at,
        error = ''
    `).run(
      HOLDING_VALUATION_MIGRATION_ID,
      hash,
      stamp,
      stamp,
    );
    return true;
  }

  return {
    schema: HOLDING_VALUATION_SCHEMA,
    migrationId: HOLDING_VALUATION_MIGRATION_ID,
    createSnapshot,
    getCurrent,
    getLatestSnapshot,
    getSnapshot,
    listSnapshots,
    ensureMigrationRecord,
    getEvidenceFile,
    saveEvidenceImage,
    setDataTrustStore,
  };
}

module.exports = {
  HOLDING_VALUATION_MIGRATION_ID,
  HOLDING_VALUATION_EVIDENCE_TYPE,
  HOLDING_VALUATION_SCHEMA,
  createHoldingValuationStore,
  mapItemRow,
  mapSnapshotRow,
  snapshotDedupeKey,
};
