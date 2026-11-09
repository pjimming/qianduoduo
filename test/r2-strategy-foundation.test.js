'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../lib/db');
const { openScreeningRepository } = require('../server/modules/r2-screening/repository');
const { CONTRACT, CONTRACT_HASH, fingerprint } = require('../server/modules/r2-strategy/contract');
const { adaptSnapshot, createStrategyEvidenceAdapter } = require('../server/modules/r2-strategy/evidence');
const { screen } = require('../server/modules/r2-screening/policy');
const { valuationCalendar } = require('../server/modules/r2-screening/calendar');
const publicFixture = require('./fixtures/r2-screening/2026-11-07.json');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qdd-strategy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'ledger.sqlite');
  openDatabase({ dbPath, logger: { log() {}, warn() {} } }).close();
  const screeningPath = path.join(dir, 'screening.sqlite');
  openScreeningRepository(screeningPath, { ledgerPath: dbPath, initialize: true }).close();
  return { dbPath, screeningPath, backupDir: path.join(dir, 'backups') };
}
function fixture(patch = {}) {
  const data = { channel: 'C', code: 'S', name: '离线夹具', performance: { '1m': '2.15', '3m': '2.3', '6m': '2.4', '1y': '2.5' },
    performance_date: '2026-11-01', status: 'eligible', rank: 4, shortlisted: false,
    metrics: { latest: '2026-11-06', end: '2026-11-06', issue: null, drawdown: { pct: 0.3 } },
    detail: { registration: 'Z1234567890' }, term: { kind: 'minimum', days: 30 }, category: 'bond',
    quota: { status: 0, amount: null }, hints: ['frequent_zero', 'trend_weak'], ...patch };
  return { run: { id: 1, created_at: '2026-11-07T04:00:00Z', rule_version: 'v9', status: 'degraded',
    business_date: '2026-11-07', counts: { total: 1 }, health: { pool: { requested: 1, ok: 1, included: 1 } } },
  rows: [{ source: 'cmb', channel: 'C', code: 'S', nav_hash: 'a'.repeat(64), data }],
  evidence: [{ source: 'cmb', channel: 'C', code: 'S', kind: 'performance', hash: 'b'.repeat(64),
    summary: { risk: 'R2', currency: 'CNY', public_offering: true, performance_date: data.performance_date, performance: data.performance } }] };
}
const read = (patch = {}, date = '2026-11-07') => adaptSnapshot(fixture(patch), date);

test('execution contract freezes independent versions and never adopts the legacy family exception', () => {
  assert.equal(CONTRACT.selection_policy_version, 'v9');
  assert.equal(CONTRACT.max_strategy_family_pct, 50);
  assert.equal(CONTRACT.bucket_targets.short, 30);
  assert.equal(CONTRACT.yield_policy_version, 'r2-term-yield-v1');
  assert.equal(CONTRACT_HASH, fingerprint(CONTRACT));
  assert.equal(fingerprint({ b: 1, a: 2 }), fingerprint({ a: 2, b: 1 }));
  assert.throws(() => { CONTRACT.bucket_targets.short = 20; });
});
test('same-share dated evidence: 2.14/2.15, age 6/7, future and malformed values', () => {
  assert.equal(read().rows[0].automatic_eligible, true);
  assert.equal(read({ performance: { '1m': '2.14' } }).rows[0].holding_yield_state, 'below');
  assert.equal(read({}, '2026-11-08').rows[0].holding_yield_state, 'pending');
  assert.equal(read({ performance_date: '2026-11-08' }).rows[0].holding_yield_state, 'pending');
  assert.equal(read({ performance: { '1m': 'NaN' } }).rows[0].holding_yield_state, 'pending');
  assert.equal(read({ metrics: { latest: '2026-10-31', end: '2026-10-31' } }).rows[0].automatic_eligible, false);
});
test('no external mapping is required; public share identity is the product identity', () => {
  const row = read().rows[0];
  assert.equal(row.automatic_eligible, true);
  assert.equal(row.holding_yield_state, 'pass');
  assert.equal(row.identity.code, 'S');
  assert.equal(typeof row.evidence_hash, 'string');
});
test('sale status and shortlist are separate from current holding yield monitoring', () => {
  const sold = read({ quota: { status: 1 }, status: 'rejected' }).rows[0];
  assert.equal(sold.automatic_eligible, false);
  assert.equal(sold.holding_yield_state, 'pass');
  const row = read().rows[0];
  assert.equal(row.rank, 4);
  assert.equal(row.shortlisted, false);
  assert.equal(row.automatic_eligible, true);
  assert.deepEqual(row.hints, ['frequent_zero', 'trend_weak']);
  assert.equal(row.quota.policy_assumption.bank_disclosed, false);
  const lowWithoutDetail = read({ detail: null, status: 'rejected', performance: { '1m': '2.14' } }).rows[0];
  assert.equal(lowWithoutDetail.holding_yield_state, 'below');
  assert.equal(lowWithoutDetail.automatic_eligible, false);
});
test('term, observation, unknown category, and reference yield cannot silently become execution', () => {
  for (const patch of [{ status: 'watch' }, { status: 'pending' }, { term: { days: 191, kind: 'minimum' } },
    { term: { days: 30, kind: 'rolling' } }, { term: { days: null, kind: 'unknown' } }, { category: 'unknown' },
    { performance: { '1m': '2.5' } }, { performance: { '1m': '2.5', '1y': '2.4' }, term: { days: 30, kind: 'minimum' } }]) {
    assert.equal(read(patch).rows[0].automatic_eligible, false);
  }
  const row = read({ performance: { '1m': '2.5' }, term: { days: 180, kind: 'minimum' } }).rows[0];
  assert.equal(row.reference.value_pct, null);
  assert.equal(row.reference.status, 'unavailable');
});
test('local degraded evidence remains usable; incomplete global pools and identity failures block all', () => {
  const input = fixture();
  input.run.health.pool.ok = 0;
  const value = adaptSnapshot(input, '2026-11-07');
  assert.equal(value.available, false);
  assert.equal(value.rows[0].automatic_eligible, false);
  assert.equal(createStrategyEvidenceAdapter({}).read('2026-11-07').available, false);
  assert.equal(createStrategyEvidenceAdapter({ screeningRepository: { readExecutionSnapshot() { throw new Error(); } } }).read('2026-11-07').available, false);
});
test('snapshot hashes include evidence, date and content, and never mutate an older snapshot', () => {
  const original = read();
  const next = read({}, '2026-11-08');
  assert.notEqual(original.fingerprint, next.fingerprint);
  assert.notEqual(original.fingerprint, read({ performance: { '1m': '2.16' } }).fingerprint);
  const input = fixture();
  const frozen = adaptSnapshot(input, '2026-11-07');
  input.rows[0].data.performance['1m'] = '99';
  assert.equal(frozen.rows[0].performance['1m'], '2.15');
  assert.equal(read().fingerprint, original.fingerprint);
  assert.equal(fingerprint(JSON.parse(JSON.stringify(original.rows[0]))), fingerprint(original.rows[0]));
  assert.equal(fingerprint({ a: undefined, b: [undefined] }), fingerprint({ b: [null] }));
});
test('explicit migration backs up both WAL databases, preserves all existing tables, repeats safely and rolls back empty', async t => {
  const options = temporary(t);
  const { preflight, applyMigration, rollbackEmptyMigration } = await import('../scripts/migrate-r2-strategy.mjs');
  const before = preflight(options);
  assert.equal(before.installed, false);
  const migrated = applyMigration(options);
  assert.equal(migrated.report.mode, 'legacy');
  assert.deepEqual(migrated.report.legacy, before.legacy);
  assert.equal(preflight(options).installed, true);
  assert.equal(applyMigration(options).changed, false);
  const manifest = JSON.parse(fs.readFileSync(migrated.backup_manifest, 'utf8'));
  assert.equal(manifest.ledger.sha256.length, 64);
  assert.equal(manifest.screening.sha256.length, 64);
  assert.equal(rollbackEmptyMigration(options).changed, true);
  assert.deepEqual(preflight(options), before);
});
test('DDL failure rolls back atomically without restoring over existing ledger facts', async t => {
  const options = temporary(t);
  const { preflight, applyMigration } = await import('../scripts/migrate-r2-strategy.mjs');
  const before = preflight(options);
  assert.throws(() => applyMigration({ ...options, beforeCommit() { throw new Error('injected commit failure'); } }), /injected/);
  assert.deepEqual(preflight(options), before);
});
test('schema constraints enforce reservation conservation and unique ownership; populated migration cannot be dropped', async t => {
  const options = temporary(t);
  const { applyMigration, rollbackEmptyMigration } = await import('../scripts/migrate-r2-strategy.mjs');
  applyMigration(options);
  const db = new DatabaseSync(options.dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    assert.throws(() => db.prepare("INSERT INTO r2_fund_reservations(proposal_id,decision_id,leg_key,activation_seq,amount_cents,state,created_at,updated_at) VALUES (999,999,'buy',1,100,'active','now','now')").run(), /FOREIGN KEY/);
    const decision = db.prepare("INSERT INTO decision_log(decision_date,product_name,action,created_at,updated_at) VALUES ('2026-11-07','fixture','买入','now','now')").run().lastInsertRowid;
    const proposal = db.prepare("INSERT INTO decision_proposals(dedupe_key,group_key,proposal_type,title,summary,action,product_name,created_at,updated_at) VALUES ('test','test','cash_allocation','test','test','买入','fixture','now','now')").run().lastInsertRowid;
    const reserve = db.prepare("INSERT INTO r2_fund_reservations(proposal_id,decision_id,leg_key,activation_seq,amount_cents,state,created_at,updated_at) VALUES (?,?,'buy',1,100,'active','now','now')");
    reserve.run(proposal, decision);
    assert.throws(() => reserve.run(proposal, decision), /UNIQUE/);
    assert.throws(() => db.exec('UPDATE r2_fund_reservations SET executed_cents = 101'), /CHECK/);
    assert.throws(() => db.exec("UPDATE r2_fund_reservations SET state = 'settled'"), /CHECK/);
    db.exec('UPDATE r2_fund_reservations SET executed_cents = 40');
    assert.throws(() => db.exec('UPDATE r2_fund_reservations SET released_cents = 61'), /CHECK/);
    db.exec("UPDATE r2_fund_reservations SET released_cents = 60, state = 'released'");
    db.prepare("INSERT INTO r2_derivation_jobs(event_type,activation_seq,input_hash,input_json,status,created_at,updated_at) VALUES ('publish',0,?,'{}','pending','now','now')").run('a'.repeat(64));
    assert.throws(() => db.prepare("INSERT INTO r2_derivation_jobs(event_type,activation_seq,input_hash,input_json,status,created_at,updated_at) VALUES ('publish',0,?,'{}','pending','now','now')").run('a'.repeat(64)), /UNIQUE/);
    assert.throws(() => db.exec("UPDATE r2_derivation_jobs SET status = 'running'"), /CHECK/);
  } finally { db.close(); }
  assert.throws(() => rollbackEmptyMigration(options), /已有业务记录/);
});
test('schema drift is detected instead of silently accepted by version', async t => {
  const options = temporary(t);
  const { preflight, applyMigration } = await import('../scripts/migrate-r2-strategy.mjs');
  applyMigration(options);
  const db = new DatabaseSync(options.dbPath);
  db.exec('DROP INDEX r2_jobs_dispatch');
  db.close();
  assert.throws(() => preflight(options), /定义不匹配/);
});
test('published snapshot reader leaves both schema and current pointer unchanged on repeated GET-style reads', t => {
  const options = temporary(t);
  const repo = openScreeningRepository(options.screeningPath, { ledgerPath: options.dbPath, readOnly: true });
  try {
    assert.equal(repo.readExecutionSnapshot(), null);
    assert.equal(repo.readExecutionSnapshot(), null);
    assert.equal(repo.current(), null);
    repo.verify();
  } finally { repo.close(); }
});

test('reopening a current ledger does not rewrite an already completed holding migration audit timestamp', t => {
  const options = temporary(t);
  const first = new DatabaseSync(options.dbPath, { readOnly: true });
  const before = first.prepare('SELECT * FROM schema_migrations ORDER BY id').all();
  first.close();
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-01T00:00:00Z') });
  openDatabase({ dbPath: options.dbPath, logger: { warn() {} } }).close();
  const after = new DatabaseSync(options.dbPath, { readOnly: true });
  try { assert.deepEqual(after.prepare('SELECT * FROM schema_migrations ORDER BY id').all(), before); }
  finally { after.close(); }
});

test('real published evidence is frozen across pointer advancement and survives source closure', t => {
  const options = temporary(t);
  const writer = openScreeningRepository(options.screeningPath, { ledgerPath: options.dbPath });
  const reader = openScreeningRepository(options.screeningPath, { ledgerPath: options.dbPath, readOnly: true });
  let old;
  try {
    const date = publicFixture.date;
    const now = `${date}T04:00:00.000Z`;
    const versions = { rule: 'v9', refresh: 'test-refresh', valuation: valuationCalendar.version, collector: 'test-collector' };
    const publish = key => {
      const { run } = writer.enqueue({ trigger: 'manual', date, key, now, versions });
      const claim = writer.take(date, now, versions);
      assert.equal(writer.publish(claim.token, now, date, publicFixture, screen(publicFixture.products, date, valuationCalendar), true), true);
      return run.id;
    };
    const first = publish('first');
    old = reader.readExecutionSnapshot();
    assert.equal(old.run.id, first);
    assert.equal(old.rows.length, publicFixture.products.length);
    assert.equal(old.rows.filter(row => row.nav_hash).length > 0, true);
    assert.equal(fingerprint(old), fingerprint(reader.readExecutionSnapshot()));
    const second = publish('second');
    assert.equal(reader.readExecutionSnapshot().run.id, second);
    assert.equal(old.run.id, first);
    assert.notEqual(fingerprint(old), fingerprint(reader.readExecutionSnapshot()));
    assert.equal(writer.verify().runs, 2);
  } finally { reader.close(); writer.close(); }
  assert.equal(adaptSnapshot(old, publicFixture.date).rows.length, publicFixture.products.length);
});
