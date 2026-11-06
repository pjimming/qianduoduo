'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_DB } = require('../../config');
const { hash, shareKey, SOURCE } = require('./source');
const { STATES, decimal } = require('./policy');

const APPLICATION_ID = 0x52325343;
const SCHEMA_VERSION = 1;
const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const LEASE_MS = 45000;
const SQLITE_SUFFIXES = ['', '-wal', '-shm', '-journal'];
const json = value => JSON.stringify(value);
const parsed = value => value === null ? null : JSON.parse(value);
const after = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
const compareDates = (a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0;

function canonical(file) {
  const absolute = path.resolve(file);
  try {
    return fs.realpathSync.native(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (fs.existsSync(path.dirname(absolute))) {
      // Reject a dangling link rather than creating its unknown target.
      try { fs.lstatSync(absolute); } catch (statError) {
        if (statError.code === 'ENOENT') return path.join(canonical(path.dirname(absolute)), path.basename(absolute));
        throw statError;
      }
      throw new Error('初筛库路径包含失效链接');
    }
    return path.join(canonical(path.dirname(absolute)), path.basename(absolute));
  }
}

function isolatedPath(file, ledgerPath) {
  const absolute = canonical(file);
  const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const pathsFor = base => SQLITE_SUFFIXES.map(suffix => canonical(base + suffix));
  const ledgerFiles = [...new Set([DEFAULT_DB, process.env.R2_DB_PATH, ledgerPath].filter(Boolean).map(canonical))]
    .flatMap(pathsFor);
  const ledgerNames = new Set(ledgerFiles.map(key));
  const identity = name => {
    const stat = fs.statSync(name, { bigint: true, throwIfNoEntry: false });
    return stat ? `${stat.dev}:${stat.ino}` : null;
  };
  const ledgerIdentities = new Set(ledgerFiles.map(identity).filter(Boolean));
  for (const name of pathsFor(absolute)) {
    if (ledgerNames.has(key(name))) throw new Error('初筛库必须使用独立路径');
    if (ledgerIdentities.has(identity(name))) throw new Error('初筛库必须使用独立文件');
  }
  return absolute;
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function assertSchema(db) {
  const id = db.prepare('PRAGMA application_id').get().application_id;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (id !== APPLICATION_ID || version !== SCHEMA_VERSION) throw new Error('初筛库标识或 schema 版本不匹配');
}

function runView(row) {
  if (!row) return null;
  const { idempotency_key, counts, health, input, ...rest } = row;
  return { ...rest, counts: parsed(counts), health: parsed(health), input: parsed(input),
    duration_ms: rest.started_at && rest.finished_at ? Date.parse(rest.finished_at) - Date.parse(rest.started_at) : null };
}

function openScreeningRepository(file, { ledgerPath, initialize = false, readOnly = false } = {}) {
  const dbPath = isolatedPath(file, ledgerPath);
  if (!fs.existsSync(dbPath)) {
    if (!initialize) return null;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  let sqlitePath = dbPath;
  // A clean offline WAL database does not need read-only SQLite to create WAL/SHM files.
  if (readOnly && !['-wal', '-shm', '-journal'].some(suffix => fs.existsSync(dbPath + suffix))) {
    const url = pathToFileURL(dbPath);
    url.searchParams.set('immutable', '1');
    sqlitePath = url.href;
  }
  const db = new DatabaseSync(sqlitePath, { readOnly });
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000');
    if (initialize && !readOnly) {
      transaction(db, () => {
        const id = db.prepare('PRAGMA application_id').get().application_id;
        const version = db.prepare('PRAGMA user_version').get().user_version;
        if (id === 0 && version === 0 && !db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) {
          db.exec(SCHEMA);
          db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}`);
        }
        assertSchema(db);
      });
    } else assertSchema(db);
    if (!readOnly) db.exec('PRAGMA journal_mode = WAL');
  } catch (error) {
    db.close();
    throw error;
  }

  const get = id => runView(db.prepare('SELECT * FROM screening_runs WHERE id = ?').get(id));
  const current = () => runView(db.prepare('SELECT r.* FROM screening_current c JOIN screening_runs r ON r.id = c.run_id').get());
  const active = () => runView(db.prepare("SELECT * FROM screening_runs WHERE status IN ('running','queued') ORDER BY status = 'running' DESC, id LIMIT 1").get());
  const scheduled = date => runView(db.prepare("SELECT * FROM screening_runs WHERE business_date = ? AND trigger IN ('scheduled','startup')").get(date));

  function enqueue({ trigger, date, key = null, scheduledAt = null, now, versions }) {
    return transaction(db, () => {
      if (trigger === 'manual') {
        const previous = runView(db.prepare('SELECT * FROM screening_runs WHERE idempotency_key = ?').get(key));
        if (previous) return { run: previous, existing: true };
        const busy = active();
        if (busy) return { run: busy, conflict: true };
      } else {
        const previous = scheduled(date);
        if (previous) return { run: previous, existing: true };
      }
      const inserted = db.prepare(`INSERT INTO screening_runs (
        trigger, business_date, scheduled_at, idempotency_key, status, created_at,
        rule_version, refresh_calendar_version, valuation_calendar_version, collector_version
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`).run(
        trigger, date, scheduledAt, key, now, versions.rule, versions.refresh, versions.valuation, versions.collector,
      );
      return { run: get(inserted.lastInsertRowid) };
    });
  }

  function take(date, now, versions) {
    return transaction(db, () => {
      const expired = db.prepare("SELECT * FROM screening_attempts WHERE status = 'running' AND lease_until <= ?").get(now);
      if (expired) {
        db.prepare(`UPDATE screening_attempts SET status = 'interrupted', finished_at = ?,
          error_code = 'lease_expired', error_message = '采集进程中断' WHERE token = ?`).run(now, expired.token);
        db.prepare(`UPDATE screening_runs SET status = CASE WHEN business_date = ? AND trigger != 'manual'
          AND ? < 3 THEN 'queued' ELSE 'interrupted' END, finished_at = ?, retry_at = NULL,
          error_code = 'lease_expired', error_message = '采集进程中断' WHERE id = ?`).run(date, expired.attempt, now, expired.run_id);
      }
      db.prepare(`UPDATE screening_runs SET status = 'interrupted', finished_at = ?,
        error_code = 'business_day_elapsed', error_message = '采集批次已跨日'
        WHERE status = 'queued' AND business_date < ?`).run(now, date);
      db.prepare(`UPDATE screening_runs SET status = 'interrupted', finished_at = ?,
        error_code = 'version_changed', error_message = '采集版本已变更'
        WHERE status = 'queued' AND (rule_version != ? OR refresh_calendar_version != ?
          OR valuation_calendar_version != ? OR collector_version != ?)`).run(
        now, versions.rule, versions.refresh, versions.valuation, versions.collector,
      );
      if (db.prepare("SELECT 1 FROM screening_attempts WHERE status = 'running'").get()) return null;
      const row = db.prepare(`SELECT id FROM screening_runs WHERE status = 'queued' AND business_date = ?
        AND (retry_at IS NULL OR retry_at <= ?) ORDER BY id LIMIT 1`).get(date, now);
      if (!row) return null;
      const { attempt } = db.prepare('SELECT count(*) + 1 AS attempt FROM screening_attempts WHERE run_id = ?').get(row.id);
      const token = randomUUID();
      db.prepare(`INSERT INTO screening_attempts (run_id, attempt, token, status, started_at, heartbeat_at, lease_until)
        VALUES (?, ?, ?, 'running', ?, ?, ?)`).run(row.id, attempt, token, now, now, after(now, LEASE_MS));
      db.prepare("UPDATE screening_runs SET status = 'running', started_at = coalesce(started_at, ?), finished_at = NULL WHERE id = ?")
        .run(now, row.id);
      return { run: get(row.id), token, attempt };
    });
  }

  const owns = (token, now) => db.prepare(
    "SELECT * FROM screening_attempts WHERE token = ? AND status = 'running' AND lease_until > ?",
  ).get(token, now);

  function heartbeat(token, now) {
    return db.prepare(`UPDATE screening_attempts SET heartbeat_at = ?, lease_until = ?
      WHERE token = ? AND status = 'running' AND lease_until > ?`).run(now, after(now, LEASE_MS), token, now).changes === 1;
  }

  function finish(token, now, outcome) {
    return transaction(db, () => {
      const claim = owns(token, now);
      if (!claim) return false;
      const { status, code, message, retryAt, health } = outcome;
      db.prepare(`UPDATE screening_attempts SET status = ?, finished_at = ?, error_code = ?, error_message = ? WHERE token = ?`)
        .run(status, now, code, message, token);
      db.prepare(`UPDATE screening_runs SET status = ?, finished_at = ?, retry_at = ?,
        error_code = ?, error_message = ?, health = ? WHERE id = ?`)
        .run(retryAt ? 'queued' : status, now, retryAt ?? null, code, message, health ? json(health) : null, claim.run_id);
      return true;
    });
  }

  function storeSeries(row, points) {
    if (!points?.length) return null;
    const dated = new Map();
    for (const point of points) {
      const earlier = dated.get(point.date);
      if (earlier && decimal(earlier.unit) !== decimal(point.unit)) return null;
      if (!earlier) dated.set(point.date, point);
    }
    const sorted = [...dated.values()].sort(compareDates);
    const digest = hash(sorted);
    const inserted = db.prepare(`INSERT INTO screening_nav_series (source, channel, code, content_hash)
      VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(SOURCE, row.channel, row.code, digest);
    if (inserted.changes) {
      const put = db.prepare('INSERT INTO screening_nav_points VALUES (?, ?, ?, ?)');
      for (const point of sorted) put.run(inserted.lastInsertRowid, point.date, point.unit, point.cumulative ?? null);
      return inserted.lastInsertRowid;
    }
    return db.prepare('SELECT id FROM screening_nav_series WHERE source = ? AND channel = ? AND code = ? AND content_hash = ?')
      .get(SOURCE, row.channel, row.code, digest).id;
  }

  function publish(token, now, date, collected, evaluated, degraded) {
    const products = new Map(collected.products.map(product => [shareKey(product), product]));
    const { counts, results } = evaluated;
    const pool = collected.health?.pool;
    if (!Number.isSafeInteger(pool?.requested) || pool.requested < 1 || pool.ok !== pool.requested ||
        (pool.included !== undefined && pool.included !== products.size) ||
        (collected.input.list_pages !== undefined && collected.input.list_pages !== pool.ok) ||
        !counts.total || products.size !== collected.products.length ||
        products.size !== collected.input.share_count || products.size !== results.length ||
        results.length !== counts.total || STATES.some(state => counts[state] !== results.filter(r => r.status === state).length) ||
        STATES.reduce((sum, state) => sum + counts[state], 0) !== counts.total ||
        new Set(results.map(shareKey)).size !== results.length) throw new Error('初筛结果完整性校验失败');
    return transaction(db, () => {
      const claim = owns(token, now);
      if (!claim) return false;
      const id = claim.run_id;
      const run = get(id);
      const previous = current();
      if (run.business_date !== date || previous?.business_date > date ||
          (previous?.business_date === date && previous.id > id)) return false;
      const put = db.prepare(`INSERT INTO screening_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const putEvidence = db.prepare(`INSERT INTO screening_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const row of results) {
        const product = products.get(shareKey(row));
        const seriesId = storeSeries(row, product.nav?.points);
        put.run(id, SOURCE, row.channel, row.code, row.name, row.issuer, row.category, row.term.days, row.status,
          Number(row.shortlisted), row.rank, row.yield_1m, row.performance_date, row.metrics.latest, seriesId, json(row));
        for (const item of product.evidence ?? []) {
          putEvidence.run(id, SOURCE, row.channel, row.code, item.kind, item.checked_at, item.url, item.hash, json(item.summary));
        }
      }
      const status = degraded ? 'degraded' : 'succeeded';
      db.prepare('UPDATE screening_attempts SET status = ?, finished_at = ? WHERE token = ?').run(status, now, token);
      db.prepare(`UPDATE screening_runs SET status = ?, finished_at = ?, retry_at = NULL, counts = ?,
        health = ?, input = ?, error_code = NULL, error_message = NULL WHERE id = ?`)
        .run(status, now, json(counts), json(collected.health), json(collected.input), id);
      db.prepare(`INSERT INTO screening_current VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET run_id = excluded.run_id`).run(id);
      return true;
    });
  }

  function query(runId, filters) {
    const where = ['run_id = ?'];
    const args = [runId];
    for (const [key, value] of Object.entries({
      status: filters.status, shortlisted: filters.shortlisted, term_days: filters.term,
      category: filters.category, issuer: filters.issuer,
    })) {
      if (key === 'term_days' && value === 'unknown') where.push('term_days IS NULL');
      else if (value !== undefined) { where.push(`${key} = ?`); args.push(value); }
    }
    if (filters.q) {
      where.push('(instr(lower(code), lower(?)) > 0 OR instr(name, ?) > 0)');
      args.push(filters.q, filters.q);
    }
    if (filters.hint) {
      where.push("EXISTS (SELECT 1 FROM json_each(detail, '$.hints') WHERE value = ?)");
      args.push(filters.hint);
    }
    if (filters.stage === 'yield') where.push("json_extract(detail, '$.yield_gate') = 'pass'");
    if (filters.stage === 'quota') where.push("json_extract(detail, '$.yield_gate') = 'pass' AND json_extract(detail, '$.quota.status') = 0");
    const order = {
      group: 'term_days IS NULL, term_days, category, rank IS NULL, rank, yield_1m DESC',
      yield_desc: 'yield_1m IS NULL, yield_1m DESC', code: 'code, channel',
      drawdown: "json_extract(detail, '$.metrics.drawdown.pct') IS NULL, json_extract(detail, '$.metrics.drawdown.pct')",
    }[filters.sort];
    const sql = ' FROM screening_results WHERE ' + where.join(' AND ');
    const total = db.prepare('SELECT count(*) AS total' + sql).get(...args).total;
    const groups = db.prepare('SELECT category, term_days, count(*) AS count' + sql +
      ' GROUP BY term_days, category ORDER BY term_days IS NULL, term_days, category').all(...args);
    const items = db.prepare('SELECT detail' + sql + ` ORDER BY ${order}, channel, code LIMIT ? OFFSET ?`)
      .all(...args, filters.limit, filters.offset).map(row => {
        const { detail, metrics, reasons, ...summary } = parsed(row.detail);
        const { recent, month_ends, monthly_returns, zero_dates, ...rest } = metrics;
        return { ...summary, metrics: { ...rest, zero_count: zero_dates?.length ?? null }, reason: reasons.find(item => item.outcome === 'reject')
          ?? reasons.find(item => item.outcome === 'pending') ?? reasons.find(item => item.outcome === 'watch') ?? null };
      });
    const facets = {
      issuers: db.prepare("SELECT DISTINCT issuer FROM screening_results WHERE run_id = ? AND issuer != '' ORDER BY issuer").all(runId).map(row => row.issuer),
      terms: db.prepare('SELECT DISTINCT term_days FROM screening_results WHERE run_id = ? ORDER BY term_days IS NULL, term_days').all(runId).map(row => row.term_days),
    };
    return { run_id: runId, total, groups, facets, items };
  }

  function result(runId, channel, code) {
    return db.prepare('SELECT detail, nav_series_id FROM screening_results WHERE run_id = ? AND source = ? AND channel = ? AND code = ?')
      .get(runId, SOURCE, channel, code);
  }

  return {
    dbPath, enqueue, take, heartbeat, finish, publish, current, active, scheduled, get, query,
    close: () => db.close(),
    last: () => runView(db.prepare(`SELECT * FROM screening_runs ORDER BY coalesce(
      (SELECT max(a.started_at) FROM screening_attempts a WHERE a.run_id = screening_runs.id), created_at) DESC, id DESC LIMIT 1`).get()),
    runs: ({ limit, offset }) => ({
      total: db.prepare('SELECT count(*) AS total FROM screening_runs').get().total,
      items: db.prepare('SELECT * FROM screening_runs ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset).map(runView),
    }),
    attempts: id => db.prepare(`SELECT attempt, status, started_at, heartbeat_at, finished_at, error_code, error_message
      FROM screening_attempts WHERE run_id = ? ORDER BY attempt`).all(id),
    ages: (runId, stale, date) => db.prepare(`SELECT
      count(*) FILTER (WHERE performance_date <= ? OR performance_date > ?) AS performance_expired,
      count(*) FILTER (WHERE nav_date <= ? OR nav_date > ?) AS nav_expired,
      max(performance_date) AS performance_latest, max(nav_date) AS nav_latest
      FROM screening_results WHERE run_id = ?`).get(stale, date, stale, date, runId),
    result,
    evidence: (runId, channel, code) => db.prepare(`SELECT kind, checked_at, url, hash, summary FROM screening_evidence
      WHERE run_id = ? AND source = ? AND channel = ? AND code = ? ORDER BY checked_at, kind`)
      .all(runId, SOURCE, channel, code).map(row => ({ ...row, summary: parsed(row.summary) })),
    points: (seriesId, { from, to, limit, offset }) => ({
      total: db.prepare('SELECT count(*) AS total FROM screening_nav_points WHERE series_id = ? AND date BETWEEN ? AND ?')
        .get(seriesId, from, to).total,
      items: db.prepare(`SELECT date, unit, cumulative FROM screening_nav_points WHERE series_id = ? AND date BETWEEN ? AND ?
        ORDER BY date DESC LIMIT ? OFFSET ?`).all(seriesId, from, to, limit, offset).reverse(),
    }),
    verify() {
      const valid = db.prepare('PRAGMA integrity_check').all();
      if (valid.length !== 1 || valid[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) {
        throw new Error('初筛库完整性或外键校验失败');
      }
      return { version: SCHEMA_VERSION, runs: db.prepare('SELECT count(*) AS total FROM screening_runs').get().total };
    },
  };
}

module.exports = { SCHEMA_VERSION, isolatedPath, openScreeningRepository };
