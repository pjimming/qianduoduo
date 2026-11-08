'use strict';

const fs = require('node:fs');
const { fingerprint } = require('../modules/r2-strategy/contract');
const { createStrategyRepository } = require('../modules/r2-strategy/repository');
const { collectHoldingEvidence } = require('../modules/r2-screening/source');
const { refreshCalendar, valuationCalendar } = require('../modules/r2-screening/calendar');
const { artifactPath, readArtifact, writeArtifact, validBatch } = require('./r2-holding-monitor-artifact');

// No network call receives a lot, account balance, principal or private decision.
async function refreshHoldingMonitor({ ledger, sourceSnapshot, date, signal,
  collector = collectHoldingEvidence, clock = () => new Date(), retryDelayMs = 3600000 }) {
  if (refreshCalendar.isOpen(date) !== true) return { skipped: true, reason: 'calendar_closed' };
  const mappings = createStrategyRepository(ledger.db, { transactionManager: ledger.transactionManager }).listMappings();
  const codes = [...new Set(ledger.tradeStore.getPortfolio().map(row => String(row.product_code)))].sort();
  const identities = codes.flatMap(code => {
    const matching = mappings.filter(row => row.product_code === code && row.source === 'cmb');
    return matching.length === 1 ? [{ source: 'cmb', channel: matching[0].channel, code: matching[0].sales_code }] : [];
  });
  const unique = [...new Map(identities.map(identity => [fingerprint(identity), identity])).values()];
  if (!unique.length) return { skipped: true, reason: 'no_mapped_holdings' };
  if (unique.length > 128) return { skipped: true, reason: 'monitor_scope_exceeded' };
  const key = fingerprint({ date, identities: unique, source: sourceSnapshot });
  const lock = `${artifactPath(ledger.dbPath)}.lock`;
  let handle;
  try {
    try { handle = fs.openSync(lock, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A terminated worker can leave a lock; recover only beyond the hard
      // collection timeout so a live collector's lock is never stolen.
      if (clock().getTime() - fs.statSync(lock).mtimeMs < 10 * 60 * 1000) return { skipped: true, reason: 'monitor_running' };
      fs.rmSync(lock); handle = fs.openSync(lock, 'wx');
    }
    const previous = readArtifact(ledger.dbPath);
    const same = previous?.attempt?.key === key;
    if (same && previous.attempt.complete) return { skipped: true, reason: 'monitor_current' };
    if (same && previous.attempt.count >= 3) return { skipped: true, reason: 'monitor_attempts_exhausted' };
    if (same && clock().getTime() - Date.parse(previous.attempt.at) < retryDelayMs) return { skipped: true, reason: 'monitor_backoff' };
    const attempt = { key, at: clock().toISOString(), count: same ? previous.attempt.count + 1 : 1, complete: false };
    const retained = validBatch(previous?.batch, date) ? previous.batch : null;
    const baseline = validBatch(previous?.baseline, date) ? previous.baseline : null;
    writeArtifact(ledger.dbPath, { batch: retained, baseline, attempt });
    try {
      const batch = await collector({ identities: unique, date, calendar: valuationCalendar, signal, clock });
      if (!validBatch(batch, date)) throw new Error('持仓监控结果指纹或范围无效');
      if (fingerprint(batch.items.map(row => fingerprint(row.identity)).sort()) !==
          fingerprint(unique.map(identity => fingerprint(identity)).sort())) throw new Error('持仓监控结果份额与请求不一致');
      attempt.complete = batch.items.every(row => row.issues.length === 0);
      // A degraded response supplements the last known evidence rather than
      // erasing good disclosure dates. combineHoldingEvidence exposes the new
      // failure alongside the retained dates and never renews either date.
      writeArtifact(ledger.dbPath, { batch, baseline: attempt.complete ? null : baseline ?? retained, attempt });
      return { refreshed: true, content_hash: batch.content_hash, count: batch.items.length };
    } catch (error) {
      // Failed refreshes retain the original captured_at/data dates unchanged.
      writeArtifact(ledger.dbPath, { batch: retained, baseline, attempt: { ...attempt, error: error.code ?? 'monitor_collection_failed' } });
      return { refreshed: false, error: error.code ?? 'monitor_collection_failed' };
    }
  } finally {
    if (handle !== undefined) { fs.closeSync(handle); fs.rmSync(lock, { force: true }); }
  }
}

module.exports = { refreshHoldingMonitor };
