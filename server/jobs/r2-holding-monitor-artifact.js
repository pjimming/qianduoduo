'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { fingerprint } = require('../modules/r2-strategy/contract');
const { monitorContent } = require('../modules/r2-strategy/holding-evidence');

const MAX_BYTES = 4 * 1024 * 1024;
const artifactPath = dbPath => `${path.resolve(dbPath)}.holding-monitor.json`;

function ledgerIdentity(dbPath) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return db.prepare('SELECT ledger_identity FROM r2_strategy_state WHERE singleton=1').get()?.ledger_identity ?? null;
  } catch { return null; }
  finally { db?.close(); }
}

function readArtifact(dbPath) {
  if (!dbPath) return null;
  try {
    const file = artifactPath(dbPath);
    if (fs.statSync(file).size > MAX_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1 || value.ledger_path !== path.resolve(dbPath)) return null;
    if (!value.ledger_identity || value.ledger_identity !== ledgerIdentity(dbPath)) return null;
    return value;
  } catch { return null; }
}

function validBatch(batch, date) {
  try {
    return batch?.scope === 'holding_monitor' && batch.business_date === date &&
      batch.collector_version === 'cmb-public-v1' && Array.isArray(batch.items) && batch.items.length <= 128 &&
      Number.isFinite(Date.parse(batch.captured_at)) && fingerprint(monitorContent(batch)) === batch.content_hash;
  } catch { return false; }
}

// Reading a recommendation never performs network work or repairs the cache.
// A new day does not renew the prior day's evidence or its disclosure dates.
function readHoldingSupplements(dbPath, date) {
  const artifact = readArtifact(dbPath);
  const batches = [artifact?.baseline, artifact?.batch].filter(batch => validBatch(batch, date));
  return [...new Map(batches.map(batch => [batch.content_hash, batch])).values()];
}

function writeArtifact(dbPath, value) {
  const file = artifactPath(dbPath), temporary = `${file}.${randomUUID()}.tmp`;
  const identity = ledgerIdentity(dbPath);
  if (!identity) throw new Error('持仓监控证据需要已迁移账本身份');
  const json = JSON.stringify({ ...value, version: 1, ledger_path: path.resolve(dbPath), ledger_identity: identity });
  if (Buffer.byteLength(json) > MAX_BYTES) throw new Error('持仓监控证据超过受控大小');
  try {
    fs.writeFileSync(temporary, json, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

module.exports = { artifactPath, readArtifact, readHoldingSupplements, writeArtifact, validBatch };
