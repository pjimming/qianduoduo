'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION_ID = '2026-10-23-data-trust-v1';
const DDL_PATH = path.join(
  ROOT,
  'docs',
  'refactor',
  'migrations',
  '001-data-trust-v1.up.sql',
);
const NEW_TABLES = [
  'schema_migrations',
  'evidence_assets',
  'evidence_events',
  'fact_revisions',
  'fact_evidence_links',
];
const INBOX_COLUMNS = [
  'evidence_id',
  'workflow_state',
  'selected_event_id',
  'state_version',
  'last_request_id',
];
const LEGACY_STATUS_STATE = {
  pending: 'needs_correction',
  applied: 'posted',
  ignored: 'ignored',
};

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback = {}) {
  try {
    if (value === null || value === undefined || value === '') return fallback;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonText(value) {
  return JSON.stringify(value ?? {});
}

function ddlText() {
  return fs.readFileSync(DDL_PATH, 'utf8');
}

function ddlSha256() {
  return crypto.createHash('sha256').update(ddlText()).digest('hex');
}

function tableNames(db) {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
}

function columnNames(db, table) {
  if (!tableNames(db).has(table)) return new Set();
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );
}

function inspectSchema(db) {
  const tables = tableNames(db);
  const incomeColumns = columnNames(db, 'income_inbox');
  const tradeColumns = columnNames(db, 'trade_inbox');
  const presentTables = NEW_TABLES.filter((name) => tables.has(name));
  const presentFeatureTables = presentTables.filter(
    (name) => name !== 'schema_migrations',
  );
  const presentColumns = [
    ...INBOX_COLUMNS.filter((name) => incomeColumns.has(name)).map(
      (name) => `income_inbox.${name}`,
    ),
    ...INBOX_COLUMNS.filter((name) => tradeColumns.has(name)).map(
      (name) => `trade_inbox.${name}`,
    ),
  ];
  const expectedColumns = INBOX_COLUMNS.length * 2;
  const complete =
    presentTables.length === NEW_TABLES.length &&
    presentColumns.length === expectedColumns;
  const fresh =
    presentFeatureTables.length === 0 && presentColumns.length === 0;
  return {
    complete,
    fresh,
    partial: !complete && !fresh,
    present_tables: presentTables,
    present_columns: presentColumns,
    missing_tables: NEW_TABLES.filter((name) => !tables.has(name)),
    missing_columns: [
      ...INBOX_COLUMNS.filter((name) => !incomeColumns.has(name)).map(
        (name) => `income_inbox.${name}`,
      ),
      ...INBOX_COLUMNS.filter((name) => !tradeColumns.has(name)).map(
        (name) => `trade_inbox.${name}`,
      ),
    ],
  };
}

function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      script_sha256 TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      error TEXT NOT NULL DEFAULT ''
    )
  `);
}

function getMigrationRow(db) {
  if (!tableNames(db).has('schema_migrations')) return null;
  return (
    db
      .prepare('SELECT * FROM schema_migrations WHERE id = ?')
      .get(MIGRATION_ID) || null
  );
}

function setMigrationStatus(db, status, options = {}) {
  const stamp = options.startedAt || nowIso();
  db.prepare(`
    INSERT INTO schema_migrations (
      id, script_sha256, status, started_at, completed_at, error
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      script_sha256 = excluded.script_sha256,
      status = excluded.status,
      started_at = CASE
        WHEN excluded.status = 'running' THEN excluded.started_at
        ELSE schema_migrations.started_at
      END,
      completed_at = excluded.completed_at,
      error = excluded.error
  `).run(
    MIGRATION_ID,
    ddlSha256(),
    status,
    stamp,
    status === 'completed' ? options.completedAt || nowIso() : null,
    options.error || '',
  );
}

function migrationStatus(db) {
  const schema = inspectSchema(db);
  const row = getMigrationRow(db);
  return {
    id: MIGRATION_ID,
    schema,
    status: row?.status || null,
    script_sha256: row?.script_sha256 || null,
    current_script_sha256: ddlSha256(),
    started_at: row?.started_at || null,
    completed_at: row?.completed_at || null,
    error: row?.error || '',
  };
}

function ensureDataTrustReady(db, options = {}) {
  const policy = options.migrationPolicy || 'auto';
  const status = migrationStatus(db);
  if (status.status === 'completed' && status.schema.complete) {
    return status;
  }
  if (policy === 'require') {
    throw new Error(
      `数据可信度迁移未完成；请先运行 npm run db:migrate:data-trust（状态：${
        status.status || 'missing'
      }）`,
    );
  }
  if (policy === 'off' || policy === 'defer') return status;
  return runDataTrustMigration(db, {
    ...options,
    apply: true,
  });
}

function sourceClassForDaily(source) {
  if (String(source || '').includes('income-screenshot')) return 'screenshot';
  if (String(source || '').includes('migration')) return 'migration';
  return 'manual';
}

function sourceClassForProduct(source) {
  if (String(source || '').includes('income-screenshot')) return 'screenshot';
  return 'manual';
}

function sourceClassForTrade(trade) {
  if (trade.screenshot_id) return 'screenshot';
  if (String(trade.source || '').includes('migration')) return 'migration';
  return 'manual';
}

function mapDaily(row) {
  return {
    id: Number(row.id),
    record_date: row.record_date,
    principal: Number(row.principal),
    daily_pnl: Number(row.daily_pnl),
    action: row.action,
    notes: row.notes,
    source: row.source,
    screenshot_id:
      row.screenshot_id === null ? null : Number(row.screenshot_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapProductValuation(row) {
  return {
    id: Number(row.id),
    valuation_date: row.valuation_date,
    credit_date: row.credit_date || row.valuation_date,
    yield_date: row.yield_date,
    product_code: row.product_code,
    product_name: row.product_name,
    holding_amount:
      row.holding_amount === null ? null : Number(row.holding_amount),
    daily_pnl: Number(row.daily_pnl),
    source: row.source,
    screenshot_id:
      row.screenshot_id === null ? null : Number(row.screenshot_id),
    confidence: Number(row.confidence || 0),
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapTrade(row) {
  return {
    id: Number(row.id),
    trade_date: row.trade_date,
    confirm_date: row.confirm_date || null,
    trade_type: row.trade_type,
    status: row.status,
    product_code: row.product_code,
    product_name: row.product_name,
    issuer: row.issuer,
    risk_level: row.risk_level,
    target_product_code: row.target_product_code,
    target_product_name: row.target_product_name,
    target_term_days:
      row.target_term_days === null ? null : Number(row.target_term_days),
    target_maturity_date: row.target_maturity_date || null,
    amount: Number(row.amount),
    settlement_amount:
      row.settlement_amount === null ? null : Number(row.settlement_amount),
    shares: row.shares === null ? null : Number(row.shares),
    term_days: row.term_days === null ? null : Number(row.term_days),
    maturity_date: row.maturity_date || null,
    decision_id:
      row.decision_id === null ? null : Number(row.decision_id),
    screenshot_id:
      row.screenshot_id === null ? null : Number(row.screenshot_id),
    source: row.source,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function changedFields(before, after) {
  const keys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {}),
  ]);
  return [...keys].filter(
    (key) =>
      JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]),
  );
}

function rowFingerprint(db, table, columns) {
  const rows = db
    .prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY rowid ASC`)
    .all();
  const hash = crypto.createHash('sha256');
  for (const row of rows) {
    hash.update(`${table}\t${JSON.stringify(row)}\n`);
  }
  return {
    rows: rows.length,
    sha256: hash.digest('hex'),
  };
}

function businessFingerprint(db) {
  return {
    capital_settings: rowFingerprint(db, 'capital_settings', [
      'id',
      'initial_principal',
      'initial_date',
      'note',
      'created_at',
      'updated_at',
    ]),
    capital_events: rowFingerprint(db, 'capital_events', [
      'id',
      'event_date',
      'event_type',
      'amount',
      'note',
      'created_at',
    ]),
    daily_records: rowFingerprint(db, 'daily_records', [
      'id',
      'record_date',
      'principal',
      'daily_pnl',
      'action',
      'notes',
      'source',
      'screenshot_id',
      'created_at',
      'updated_at',
    ]),
    trade_transactions: rowFingerprint(db, 'trade_transactions', [
      'id',
      'trade_date',
      'confirm_date',
      'trade_type',
      'status',
      'product_code',
      'product_name',
      'issuer',
      'risk_level',
      'target_product_code',
      'target_product_name',
      'target_term_days',
      'target_maturity_date',
      'amount',
      'settlement_amount',
      'shares',
      'term_days',
      'maturity_date',
      'decision_id',
      'screenshot_id',
      'source',
      'notes',
      'created_at',
      'updated_at',
    ]),
    product_daily_valuations: rowFingerprint(
      db,
      'product_daily_valuations',
      [
        'id',
        'valuation_date',
        'credit_date',
        'yield_date',
        'product_code',
        'product_name',
        'holding_amount',
        'daily_pnl',
        'source',
        'screenshot_id',
        'confidence',
        'notes',
        'created_at',
        'updated_at',
      ],
    ),
    decision_log: rowFingerprint(db, 'decision_log', [
      'id',
      'decision_date',
      'product_name',
      'action',
      'reason',
      'expectation',
      'invalidation_condition',
      'actual_result',
      'strategy_version',
      'target_annualized',
      'bucket_plan',
      'evaluation_at',
      'evidence_date',
      'verify_date',
      'review_meta',
      'rating',
      'created_at',
      'updated_at',
    ]),
    income_inbox: rowFingerprint(db, 'income_inbox', [
      'id',
      'original_name',
      'stored_name',
      'mime',
      'bytes',
      'sha256',
      'status',
      'ocr_text',
      'parsed_json',
      'parse_confidence',
      'record_date',
      'error',
      'notes',
      'received_at',
      'applied_at',
    ]),
    trade_inbox: rowFingerprint(db, 'trade_inbox', [
      'id',
      'original_name',
      'stored_name',
      'mime',
      'bytes',
      'sha256',
      'status',
      'ocr_text',
      'parsed_json',
      'parse_confidence',
      'duplicate_of',
      'trade_id',
      'error',
      'notes',
      'received_at',
      'applied_at',
    ]),
  };
}

function safeFileAvailable(directory, storedName) {
  if (!directory || !storedName) return false;
  const root = path.resolve(directory);
  const target = path.resolve(root, storedName);
  return (
    target.startsWith(`${root}${path.sep}`) && fs.existsSync(target)
  );
}

function validateEvidenceRows(db) {
  const invalid = [];
  for (const table of ['income_inbox', 'trade_inbox']) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    for (const row of rows) {
      if (!/^[a-f0-9]{64}$/i.test(String(row.sha256 || ''))) {
        invalid.push({
          table,
          id: Number(row.id),
          reason: 'invalid-sha256',
        });
      }
    }
  }
  return invalid;
}

function preflightMigration(db, options = {}) {
  const quick = db.prepare('PRAGMA quick_check').all();
  if (quick.length !== 1 || quick[0].quick_check !== 'ok') {
    throw new Error('迁移前 quick_check 未通过');
  }
  const schema = inspectSchema(db);
  if (schema.partial) {
    throw new Error(
      `检测到部分 schema，拒绝自动继续。缺表：${schema.missing_tables.join(
        ', ',
      )}；缺列：${schema.missing_columns.join(', ')}`,
    );
  }
  const invalidEvidence = validateEvidenceRows(db);
  if (invalidEvidence.length) {
    throw new Error(
      `存在非法证据哈希，拒绝迁移：${invalidEvidence
        .map((item) => `${item.table}#${item.id}`)
        .join(', ')}`,
    );
  }
  return {
    schema,
    fingerprint: businessFingerprint(db),
    row_counts: {
      income_inbox: Number(
        db.prepare('SELECT COUNT(*) AS n FROM income_inbox').get().n,
      ),
      trade_inbox: Number(
        db.prepare('SELECT COUNT(*) AS n FROM trade_inbox').get().n,
      ),
      daily_records: Number(
        db.prepare('SELECT COUNT(*) AS n FROM daily_records').get().n,
      ),
      trade_transactions: Number(
        db.prepare('SELECT COUNT(*) AS n FROM trade_transactions').get().n,
      ),
      product_daily_valuations: Number(
        db
          .prepare('SELECT COUNT(*) AS n FROM product_daily_valuations')
          .get().n,
      ),
      decision_log: Number(
        db.prepare('SELECT COUNT(*) AS n FROM decision_log').get().n,
      ),
    },
    checked_at: nowIso(),
    inbox_dirs: {
      income: options.incomeInboxDir || null,
      trade: options.tradeInboxDir || null,
    },
  };
}

function buildMigrationContext(db, options) {
  const insertAsset = db.prepare(`
    INSERT OR IGNORE INTO evidence_assets (
      evidence_type, source_channel, sha256, original_name,
      storage_namespace, storage_name, mime, bytes, captured_at,
      received_at, available, status, status_reason, created_at
    ) VALUES (?, 'migration', ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'active', '', ?)
  `);
  const selectAsset = db.prepare(`
    SELECT * FROM evidence_assets
    WHERE evidence_type = ? AND sha256 = ?
  `);
  const selectEventByDedupe = db.prepare(`
    SELECT * FROM evidence_events
    WHERE evidence_id = ? AND dedupe_key = ?
  `);
  const selectLatestEvent = db.prepare(`
    SELECT * FROM evidence_events
    WHERE evidence_id = ?
    ORDER BY id DESC
    LIMIT 1
  `);
  const insertEvent = db.prepare(`
    INSERT INTO evidence_events (
      evidence_id, event_type, actor_type, actor_ref, payload_json,
      confidence, dedupe_key, request_id, previous_event_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectRevisionByOperation = db.prepare(`
    SELECT * FROM fact_revisions
    WHERE fact_type = ? AND fact_key = ? AND operation_id = ?
  `);
  const selectLatestRevision = db.prepare(`
    SELECT * FROM fact_revisions
    WHERE fact_type = ? AND fact_key = ?
    ORDER BY revision_no DESC
    LIMIT 1
  `);
  const insertRevision = db.prepare(`
    INSERT INTO fact_revisions (
      fact_type, fact_key, revision_no, action, before_json, after_json,
      changed_fields_json, reason, source_class, actor_type, actor_ref,
      operation_id, request_id, related_fact_type, related_fact_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'migration', ?, ?, ?, ?, ?, ?)
  `);
  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO fact_evidence_links (
      fact_type, fact_key, fact_revision_id, evidence_id, evidence_event_id,
      role, field_paths_json, confidence, link_status, created_at,
      retired_at, retire_reason
    ) VALUES (?, ?, ?, ?, ?, 'primary', ?, NULL, 'active', ?, NULL, '')
  `);

  function ensureEvent(input) {
    if (input.dedupe_key) {
      const existing = selectEventByDedupe.get(
        input.evidence_id,
        input.dedupe_key,
      );
      if (existing) return existing;
    }
    const previous = selectLatestEvent.get(input.evidence_id);
    const result = insertEvent.run(
      input.evidence_id,
      input.event_type,
      input.actor_type || 'migration',
      input.actor_ref || 'data-trust-v1',
      jsonText(input.payload),
      input.confidence ?? null,
      input.dedupe_key || '',
      input.request_id || '',
      previous?.id ?? null,
      input.created_at || nowIso(),
    );
    return db
      .prepare('SELECT * FROM evidence_events WHERE id = ?')
      .get(Number(result.lastInsertRowid));
  }

  function ensureRevision(input) {
    const existing = selectRevisionByOperation.get(
      input.factType,
      input.factKey,
      input.operationId,
    );
    if (existing) return existing;
    const latest = selectLatestRevision.get(input.factType, input.factKey);
    const before = input.before || {};
    const after = input.after || {};
    const revisionNo = Number(latest?.revision_no || 0) + 1;
    const result = insertRevision.run(
      input.factType,
      input.factKey,
      revisionNo,
      input.action || (latest ? 'update' : 'create'),
      jsonText(before),
      jsonText(after),
      jsonText(changedFields(before, after)),
      input.reason || '迁移基线：导入当前正式事实',
      input.sourceClass || 'migration',
      input.actorRef || 'data-trust-v1',
      input.operationId,
      input.requestId || `migration:${MIGRATION_ID}`,
      input.relatedFactType || '',
      input.relatedFactKey || '',
      input.createdAt || nowIso(),
    );
    return db
      .prepare('SELECT * FROM fact_revisions WHERE id = ?')
      .get(Number(result.lastInsertRowid));
  }

  function ensureLink(input) {
    const latest = selectLatestRevision.get(input.factType, input.factKey);
    if (!latest) return null;
    insertLink.run(
      input.factType,
      input.factKey,
      latest.id,
      input.evidenceId,
      input.evidenceEventId,
      jsonText(input.fieldPaths || []),
      input.createdAt || nowIso(),
    );
    return latest;
  }

  function migrateInbox(table, evidenceType, storageNamespace, directory) {
    const rows = db
      .prepare(`SELECT * FROM ${table} ORDER BY id ASC`)
      .all();
    const update = db.prepare(`
      UPDATE ${table}
      SET evidence_id = ?, selected_event_id = ?, workflow_state = ?,
          state_version = 1, last_request_id = ?
      WHERE id = ?
    `);
    for (const row of rows) {
      const available = safeFileAvailable(directory, row.stored_name);
      insertAsset.run(
        evidenceType,
        row.sha256,
        row.original_name || '',
        storageNamespace,
        row.stored_name || '',
        row.mime || '',
        Number(row.bytes || 0),
        row.received_at,
        available ? 1 : 0,
        row.received_at,
      );
      const asset = selectAsset.get(evidenceType, row.sha256);
      if (!asset) throw new Error(`${table}#${row.id} 证据资产创建失败`);
      const snapshot = ensureEvent({
        evidence_id: asset.id,
        event_type: 'legacy_snapshot',
        payload: {
          original_name: row.original_name || '',
          mime: row.mime || '',
          bytes: Number(row.bytes || 0),
          sha256: row.sha256,
          ocr_text: row.ocr_text || '',
          parsed_json_raw: row.parsed_json || '{}',
          parse_confidence: Number(row.parse_confidence || 0),
          legacy_status: row.status,
          record_date: row.record_date || null,
          duplicate_of:
            row.duplicate_of === null || row.duplicate_of === undefined
              ? null
              : Number(row.duplicate_of),
          trade_id:
            row.trade_id === null || row.trade_id === undefined
              ? null
              : Number(row.trade_id),
          error: row.error || '',
          notes: row.notes || '',
          provenance: 'legacy-unknown',
          message:
            '历史 parsed_json 可能已被人工校正覆盖，无法还原原始解析版本',
        },
        confidence: Number(row.parse_confidence || 0),
        dedupe_key: `legacy:${row.sha256}`,
        created_at: row.received_at,
      });
      const workflowState =
        LEGACY_STATUS_STATE[row.status] || 'needs_correction';
      update.run(
        asset.id,
        snapshot.id,
        workflowState,
        `migration:${MIGRATION_ID}`,
        row.id,
      );
      ensureEvent({
        evidence_id: asset.id,
        event_type: 'state_changed',
        payload: {
          from_state: 'legacy-unknown',
          to_state: workflowState,
          legacy_status: row.status,
          reason: `迁移自旧 status=${row.status}，历史内部状态不可精确还原`,
        },
        dedupe_key: `legacy-state:${table}:${row.id}:${row.status}`,
        created_at: row.applied_at || row.received_at,
      });
    }
    return rows.length;
  }

  return {
    insertAsset,
    selectAsset,
    ensureEvent,
    ensureRevision,
    ensureLink,
    migrateInbox,
    selectLatestRevision,
  };
}

function migrateBaselineFacts(db, context) {
  const allDaily = db
    .prepare('SELECT * FROM daily_records ORDER BY id ASC')
    .all();
  for (const raw of allDaily) {
    const row = mapDaily(raw);
    context.ensureRevision({
      factType: 'account_income',
      factKey: `account_income:${row.id}`,
      action: 'create',
      before: {},
      after: row,
      sourceClass: sourceClassForDaily(row.source),
      operationId: `legacy-baseline-v1:account_income:${row.id}`,
      createdAt: row.created_at,
    });
    context.ensureRevision({
      factType: 'principal_snapshot',
      factKey: `principal_snapshot:${row.id}`,
      action: 'recalculate',
      before: {},
      after: {
        record_date: row.record_date,
        principal: row.principal,
      },
      sourceClass: 'derived',
      operationId: `legacy-baseline-v1:principal_snapshot:${row.id}`,
      createdAt: row.updated_at,
      relatedFactType: 'account_income',
      relatedFactKey: `account_income:${row.id}`,
    });
  }

  const settings = db.prepare('SELECT * FROM capital_settings').all();
  for (const row of settings) {
    context.ensureRevision({
      factType: 'capital_initial',
      factKey: `capital_initial:${row.id}`,
      action: 'create',
      before: {},
      after: {
        id: Number(row.id),
        initial_principal: Number(row.initial_principal),
        initial_date: row.initial_date,
        note: row.note || '',
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      sourceClass: String(row.note || '').includes('自动')
        ? 'migration'
        : 'manual',
      operationId: `legacy-baseline-v1:capital_initial:${row.id}`,
      createdAt: row.created_at,
    });
  }

  const capitalEvents = db
    .prepare('SELECT * FROM capital_events ORDER BY id ASC')
    .all();
  for (const row of capitalEvents) {
    context.ensureRevision({
      factType: 'capital_event',
      factKey: `capital_event:${row.id}`,
      action: 'create',
      before: {},
      after: {
        id: Number(row.id),
        event_date: row.event_date,
        event_type: row.event_type,
        amount: Number(row.amount),
        note: row.note || '',
        created_at: row.created_at,
      },
      sourceClass: String(row.note || '').includes('自动迁移')
        ? 'migration'
        : 'manual',
      operationId: `legacy-baseline-v1:capital_event:${row.id}`,
      createdAt: row.created_at,
    });
  }

  const trades = db
    .prepare('SELECT * FROM trade_transactions ORDER BY id ASC')
    .all();
  const tradeAudits = db.prepare(`
    SELECT * FROM trade_audit
    WHERE trade_id = ?
    ORDER BY created_at ASC, id ASC
  `);
  for (const raw of trades) {
    const trade = mapTrade(raw);
    const audits = tradeAudits.all(trade.id);
    let latestAfter = {};
    for (const audit of audits) {
      const before = parseJson(audit.before_json, {});
      const after = parseJson(audit.after_json, {});
      context.ensureRevision({
        factType: 'trade',
        factKey: `trade:${trade.id}`,
        action: ['create', 'update', 'confirm', 'cancel'].includes(
          audit.action,
        )
          ? audit.action
          : 'update',
        before,
        after,
        sourceClass: sourceClassForTrade(trade),
        operationId: `legacy-trade-audit:${audit.id}`,
        createdAt: audit.created_at,
        actorRef: `legacy-trade-audit:${audit.id}`,
      });
      latestAfter = after;
    }
    if (
      !audits.length ||
      JSON.stringify(latestAfter) !== JSON.stringify(trade)
    ) {
      context.ensureRevision({
        factType: 'trade',
        factKey: `trade:${trade.id}`,
        action: audits.length ? 'recalculate' : 'create',
        before: latestAfter,
        after: trade,
        sourceClass: sourceClassForTrade(trade),
        operationId: `legacy-baseline-v1:trade:${trade.id}`,
        createdAt: trade.updated_at || trade.created_at,
      });
    }
  }

  const valuations = db
    .prepare('SELECT * FROM product_daily_valuations ORDER BY id ASC')
    .all();
  const valuationAudits = db.prepare(`
    SELECT * FROM product_daily_valuation_audit
    WHERE valuation_id = ?
    ORDER BY created_at ASC, id ASC
  `);
  for (const raw of valuations) {
    const valuation = mapProductValuation(raw);
    const audits = valuationAudits.all(valuation.id);
    let latestAfter = {};
    for (const audit of audits) {
      const before = parseJson(audit.before_json, {});
      const after = parseJson(audit.after_json, {});
      context.ensureRevision({
        factType: 'product_income',
        factKey: `product_income:${valuation.id}`,
        action: audit.action === 'update' ? 'update' : 'create',
        before,
        after,
        sourceClass: sourceClassForProduct(audit.source || valuation.source),
        operationId: `legacy-product-audit:${audit.id}`,
        createdAt: audit.created_at,
        actorRef: `legacy-product-audit:${audit.id}`,
      });
      latestAfter = after;
    }
    if (
      !audits.length ||
      JSON.stringify(latestAfter) !== JSON.stringify(valuation)
    ) {
      context.ensureRevision({
        factType: 'product_income',
        factKey: `product_income:${valuation.id}`,
        action: audits.length ? 'recalculate' : 'create',
        before: latestAfter,
        after: valuation,
        sourceClass: sourceClassForProduct(valuation.source),
        operationId: `legacy-baseline-v1:product_income:${valuation.id}`,
        createdAt: valuation.updated_at || valuation.created_at,
      });
    }
  }

  const yieldSettings = db
    .prepare('SELECT * FROM product_yield_settings ORDER BY product_code ASC')
    .all();
  for (const setting of yieldSettings) {
    context.ensureRevision({
      factType: 'product_yield_setting',
      factKey: `product_yield_setting:${setting.product_code}`,
      action: 'create',
      before: {},
      after: {
        product_code: setting.product_code,
        yield_lag_days: Number(setting.yield_lag_days),
        source: setting.source,
        notes: setting.notes,
        verified_at: setting.verified_at,
        updated_at: setting.updated_at,
      },
      sourceClass: setting.source === 'default' ? 'derived' : 'document',
      operationId: `legacy-baseline-v1:product_yield_setting:${setting.product_code}`,
      createdAt: setting.updated_at,
    });
  }

  const decisions = db
    .prepare('SELECT * FROM decision_log ORDER BY id ASC')
    .all();
  for (const row of decisions) {
    const reviewMeta = parseJson(row.review_meta, {});
    context.ensureRevision({
      factType: 'decision',
      factKey: `decision:${row.id}`,
      action: 'create',
      before: {},
      after: {
        id: Number(row.id),
        decision_date: row.decision_date,
        product_name: row.product_name,
        action: row.action,
        reason: row.reason,
        expectation: row.expectation,
        invalidation_condition: row.invalidation_condition,
        strategy_version: row.strategy_version,
        target_annualized: Number(row.target_annualized),
        bucket_plan: parseJson(row.bucket_plan, {}),
        evaluation_at: row.evaluation_at,
        evidence_date: row.evidence_date,
        verify_date: row.verify_date,
        review_meta: reviewMeta,
        rating: row.rating,
        actual_result: row.actual_result,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      sourceClass: String(reviewMeta.source || '').includes('auto')
        ? 'automation'
        : 'manual',
      operationId: `legacy-baseline-v1:decision:${row.id}`,
      createdAt: row.created_at,
    });
  }

  const proposals = db
    .prepare('SELECT * FROM decision_proposals ORDER BY id ASC')
    .all();
  for (const row of proposals) {
    context.ensureRevision({
      factType: 'proposal',
      factKey: `proposal:${row.id}`,
      action: 'create',
      before: {},
      after: {
        id: Number(row.id),
        dedupe_key: row.dedupe_key,
        proposal_type: row.proposal_type,
        title: row.title,
        status: row.status,
        amount: Number(row.amount),
        confidence: Number(row.confidence),
        decision_id:
          row.decision_id === null ? null : Number(row.decision_id),
        payload: parseJson(row.payload_json, {}),
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      sourceClass: 'automation',
      operationId: `legacy-baseline-v1:proposal:${row.id}`,
      createdAt: row.created_at,
    });
  }

  const evaluations = db
    .prepare('SELECT * FROM evaluation_runs ORDER BY id ASC')
    .all();
  for (const row of evaluations) {
    context.ensureRevision({
      factType: 'evaluation',
      factKey: `evaluation:${row.id}`,
      action: 'create',
      before: {},
      after: {
        id: Number(row.id),
        dedupe_key: row.dedupe_key,
        scope: row.scope,
        decision_id:
          row.decision_id === null ? null : Number(row.decision_id),
        trade_id: row.trade_id === null ? null : Number(row.trade_id),
        stage: row.stage,
        period: row.period,
        evaluated_for: row.evaluated_for,
        rule_version: row.rule_version,
        confidence: Number(row.confidence),
        outcome: row.outcome,
        rating: row.rating,
        status: row.status,
        source: row.source,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      sourceClass: 'automation',
      operationId: `legacy-baseline-v1:evaluation:${row.id}`,
      createdAt: row.created_at,
    });
  }
}

function backfillEvidenceLinks(db, context) {
  const diagnostics = [];
  const inboxMaps = {
    income: new Map(
      db
        .prepare(
          'SELECT id, evidence_id, selected_event_id FROM income_inbox',
        )
        .all()
        .map((row) => [Number(row.id), row]),
    ),
    trade: new Map(
      db
        .prepare(
          'SELECT id, evidence_id, selected_event_id FROM trade_inbox',
        )
        .all()
        .map((row) => [Number(row.id), row]),
    ),
  };
  const daily = db.prepare('SELECT * FROM daily_records ORDER BY id ASC').all();
  for (const row of daily) {
    if (!row.screenshot_id) continue;
    const inbox = inboxMaps.income.get(Number(row.screenshot_id));
    if (!inbox?.evidence_id || !inbox?.selected_event_id) {
      diagnostics.push({
        type: 'orphan-evidence-pointer',
        fact_type: 'account_income',
        fact_key: `account_income:${row.id}`,
        screenshot_id: Number(row.screenshot_id),
      });
      continue;
    }
    context.ensureLink({
      factType: 'account_income',
      factKey: `account_income:${row.id}`,
      evidenceId: Number(inbox.evidence_id),
      evidenceEventId: Number(inbox.selected_event_id),
      fieldPaths: ['date', 'daily_pnl'],
      createdAt: row.updated_at || row.created_at,
    });
  }

  const valuations = db
    .prepare('SELECT * FROM product_daily_valuations ORDER BY id ASC')
    .all();
  for (const row of valuations) {
    if (!row.screenshot_id) continue;
    const inbox = inboxMaps.income.get(Number(row.screenshot_id));
    if (!inbox?.evidence_id || !inbox?.selected_event_id) {
      diagnostics.push({
        type: 'orphan-evidence-pointer',
        fact_type: 'product_income',
        fact_key: `product_income:${row.id}`,
        screenshot_id: Number(row.screenshot_id),
      });
      continue;
    }
    context.ensureLink({
      factType: 'product_income',
      factKey: `product_income:${row.id}`,
      evidenceId: Number(inbox.evidence_id),
      evidenceEventId: Number(inbox.selected_event_id),
      fieldPaths: [
        'yield_date',
        'credit_date',
        'daily_pnl',
        'holding_amount',
      ],
      createdAt: row.updated_at || row.created_at,
    });
  }

  const trades = db
    .prepare('SELECT * FROM trade_transactions ORDER BY id ASC')
    .all();
  for (const row of trades) {
    if (!row.screenshot_id) continue;
    const inbox = inboxMaps.trade.get(Number(row.screenshot_id));
    if (!inbox?.evidence_id || !inbox?.selected_event_id) {
      diagnostics.push({
        type: 'orphan-evidence-pointer',
        fact_type: 'trade',
        fact_key: `trade:${row.id}`,
        screenshot_id: Number(row.screenshot_id),
      });
      continue;
    }
    context.ensureLink({
      factType: 'trade',
      factKey: `trade:${row.id}`,
      evidenceId: Number(inbox.evidence_id),
      evidenceEventId: Number(inbox.selected_event_id),
      fieldPaths: [
        'trade_date',
        'trade_type',
        'product_code',
        'amount',
        'status',
      ],
      createdAt: row.updated_at || row.created_at,
    });
  }
  return diagnostics;
}

function verifyMigration(db, options = {}) {
  const schema = inspectSchema(db);
  const migration = getMigrationRow(db);
  const quick = db.prepare('PRAGMA quick_check').all();
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  const missingEvidence = {};
  const missingEvents = {};
  for (const table of ['income_inbox', 'trade_inbox']) {
    missingEvidence[table] = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${table} WHERE evidence_id IS NULL`,
        )
        .get().n,
    );
    missingEvents[table] = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${table}
           WHERE evidence_id IS NOT NULL
             AND (selected_event_id IS NULL OR NOT EXISTS (
               SELECT 1 FROM evidence_events e
               WHERE e.id = ${table}.selected_event_id
                 AND e.evidence_id = ${table}.evidence_id
             ))`,
        )
        .get().n,
    );
  }
  const orphanRows = db
    .prepare(`
      SELECT COUNT(*) AS n
      FROM fact_evidence_links l
      LEFT JOIN fact_revisions r ON r.id = l.fact_revision_id
      LEFT JOIN evidence_assets a ON a.id = l.evidence_id
      LEFT JOIN evidence_events e ON e.id = l.evidence_event_id
      WHERE r.id IS NULL OR a.id IS NULL OR e.id IS NULL
        OR e.evidence_id <> l.evidence_id
    `)
    .get().n;
  const currentFingerprint = businessFingerprint(db);
  const fingerprintMatch =
    !options.beforeFingerprint ||
    JSON.stringify(options.beforeFingerprint) ===
      JSON.stringify(currentFingerprint);
  const report = {
    migration_id: MIGRATION_ID,
    checked_at: nowIso(),
    schema,
    migration_status: migration?.status || null,
    script_hash_match:
      migration?.script_sha256 === ddlSha256(),
    quick_check: quick,
    foreign_key_check: foreignKeys,
    missing_evidence: missingEvidence,
    missing_events: missingEvents,
    orphan_link_rows: Number(orphanRows),
    business_fingerprint: currentFingerprint,
    business_fingerprint_match: fingerprintMatch,
    counts: {
      evidence_assets: Number(
        db.prepare('SELECT COUNT(*) AS n FROM evidence_assets').get().n,
      ),
      evidence_events: Number(
        db.prepare('SELECT COUNT(*) AS n FROM evidence_events').get().n,
      ),
      fact_revisions: Number(
        db.prepare('SELECT COUNT(*) AS n FROM fact_revisions').get().n,
      ),
      fact_evidence_links: Number(
        db
          .prepare('SELECT COUNT(*) AS n FROM fact_evidence_links')
          .get().n,
      ),
    },
  };
  report.ok =
    schema.complete &&
    migration?.status === 'completed' &&
    report.script_hash_match &&
    quick.length === 1 &&
    quick[0].quick_check === 'ok' &&
    foreignKeys.length === 0 &&
    Object.values(missingEvidence).every((value) => value === 0) &&
    Object.values(missingEvents).every((value) => value === 0) &&
    report.orphan_link_rows === 0 &&
    report.business_fingerprint_match;
  if (!report.ok && options.throwOnError !== false) {
    throw new Error(`数据可信度迁移验证失败：${JSON.stringify(report)}`);
  }
  return report;
}

function runDataTrustMigration(db, options = {}) {
  const current = migrationStatus(db);
  if (current.status === 'completed' && current.schema.complete) {
    return {
      status: current,
      report: verifyMigration(db, { throwOnError: false }),
      applied: false,
    };
  }
  const preflight = preflightMigration(db, options);
  if (options.apply !== true) {
    return { status: current, preflight, applied: false };
  }
  ensureMigrationTable(db);
  const startedAt = nowIso();
  setMigrationStatus(db, 'running', { startedAt });
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!current.schema.complete) db.exec(ddlText());
      const context = buildMigrationContext(db, options);
      context.migrateInbox(
        'income_inbox',
        'income-screenshot',
        'income-inbox',
        options.incomeInboxDir ||
          path.join(path.dirname(options.dbPath || ''), 'income-inbox'),
      );
      context.migrateInbox(
        'trade_inbox',
        'trade-screenshot',
        'trade-inbox',
        options.tradeInboxDir ||
          path.join(path.dirname(options.dbPath || ''), 'trade-inbox'),
      );
      migrateBaselineFacts(db, context);
      const diagnostics = backfillEvidenceLinks(db, context);
      const completedAt = nowIso();
      db.prepare(`
        UPDATE schema_migrations
        SET status = 'completed', completed_at = ?, error = '',
            script_sha256 = ?
        WHERE id = ?
      `).run(completedAt, ddlSha256(), MIGRATION_ID);
      db.exec('COMMIT');
      const report = verifyMigration(db, {
        beforeFingerprint: preflight.fingerprint,
        throwOnError: true,
      });
      return {
        status: migrationStatus(db),
        preflight,
        report,
        diagnostics,
        applied: true,
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    try {
      setMigrationStatus(db, 'failed', {
        startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }
}

module.exports = {
  DDL_PATH,
  LEGACY_STATUS_STATE,
  MIGRATION_ID,
  NEW_TABLES,
  INBOX_COLUMNS,
  businessFingerprint,
  ddlSha256,
  ensureDataTrustReady,
  ensureMigrationTable,
  getMigrationRow,
  inspectSchema,
  migrationStatus,
  preflightMigration,
  runDataTrustMigration,
  verifyMigration,
};
