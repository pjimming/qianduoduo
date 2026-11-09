'use strict';

const { randomUUID } = require('node:crypto');
const { createTransactionManager } = require('../../../lib/transaction');
const { CONTRACT, CONTRACT_HASH, fingerprint, stableJson } = require('./contract');

function strategyError(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}
function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw strategyError('invalid_input', `${name}必须为${minimum}以上的安全整数`, 400);
  return value;
}
function text(value, name, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw strategyError('invalid_input', `${name}格式不正确`, 400);
  return value.trim();
}
function payload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw strategyError('invalid_input', '策略载荷必须是对象', 400);
  const seen = new Set();
  function check(item) {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) || seen.has(item)) {
      throw strategyError('invalid_input', '策略载荷包含不支持的JSON值', 400);
    }
    seen.add(item);
    for (const child of Array.isArray(item) ? item : Object.values(item)) check(child);
    seen.delete(item);
  }
  check(value);
  const json = stableJson(value);
  // Reject unsupported JSON types, including undefined and non-finite values.
  let normalized;
  try { normalized = JSON.parse(json); } catch { throw strategyError('invalid_input', '策略载荷不是有效JSON', 400); }
  if (stableJson(normalized) !== json || Buffer.byteLength(json) > CONTRACT.max_snapshot_bytes) {
    throw strategyError('invalid_input', '策略载荷超限或包含无效字段', 400);
  }
  return json;
}
function mappedJob(row) {
  return row ? { ...row, input: JSON.parse(row.input_json), result: JSON.parse(row.result_json) } : null;
}

// No schema creation and no initialization writes. All callers, including a
// worker on another connection, share the same persistent sequencing protocol.
function createStrategyRepository(db, { transactionManager = createTransactionManager(db), clock = () => new Date() } = {}) {
  const installed = () => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='r2_strategy_state'").get());
  const state = () => installed() ? db.prepare('SELECT * FROM r2_strategy_state WHERE singleton=1').get() ?? null : null;
  function now() {
    const value = clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('策略时钟无效');
    return value.toISOString();
  }
  function requireState(expectedSeq) {
    const current = state();
    if (!current || current.schema_version !== 1 || current.contract_hash !== CONTRACT_HASH) {
      throw strategyError('strategy_unavailable', '执行策略尚未迁移或契约不匹配', 503);
    }
    if (expectedSeq !== undefined && current.activation_seq !== integer(expectedSeq, '策略序号')) {
      throw strategyError('activation_changed', '执行策略已变化，请重新计算');
    }
    return current;
  }
  function synchronous(work) {
    const result = work();
    if (result && typeof result.then === 'function') throw new Error('策略事务不允许异步回调');
    return result;
  }
  function transition({ operationKey, expectedSeq, mode, summary = {} }, work = () => {}) {
    integer(expectedSeq, '策略序号');
    const key = text(operationKey, '切换操作标识');
    if (!['legacy', 'shadow', 'v9', 'suspended'].includes(mode)) throw strategyError('invalid_input', '策略模式无效', 400);
    const json = payload(summary);
    return transactionManager.run(() => {
      requireState();
      const existing = db.prepare('SELECT * FROM r2_strategy_transitions WHERE operation_key=?').get(key);
      if (existing) {
        if (existing.to_mode !== mode || existing.summary_json !== json) throw strategyError('operation_conflict', '相同切换操作标识对应不同输入');
        return { ...existing, existing: true };
      }
      const before = requireState(expectedSeq);
      const seq = before.activation_seq + 1;
      const stamp = now();
      synchronous(() => work({ before, activation_seq: seq }));
      db.prepare('UPDATE r2_strategy_state SET activation_seq=?,mode=?,updated_at=? WHERE singleton=1').run(seq, mode, stamp);
      db.prepare(`INSERT INTO r2_strategy_transitions VALUES (?,?,?,?,?,?,?)`).run(key, seq, before.mode, mode, CONTRACT_HASH, json, stamp);
      return { activation_seq: seq, from_mode: before.mode, to_mode: mode, existing: false };
    });
  }
  const reservations = () => installed() ? db.prepare('SELECT * FROM r2_fund_reservations ORDER BY id').all() : [];
  const reservedCents = () => installed() ? db.prepare("SELECT coalesce(sum(amount_cents-executed_cents-released_cents),0) n FROM r2_fund_reservations WHERE state='active'").get().n : 0;
  function reserve({ proposalId, decisionId, legKey, amountCents, expectedSeq, readAvailableCents }) {
    integer(expectedSeq, '策略序号');
    integer(proposalId, '提案编号', 1); integer(decisionId, '决策编号', 1); integer(amountCents, '预留金额（分）', 1);
    const leg = text(legKey, '交易腿');
    if (typeof readAvailableCents !== 'function') throw new Error('预留必须在事务内重新读取可用资金');
    return transactionManager.run(() => {
      requireState();
      const previous = db.prepare('SELECT * FROM r2_fund_reservations WHERE proposal_id=? AND leg_key=?').get(proposalId, leg);
      if (previous) {
        if (previous.decision_id !== decisionId || previous.amount_cents !== amountCents) throw strategyError('reservation_conflict', '同一预留对应不同决策或金额');
        return previous;
      }
      const current = requireState(expectedSeq);
      if (current.mode !== 'v9') throw strategyError('recommendation_disabled', '当前模式不允许正式资金预留');
      const cash = synchronous(readAvailableCents);
      integer(cash, '事务内可用资金（分）');
      if (amountCents > cash) throw strategyError('insufficient_funds', '资金已被持仓、在途交易或其他提案占用，请重算');
      const proposal = db.prepare('SELECT decision_id FROM decision_proposals WHERE id=?').get(proposalId);
      if (!proposal || (proposal.decision_id !== null && proposal.decision_id !== decisionId)) throw strategyError('proposal_changed', '提案关联决策已变化');
      const stamp = now();
      const result = db.prepare(`INSERT INTO r2_fund_reservations(proposal_id,decision_id,leg_key,activation_seq,amount_cents,state,created_at,updated_at)
        VALUES (?,?,?,?,?,'active',?,?)`).run(proposalId, decisionId, leg, current.activation_seq, amountCents, stamp, stamp);
      return db.prepare('SELECT * FROM r2_fund_reservations WHERE id=?').get(result.lastInsertRowid);
    });
  }
  // Cumulative confirmed execution, never a retry-sensitive increment. Caller
  // derives it from actual bound trades. Excess actual trades remain facts and
  // are reported as deviation by the business use case rather than dropped.
  function reconcileReservation({ id, executedCents, releaseRemaining = false }) {
    integer(id, '预留编号', 1); integer(executedCents, '累计执行金额（分）');
    return transactionManager.run(() => {
      requireState();
      const row = db.prepare('SELECT * FROM r2_fund_reservations WHERE id=?').get(id);
      if (!row) throw strategyError('reservation_missing', '预留不存在', 404);
      if (executedCents < row.executed_cents) throw strategyError('execution_regression', '累计执行金额不得倒退，交易撤销需独立重核');
      if (executedCents + row.released_cents > row.amount_cents) throw strategyError('execution_exceeds_reservation', '实际执行超出原预留，需记录执行偏差');
      const released = releaseRemaining ? row.amount_cents - executedCents : row.released_cents;
      const status = executedCents + released < row.amount_cents ? 'active' : released ? 'released' : 'settled';
      if (executedCents !== row.executed_cents || released !== row.released_cents || status !== row.state) {
        db.prepare('UPDATE r2_fund_reservations SET executed_cents=?,released_cents=?,state=?,updated_at=? WHERE id=?')
          .run(executedCents, released, status, now(), id);
      }
      return db.prepare('SELECT * FROM r2_fund_reservations WHERE id=?').get(id);
    });
  }
  function reconcileReservationFromFacts({ id, executedCents, keepUnusedReserved = true }) {
    if (!transactionManager.isActive()) throw new Error('实际交易预留接续必须在原事实写入事务内');
    integer(id, '预留编号', 1); integer(executedCents, '正式成交累计金额（分）');
    requireState();
    const row = db.prepare('SELECT * FROM r2_fund_reservations WHERE id=?').get(id);
    if (!row) throw strategyError('reservation_missing', '预留不存在', 404);
    const executed = Math.min(executedCents, row.amount_cents);
    const released = keepUnusedReserved ? 0 : row.amount_cents - executed;
    const status = executed + released < row.amount_cents ? 'active' : released ? 'released' : 'settled';
    if (row.executed_cents !== executed || row.released_cents !== released || row.state !== status) {
      db.prepare('UPDATE r2_fund_reservations SET executed_cents=?,released_cents=?,state=?,updated_at=? WHERE id=?')
        .run(executed, released, status, now(), id);
    }
    return { reservation: db.prepare('SELECT * FROM r2_fund_reservations WHERE id=?').get(id),
      excess_cents: Math.max(0, executedCents - row.amount_cents) };
  }
  const getJob = id => installed() ? mappedJob(db.prepare('SELECT * FROM r2_derivation_jobs WHERE id=?').get(id)) : null;
  function enqueue({ eventType, expectedSeq, input }) {
    integer(expectedSeq, '策略序号');
    const type = text(eventType, '派生事件类型', 80);
    const json = payload(input);
    const hash = fingerprint(input);
    return transactionManager.run(() => {
      const current = requireState(expectedSeq);
      if (!['shadow', 'v9'].includes(current.mode)) throw strategyError('derivation_disabled', '当前模式不派生新推荐');
      const existing = db.prepare('SELECT * FROM r2_derivation_jobs WHERE event_type=? AND activation_seq=? AND input_hash=?')
        .get(type, current.activation_seq, hash);
      if (existing) return mappedJob(existing);
      const stamp = now();
      // Every input contains the full current account/source/activation hash.
      // A newly enqueued context replaces pending/running older contexts.
      db.prepare(`UPDATE r2_derivation_jobs SET status='superseded',lease_token=NULL,lease_until=NULL,updated_at=?
        WHERE event_type=? AND status IN ('pending','running')`).run(stamp, type);
      const result = db.prepare(`INSERT INTO r2_derivation_jobs(event_type,activation_seq,input_hash,input_json,status,created_at,updated_at)
        VALUES (?,?,?,?,'pending',?,?)`).run(type, current.activation_seq, hash, json, stamp, stamp);
      return getJob(result.lastInsertRowid);
    });
  }
  function claim({ expectedSeq, leaseMs = 120000, id = null } = {}) {
    integer(leaseMs, '任务租约', 1000);
    if (leaseMs > 300000) throw strategyError('invalid_input', '任务租约不得超过5分钟', 400);
    return transactionManager.run(() => {
      const current = requireState(expectedSeq);
      if (!['shadow', 'v9'].includes(current.mode)) return null;
      const stamp = now();
      db.prepare(`UPDATE r2_derivation_jobs SET status='superseded',lease_token=NULL,lease_until=NULL,updated_at=?
        WHERE activation_seq!=? AND status IN ('pending','running')`).run(stamp, current.activation_seq);
      db.prepare(`UPDATE r2_derivation_jobs SET status=CASE WHEN attempts<3 THEN 'pending' ELSE 'failed' END,
        error_code='lease_expired',lease_token=NULL,lease_until=NULL,retry_at=?,updated_at=?
        WHERE status='running' AND lease_until<=?`).run(stamp, stamp, stamp);
      if (id !== null) integer(id, '任务编号', 1);
      const row = db.prepare(`SELECT id FROM r2_derivation_jobs WHERE activation_seq=? AND status='pending'
        AND attempts<3 AND (retry_at IS NULL OR retry_at<=?) AND (? IS NULL OR id=?) ORDER BY id LIMIT 1`).get(current.activation_seq, stamp, id, id);
      if (!row) return null;
      db.prepare("UPDATE r2_derivation_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=?")
        .run(randomUUID(), new Date(Date.parse(stamp) + leaseMs).toISOString(), stamp, row.id);
      return getJob(row.id);
    });
  }
  function requireLease({ id, token, expectedSeq, inputHash }) {
    requireState(expectedSeq);
    const row = getJob(id);
    if (!row || row.status !== 'running' || row.lease_token !== token || row.lease_until <= now() ||
        row.activation_seq !== expectedSeq || row.input_hash !== inputHash) throw strategyError('job_stale', '任务输入、租约或策略序号已变化');
    return row;
  }
  function complete(job, work) {
    if (typeof work !== 'function') throw new Error('任务完成需要事务内派生用例');
    return transactionManager.run(() => {
      const previous = getJob(job.id);
      if (previous?.status === 'done' && previous.activation_seq === job.expectedSeq && previous.input_hash === job.inputHash) return previous;
      const row = requireLease(job);
      const result = synchronous(() => work(row));
      const json = payload(result ?? {});
      const stamp = now();
      db.prepare("UPDATE r2_derivation_jobs SET status='done',result_json=?,lease_token=NULL,lease_until=NULL,error_code=NULL,updated_at=? WHERE id=?")
        .run(json, stamp, row.id);
      db.prepare(`INSERT INTO r2_derivation_watermarks VALUES (?,?,?,?,?) ON CONFLICT(event_type) DO UPDATE SET
        activation_seq=excluded.activation_seq,input_hash=excluded.input_hash,job_id=excluded.job_id,completed_at=excluded.completed_at`)
        .run(row.event_type, row.activation_seq, row.input_hash, row.id, stamp);
      return getJob(row.id);
    });
  }
  function fail(job, errorCode) {
    const code = text(errorCode, '失败原因', 80);
    return transactionManager.run(() => {
      const row = requireLease(job);
      const stamp = now();
      const retry = new Date(Date.parse(stamp) + 30000 * 2 ** (row.attempts - 1)).toISOString();
      db.prepare(`UPDATE r2_derivation_jobs SET status=?,error_code=?,retry_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?`)
        .run(row.attempts < 3 ? 'pending' : 'failed', code, retry, stamp, row.id);
      return getJob(row.id);
    });
  }
  const watermark = eventType => installed() ? db.prepare('SELECT * FROM r2_derivation_watermarks WHERE event_type=?').get(eventType) ?? null : null;
  const latestCompleted = eventType => installed() ? mappedJob(db.prepare(`SELECT j.* FROM r2_derivation_watermarks w
    JOIN r2_derivation_jobs j ON j.id=w.job_id JOIN r2_strategy_state s ON s.activation_seq=w.activation_seq
    WHERE w.event_type=? AND j.status='done'`).get(eventType)) : null;
  function jobSummary() {
    if (!installed()) return { counts: {}, latest: null };
    const counts = Object.fromEntries(db.prepare('SELECT status,count(*) n FROM r2_derivation_jobs GROUP BY status').all().map(row => [row.status, row.n]));
    const last = db.prepare(`SELECT id,event_type,activation_seq,input_hash,status,attempts,lease_until,retry_at,error_code,updated_at
      FROM r2_derivation_jobs ORDER BY id DESC LIMIT 1`).get() ?? null;
    return { counts, latest: last };
  }
  return { state, transition, reservations, reservedCents,
    reserve, reconcileReservation, reconcileReservationFromFacts, getJob, enqueue, claim, complete, fail, watermark, latestCompleted, jobSummary };
}

module.exports = { createStrategyRepository, strategyError, payload };
