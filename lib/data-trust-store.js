'use strict';

const crypto = require('node:crypto');
const { createTransactionManager } = require('./transaction');

const INBOX_TYPES = {
  income: {
    table: 'income_inbox',
    evidenceType: 'income-screenshot',
    storageNamespace: 'income-inbox',
    factType: 'account_income',
  },
  trade: {
    table: 'trade_inbox',
    evidenceType: 'trade-screenshot',
    storageNamespace: 'trade-inbox',
    factType: 'trade',
  },
};

const WORKFLOW_STATUS = {
  received: 'pending',
  needs_correction: 'pending',
  ready_to_post: 'pending',
  posted: 'applied',
  conflict_pending: 'pending',
  duplicate_resolved: 'applied',
  ignored: 'ignored',
  failed_retryable: 'pending',
};

const ALLOWED_TRANSITIONS = {
  received: ['needs_correction', 'ready_to_post', 'failed_retryable', 'ignored'],
  needs_correction: ['ready_to_post', 'failed_retryable', 'ignored'],
  ready_to_post: [
    'posted',
    'duplicate_resolved',
    'conflict_pending',
    'needs_correction',
    'failed_retryable',
    'ignored',
  ],
  conflict_pending: [
    'ready_to_post',
    'needs_correction',
    'duplicate_resolved',
    'ignored',
  ],
  failed_retryable: ['needs_correction', 'ready_to_post', 'ignored'],
  posted: [],
  duplicate_resolved: [],
  ignored: [],
};

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || '') ?? fallback;
  } catch {
    return fallback;
  }
}

function jsonText(value, fallback) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
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

function evidenceHash(value) {
  const text = String(value || '').trim();
  if (/^[a-f0-9]{64}$/i.test(text)) return text.toLowerCase();
  return crypto
    .createHash('sha256')
    .update(`compat-evidence:${text}`)
    .digest('hex');
}

function mapEvidence(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    evidence_type: row.evidence_type,
    source_channel: row.source_channel,
    sha256: row.sha256,
    original_name: row.original_name || '',
    storage_namespace: row.storage_namespace || '',
    storage_name: row.storage_name || '',
    mime: row.mime || '',
    bytes: Number(row.bytes || 0),
    captured_at: row.captured_at || null,
    received_at: row.received_at,
    available: Boolean(row.available),
    status: row.status,
    status_reason: row.status_reason || '',
    created_at: row.created_at,
  };
}

function mapEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    evidence_id: Number(row.evidence_id),
    event_type: row.event_type,
    actor_type: row.actor_type,
    actor_ref: row.actor_ref || '',
    payload: parseJson(row.payload_json, {}),
    confidence:
      row.confidence === null || row.confidence === undefined
        ? null
        : Number(row.confidence),
    dedupe_key: row.dedupe_key || '',
    request_id: row.request_id || '',
    previous_event_id:
      row.previous_event_id === null || row.previous_event_id === undefined
        ? null
        : Number(row.previous_event_id),
    created_at: row.created_at,
  };
}

function mapRevision(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    fact_type: row.fact_type,
    fact_key: row.fact_key,
    revision_no: Number(row.revision_no),
    action: row.action,
    before: parseJson(row.before_json, {}),
    after: parseJson(row.after_json, {}),
    changed_fields: parseJson(row.changed_fields_json, []),
    reason: row.reason || '',
    source_class: row.source_class,
    actor_type: row.actor_type,
    actor_ref: row.actor_ref || '',
    operation_id: row.operation_id,
    request_id: row.request_id || '',
    related_fact_type: row.related_fact_type || '',
    related_fact_key: row.related_fact_key || '',
    created_at: row.created_at,
  };
}

function mapLink(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    fact_type: row.fact_type,
    fact_key: row.fact_key,
    fact_revision_id: Number(row.fact_revision_id),
    evidence_id: Number(row.evidence_id),
    evidence_event_id: Number(row.evidence_event_id),
    role: row.role,
    field_paths: parseJson(row.field_paths_json, []),
    confidence:
      row.confidence === null || row.confidence === undefined
        ? null
        : Number(row.confidence),
    link_status: row.link_status,
    created_at: row.created_at,
    retired_at: row.retired_at || null,
    retire_reason: row.retire_reason || '',
    evidence: row.original_name === undefined
      ? undefined
      : {
          original_name: row.original_name || '',
          sha256: row.sha256,
          available: Boolean(row.available),
          evidence_type: row.evidence_type,
          storage_namespace: row.storage_namespace || '',
          storage_name: row.storage_name || '',
        },
    evidence_event: row.event_type
      ? {
          event_type: row.event_type,
          actor_type: row.actor_type,
          actor_ref: row.actor_ref || '',
          payload: parseJson(row.event_payload_json, {}),
          confidence:
            row.event_confidence === null ||
            row.event_confidence === undefined
              ? null
              : Number(row.event_confidence),
          created_at: row.event_created_at,
        }
      : undefined,
  };
}

function createDataTrustStore(db, options = {}) {
  const transactionManager =
    options.transactionManager || createTransactionManager(db);
  const mode = String(options.mode || 'shadow').toLowerCase();
  if (!['shadow', 'enforce', 'off'].includes(mode)) {
    throw new Error(`未知数据可信度模式：${mode}`);
  }
  const enabled = mode !== 'off';

  const selectAssetById = db.prepare(
    'SELECT * FROM evidence_assets WHERE id = ?',
  );
  const selectAssetByHash = db.prepare(`
    SELECT * FROM evidence_assets
    WHERE evidence_type = ? AND sha256 = ?
  `);
  const insertAsset = db.prepare(`
    INSERT OR IGNORE INTO evidence_assets (
      evidence_type, source_channel, sha256, original_name,
      storage_namespace, storage_name, mime, bytes, captured_at,
      received_at, available, status, status_reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectEvent = db.prepare('SELECT * FROM evidence_events WHERE id = ?');
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
  const selectInboxIncome = db.prepare(
    'SELECT * FROM income_inbox WHERE id = ?',
  );
  const selectInboxTrade = db.prepare(
    'SELECT * FROM trade_inbox WHERE id = ?',
  );
  const updateIncomeInboxLineage = db.prepare(`
    UPDATE income_inbox
    SET evidence_id = ?, selected_event_id = ?, workflow_state = ?,
        state_version = state_version + 1, last_request_id = ?,
        status = ?
    WHERE id = ?
  `);
  const updateTradeInboxLineage = db.prepare(`
    UPDATE trade_inbox
    SET evidence_id = ?, selected_event_id = ?, workflow_state = ?,
        state_version = state_version + 1, last_request_id = ?,
        status = ?
    WHERE id = ?
  `);
  const selectLatestRevision = db.prepare(`
    SELECT * FROM fact_revisions
    WHERE fact_type = ? AND fact_key = ?
    ORDER BY revision_no DESC
    LIMIT 1
  `);
  const selectRevisionByOperation = db.prepare(`
    SELECT * FROM fact_revisions
    WHERE fact_type = ? AND fact_key = ? AND operation_id = ?
  `);
  const insertRevision = db.prepare(`
    INSERT INTO fact_revisions (
      fact_type, fact_key, revision_no, action, before_json, after_json,
      changed_fields_json, reason, source_class, actor_type, actor_ref,
      operation_id, request_id, related_fact_type, related_fact_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectRevision = db.prepare('SELECT * FROM fact_revisions WHERE id = ?');
  const selectLink = db.prepare(`
    SELECT * FROM fact_evidence_links
    WHERE fact_revision_id = ? AND evidence_id = ?
      AND evidence_event_id = ? AND role = ?
  `);
  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO fact_evidence_links (
      fact_type, fact_key, fact_revision_id, evidence_id, evidence_event_id,
      role, field_paths_json, confidence, link_status, created_at,
      retired_at, retire_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, '')
  `);
  const retireLinks = db.prepare(`
    UPDATE fact_evidence_links
    SET link_status = 'superseded', retired_at = ?, retire_reason = ?
    WHERE fact_type = ? AND fact_key = ? AND link_status = 'active'
  `);
  const selectFactLinks = db.prepare(`
    SELECT l.*, a.original_name, a.sha256, a.available, a.evidence_type,
      a.storage_namespace, a.storage_name, e.event_type,
      e.actor_type AS actor_type, e.actor_ref AS actor_ref,
      e.payload_json AS event_payload_json,
      e.confidence AS event_confidence, e.created_at AS event_created_at
    FROM fact_evidence_links l
    JOIN evidence_assets a ON a.id = l.evidence_id
    JOIN evidence_events e ON e.id = l.evidence_event_id
    WHERE l.fact_type = ? AND l.fact_key = ?
    ORDER BY l.id ASC
  `);
  const selectRevisionHistory = db.prepare(`
    SELECT * FROM fact_revisions
    WHERE fact_type = ? AND fact_key = ?
    ORDER BY revision_no DESC
  `);
  const selectEvidenceEvents = db.prepare(`
    SELECT * FROM evidence_events
    WHERE evidence_id = ?
    ORDER BY id ASC
  `);
  const selectEvidenceLinks = db.prepare(`
    SELECT l.*, r.action, r.after_json, r.created_at AS revision_created_at
    FROM fact_evidence_links l
    JOIN fact_revisions r ON r.id = l.fact_revision_id
    WHERE l.evidence_id = ?
    ORDER BY l.id ASC
  `);
  const selectIncomeInboxByEvidence = db.prepare(`
    SELECT id FROM income_inbox WHERE evidence_id = ? LIMIT 1
  `);
  const selectTradeInboxByEvidence = db.prepare(`
    SELECT id FROM trade_inbox WHERE evidence_id = ? LIMIT 1
  `);

  function inboxType(kind) {
    const type = INBOX_TYPES[kind];
    if (!type) throw new Error(`未知收件箱类型：${kind}`);
    return type;
  }

  function getInboxRow(kind, id) {
    const type = inboxType(kind);
    return (
      (type.table === 'income_inbox' ? selectInboxIncome : selectInboxTrade)
        .get(id) || null
    );
  }

  function getEvidenceAsset(id) {
    return mapEvidence(selectAssetById.get(id));
  }

  function getEvidenceByHash(evidenceType, sha256) {
    return mapEvidence(selectAssetByHash.get(evidenceType, sha256));
  }

  function recordEvidenceAsset(input) {
    const stamp = input.created_at || new Date().toISOString();
    insertAsset.run(
      input.evidence_type,
      input.source_channel || 'web-upload',
      input.sha256,
      input.original_name || '',
      input.storage_namespace || '',
      input.storage_name || '',
      input.mime || '',
      Number(input.bytes || 0),
      input.captured_at || null,
      input.received_at || stamp,
      input.available === false ? 0 : 1,
      input.status || 'active',
      input.status_reason || '',
      stamp,
    );
    return getEvidenceByHash(input.evidence_type, input.sha256);
  }

  function appendEvent(input) {
    if (!enabled) return null;
    const existing =
      input.dedupe_key
        ? selectEventByDedupe.get(input.evidence_id, input.dedupe_key)
        : null;
    if (existing) return mapEvent(existing);
    const previous = selectLatestEvent.get(input.evidence_id);
    const result = insertEvent.run(
      input.evidence_id,
      input.event_type,
      input.actor_type || 'system',
      input.actor_ref || '',
      jsonText(input.payload, {}),
      input.confidence === null || input.confidence === undefined
        ? null
        : Number(input.confidence),
      input.dedupe_key || '',
      input.request_id || '',
      input.previous_event_id ?? previous?.id ?? null,
      input.created_at || new Date().toISOString(),
    );
    return mapEvent(selectEvent.get(Number(result.lastInsertRowid)));
  }

  function getEvent(id) {
    return mapEvent(selectEvent.get(id));
  }

  function forceInboxLineage(kind, id, input) {
    const type = inboxType(kind);
    const row = getInboxRow(kind, id);
    if (!row) throw new Error(`没有找到${kind}截图 #${id}`);
    const nextState = input.workflowState || row.workflow_state;
    const nextStatus =
      input.legacyStatus || WORKFLOW_STATUS[nextState] || row.status;
    const statement =
      type.table === 'income_inbox'
        ? updateIncomeInboxLineage
        : updateTradeInboxLineage;
    statement.run(
      input.evidenceId ?? row.evidence_id,
      input.selectedEventId ?? row.selected_event_id,
      nextState,
      input.requestId || row.last_request_id || '',
      nextStatus,
      id,
    );
    return getInboxRow(kind, id);
  }

  function registerInboxEvidence(kind, id, input = {}) {
    if (!enabled) return getInboxRow(kind, id);
    const type = inboxType(kind);
    const row = getInboxRow(kind, id);
    if (!row) throw new Error(`没有找到${kind}截图 #${id}`);
    const asset = recordEvidenceAsset({
      evidence_type: input.evidenceType || type.evidenceType,
      source_channel: input.sourceChannel || 'web-upload',
      sha256: evidenceHash(row.sha256),
      original_name: row.original_name,
      storage_namespace:
        input.storageNamespace || type.storageNamespace,
      storage_name: row.stored_name,
      mime: row.mime,
      bytes: row.bytes,
      captured_at: input.capturedAt || null,
      received_at: row.received_at,
      available: input.available !== false,
      status: 'active',
      created_at: row.received_at,
    });
    const received = appendEvent({
      evidence_id: asset.id,
      event_type: 'received',
      actor_type: input.actorType || 'system',
      actor_ref: input.actorRef || '',
      payload: {
        original_name: row.original_name,
        mime: row.mime,
        bytes: Number(row.bytes || 0),
        sha256: row.sha256,
        evidence_sha256: evidenceHash(row.sha256),
      },
      request_id: input.requestId || '',
      dedupe_key: `received:${asset.id}`,
      created_at: row.received_at,
    });
    let selectedEventId = received?.id || null;
    for (const event of input.events || []) {
      const saved = appendEvent({
        ...event,
        evidence_id: asset.id,
        request_id: event.request_id || input.requestId || '',
      });
      if (!saved) continue;
      if (
        ['machine_parsed', 'vision_parsed', 'human_corrected'].includes(
          saved.event_type,
        )
      ) {
        selectedEventId = saved.id;
      }
    }
    return forceInboxLineage(kind, id, {
      evidenceId: asset.id,
      selectedEventId,
      workflowState: input.workflowState || 'received',
      legacyStatus: input.legacyStatus,
      requestId: input.requestId || '',
    });
  }

  function appendInboxEvent(kind, id, event, input = {}) {
    if (!enabled) return null;
    const row = getInboxRow(kind, id);
    if (!row?.evidence_id) {
      throw new Error(`${kind}截图 #${id} 缺少统一证据 ID`);
    }
    return appendEvent({
      ...event,
      evidence_id: row.evidence_id,
      request_id: event.request_id || input.requestId || '',
    });
  }

  function selectInboxEvent(kind, id, event) {
    const row = getInboxRow(kind, id);
    if (!row?.evidence_id || !event?.id) return null;
    appendEvent({
      evidence_id: row.evidence_id,
      event_type: 'version_selected',
      actor_type: event.actor_type || 'human',
      actor_ref: event.actor_ref || '',
      payload: {
        selected_event_id: event.id,
        selected_event_type: event.event_type,
      },
      dedupe_key: `selected:${event.id}`,
      created_at: new Date().toISOString(),
    });
    const nextState = ['posted', 'duplicate_resolved', 'ignored'].includes(
      row.workflow_state,
    )
      ? row.workflow_state
      : 'ready_to_post';
    return forceInboxLineage(kind, id, {
      selectedEventId: event.id,
      workflowState: nextState,
    });
  }

  function transitionInbox(kind, id, input) {
    if (!enabled) return getInboxRow(kind, id);
    const row = getInboxRow(kind, id);
    if (!row) throw new Error(`没有找到${kind}截图 #${id}`);
    const fromState = row.workflow_state;
    const toState = input.toState;
    if (!WORKFLOW_STATUS[toState]) {
      throw new Error(`未知工作流状态：${toState}`);
    }
    if (
      fromState !== toState &&
      !String(input.reason || '').startsWith('复用同一状态的幂等回放') &&
      !(ALLOWED_TRANSITIONS[fromState] || []).includes(toState)
    ) {
      throw new Error(`截图状态不能从 ${fromState} 转换到 ${toState}`);
    }
    const updated = forceInboxLineage(kind, id, {
      evidenceId: row.evidence_id,
      selectedEventId: row.selected_event_id,
      workflowState: toState,
      legacyStatus: WORKFLOW_STATUS[toState],
      requestId: input.requestId || '',
    });
    appendEvent({
      evidence_id: row.evidence_id,
      event_type: 'state_changed',
      actor_type: input.actorType || 'system',
      actor_ref: input.actorRef || '',
      payload: {
        from_state: fromState,
        to_state: toState,
        reason: input.reason || '',
        state_version: Number(updated.state_version),
        details: input.details || null,
      },
      dedupe_key:
        input.dedupeKey ||
        `state:${id}:${fromState}:${toState}:${updated.state_version}`,
      request_id: input.requestId || '',
      created_at: input.createdAt || new Date().toISOString(),
    });
    return updated;
  }

  function recordFactRevision(input) {
    if (!enabled) return null;
    const factType = String(input.factType || '').trim();
    const factKey = String(input.factKey || '').trim();
    const operationId = String(input.operationId || '').trim();
    if (!factType || !factKey || !operationId) {
      throw new Error('事实修订需要 factType、factKey 和 operationId');
    }
    const existing = selectRevisionByOperation.get(
      factType,
      factKey,
      operationId,
    );
    if (existing) return mapRevision(existing);
    const latest = selectLatestRevision.get(factType, factKey);
    const revisionNo = Number(latest?.revision_no || 0) + 1;
    const before = input.before ?? {};
    const after = input.after ?? {};
    const fields =
      input.changedFields ?? changedFields(before, after);
    const result = insertRevision.run(
      factType,
      factKey,
      revisionNo,
      input.action || (latest ? 'update' : 'create'),
      jsonText(before, {}),
      jsonText(after, {}),
      jsonText(fields, []),
      input.reason || '',
      input.sourceClass || 'manual',
      input.actorType || 'human',
      input.actorRef || '',
      operationId,
      input.requestId || '',
      input.relatedFactType || '',
      input.relatedFactKey || '',
      input.createdAt || new Date().toISOString(),
    );
    return mapRevision(selectRevision.get(Number(result.lastInsertRowid)));
  }

  function getLatestRevision(factType, factKey) {
    return mapRevision(selectLatestRevision.get(factType, factKey));
  }

  function linkFactEvidence(input) {
    if (!enabled) return null;
    const revisionId = Number(input.revisionId);
    const evidenceId = Number(input.evidenceId);
    const eventId = Number(input.evidenceEventId);
    if (
      !Number.isInteger(revisionId) ||
      !Number.isInteger(evidenceId) ||
      !Number.isInteger(eventId)
    ) {
      throw new Error('证据链接需要 revisionId、evidenceId 和 evidenceEventId');
    }
    const event = selectEvent.get(eventId);
    if (!event || Number(event.evidence_id) !== evidenceId) {
      throw new Error('证据事件不属于指定证据资产');
    }
    const role = input.role || 'primary';
    insertLink.run(
      input.factType,
      input.factKey,
      revisionId,
      evidenceId,
      eventId,
      role,
      jsonText(input.fieldPaths || [], []),
      input.confidence === null || input.confidence === undefined
        ? null
        : Number(input.confidence),
      input.createdAt || new Date().toISOString(),
    );
    const row = selectLink.get(revisionId, evidenceId, eventId, role);
    return row
      ? {
          id: Number(row.id),
          fact_type: row.fact_type,
          fact_key: row.fact_key,
          fact_revision_id: Number(row.fact_revision_id),
          evidence_id: Number(row.evidence_id),
          evidence_event_id: Number(row.evidence_event_id),
          role: row.role,
          field_paths: parseJson(row.field_paths_json, []),
          confidence:
            row.confidence === null || row.confidence === undefined
              ? null
              : Number(row.confidence),
          link_status: row.link_status,
          created_at: row.created_at,
        }
      : null;
  }

  function linkFactToInbox(input) {
    const row = getInboxRow(input.inboxKind, input.inboxId);
    if (!row?.evidence_id || !row?.selected_event_id) return null;
    return linkFactEvidence({
      ...input,
      evidenceId: row.evidence_id,
      evidenceEventId: row.selected_event_id,
    });
  }

  function retireFactLinks(factType, factKey, reason) {
    if (!enabled) return 0;
    const result = retireLinks.run(
      new Date().toISOString(),
      reason || '',
      factType,
      factKey,
    );
    return Number(result.changes || 0);
  }

  function traceFact(factType, factKey) {
    const revisions = selectRevisionHistory
      .all(factType, factKey)
      .map(mapRevision);
    const links = selectFactLinks.all(factType, factKey).map(mapLink);
    for (const link of links) {
      const trace = traceEvidence(link.evidence_id);
      link.evidence = {
        ...trace?.evidence,
        ...link.evidence,
        source: trace?.source || null,
      };
      link.evidence_trace = trace;
    }
    const evidenceStatus =
      links.length === 0
        ? 'incomplete'
        : links.some(
            (link) =>
              link.link_status === 'active' &&
              link.evidence?.available === true,
          )
          ? 'complete'
          : 'partial';
    return {
      fact_type: factType,
      fact_key: factKey,
      evidence_status: evidenceStatus,
      revisions,
      evidence_links: links,
    };
  }

  function traceEvidence(evidenceId) {
    const asset = getEvidenceAsset(evidenceId);
    if (!asset) return null;
    const income = selectIncomeInboxByEvidence.get(evidenceId);
    const trade = selectTradeInboxByEvidence.get(evidenceId);
    const source = income
      ? {
          inbox_kind: 'income',
          inbox_id: Number(income.id),
          image_url: `/api/income/inbox/${income.id}/image`,
        }
      : trade
        ? {
            inbox_kind: 'trade',
            inbox_id: Number(trade.id),
            image_url: `/api/trades/inbox/${trade.id}/image`,
          }
        : null;
    const events = selectEvidenceEvents
      .all(evidenceId)
      .map(mapEvent);
    const links = selectEvidenceLinks.all(evidenceId).map((row) => ({
      ...mapLink(row),
      fact_revision: {
        action: row.action,
        after: parseJson(row.after_json, {}),
        created_at: row.revision_created_at,
      },
    }));
    return {
      evidence: asset,
      source,
      events,
      fact_links: links,
    };
  }

  function getInboxLineage(kind, id) {
    const row = getInboxRow(kind, id);
    if (!row) return null;
    return {
      inbox: row,
      evidence: row.evidence_id ? getEvidenceAsset(row.evidence_id) : null,
      selected_event: row.selected_event_id
        ? getEvent(row.selected_event_id)
        : null,
    };
  }

  return {
    mode,
    enabled,
    withTransaction: transactionManager.run,
    isTransactionActive: transactionManager.isActive,
    inboxType,
    getInboxRow,
    getInboxLineage,
    getEvidenceAsset,
    getEvidenceByHash,
    recordEvidenceAsset,
    appendEvent,
    getEvent,
    registerInboxEvidence,
    appendInboxEvent,
    selectInboxEvent,
    forceInboxLineage,
    transitionInbox,
    recordFactRevision,
    getLatestRevision,
    linkFactEvidence,
    linkFactToInbox,
    retireFactLinks,
    traceFact,
    traceEvidence,
  };
}

module.exports = {
  ALLOWED_TRANSITIONS,
  INBOX_TYPES,
  WORKFLOW_STATUS,
  createDataTrustStore,
  mapEvidence,
  mapEvent,
  mapLink,
  mapRevision,
};
