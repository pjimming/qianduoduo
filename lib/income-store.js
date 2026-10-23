'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;

const INCOME_SCHEMA = `
  CREATE TABLE IF NOT EXISTS income_inbox (
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
    record_date TEXT,
    error TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    received_at TEXT NOT NULL,
    applied_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_income_inbox_status
    ON income_inbox(status, received_at ASC, id ASC);
`;

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

function mapIncomeInbox(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    original_name: row.original_name || '',
    stored_name: row.stored_name || '',
    mime: row.mime || '',
    bytes: Number(row.bytes || 0),
    sha256: row.sha256,
    status: row.status,
    ocr_text: row.ocr_text || '',
    parsed: parseJson(row.parsed_json, {}),
    parse_confidence: Number(row.parse_confidence || 0),
    record_date: row.record_date || null,
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
    image_url: row.stored_name
      ? `/api/income/inbox/${row.id}/image`
      : null,
  };
}

function createIncomeStore(db, options = {}) {
  db.exec(INCOME_SCHEMA);
  const inboxDir =
    options.inboxDir || path.join(process.cwd(), 'data', 'income-inbox');
  fs.mkdirSync(inboxDir, { recursive: true });

  const selectInbox = db.prepare(
    'SELECT * FROM income_inbox ORDER BY received_at DESC, id DESC',
  );
  const selectInboxItem = db.prepare('SELECT * FROM income_inbox WHERE id = ?');
  const selectInboxByHash = db.prepare(
    'SELECT * FROM income_inbox WHERE sha256 = ?',
  );
  const insertInbox = db.prepare(`
    INSERT INTO income_inbox (
      original_name, stored_name, mime, bytes, sha256, status, ocr_text,
      parsed_json, parse_confidence, record_date, error, notes, received_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateInboxStatement = db.prepare(`
    UPDATE income_inbox
    SET parsed_json = ?, parse_confidence = ?, record_date = ?, error = ?,
        notes = ?, status = ?, applied_at = ?, stored_name = ?
    WHERE id = ?
  `);

  function listInbox() {
    return selectInbox.all().map(mapIncomeInbox);
  }

  function getInboxItem(id) {
    return mapIncomeInbox(selectInboxItem.get(id));
  }

  function getInboxByHash(sha256) {
    return mapIncomeInbox(selectInboxByHash.get(sha256));
  }

  function addInbox(input) {
    const stamp = new Date().toISOString();
    const result = insertInbox.run(
      input.original_name || '',
      input.stored_name || '',
      input.mime || '',
      Number(input.bytes || 0),
      input.sha256,
      input.ocr_text || '',
      JSON.stringify(input.parsed || {}),
      Number(input.parse_confidence || 0),
      input.record_date || input.parsed?.date || null,
      input.error || '',
      input.notes || '',
      stamp,
    );
    return getInboxItem(Number(result.lastInsertRowid));
  }

  function updateInbox(id, input = {}) {
    const before = getInboxItem(id);
    if (!before) return null;
    const next = { ...before, ...input };
    updateInboxStatement.run(
      JSON.stringify(next.parsed || {}),
      Number(next.parse_confidence ?? before.parse_confidence),
      next.record_date ?? before.record_date,
      next.error ?? before.error,
      next.notes ?? before.notes,
      next.status ?? before.status,
      next.applied_at ?? before.applied_at,
      next.stored_name ?? before.stored_name,
      id,
    );
    return getInboxItem(id);
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
    if (!target.startsWith(prefix) || !fs.existsSync(target)) return null;
    return { path: target, mime: item.mime || 'image/png' };
  }

  function saveInboxImage({ buffer, mime, originalName }) {
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const existing = getInboxByHash(sha256);
    if (existing) return { item: existing, duplicate: true, sha256 };
    const extensions = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
    };
    const storedName = `${Date.now()}-${sha256.slice(0, 12)}${
      extensions[mime] || '.png'
    }`;
    fs.writeFileSync(path.join(inboxDir, storedName), buffer);
    return {
      item: {
        stored_name: storedName,
        mime,
        bytes: buffer.length,
        sha256,
        original_name: originalName,
      },
      duplicate: false,
      sha256,
    };
  }

  function pruneScreenshots({ today, olderThanDays = 180 } = {}) {
    const todayStamp = parseYmd(today);
    if (todayStamp === null) return { removed: 0, inbox: listInbox() };
    const threshold = new Date(todayStamp - olderThanDays * DAY_MS)
      .toISOString()
      .slice(0, 10);
    let removed = 0;
    for (const row of selectInbox.all()) {
      if (!row.stored_name || !['applied', 'ignored'].includes(row.status)) {
        continue;
      }
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
        row.parsed_json,
        row.parse_confidence,
        row.record_date,
        row.error,
        row.notes,
        row.status,
        row.applied_at,
        '',
        row.id,
      );
    }
    return { removed, inbox: listInbox() };
  }

  return {
    inboxDir,
    listInbox,
    getInboxItem,
    getInboxByHash,
    addInbox,
    updateInbox,
    ignoreInbox,
    getInboxFilePath,
    saveInboxImage,
    pruneScreenshots,
  };
}

module.exports = {
  INCOME_SCHEMA,
  createIncomeStore,
  mapIncomeInbox,
};
