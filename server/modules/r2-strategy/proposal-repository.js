'use strict';

const { CONTRACT } = require('./contract');
const { payload, strategyError } = require('./repository');

// Uses the existing proposal schema. It never creates tables, adopts a decision
// or starts a transaction: the generating/adopting service owns that boundary.
function createStrategyProposalRepository(repository) {
  const { db, transactionManager } = repository;
  function requireTransaction() {
    if (!transactionManager.isActive()) throw new Error('v9提案写入必须属于业务事务');
  }
  const get = id => repository.decisionProposalStore.getProposal(id);
  function create(input) {
    requireTransaction();
    const json = payload(input.payload);
    if (input.payload.execution_version !== CONTRACT.execution_version) throw strategyError('proposal_version_invalid', '提案执行版本无效', 400);
    const previous = db.prepare('SELECT id FROM decision_proposals WHERE dedupe_key=?').get(input.dedupe_key);
    if (previous) return { proposal: get(previous.id), existing: true };
    const stamp = new Date().toISOString();
    const result = db.prepare(`INSERT INTO decision_proposals(dedupe_key,group_key,proposal_type,title,summary,action,
      product_name,product_code,target_product_code,target_product_name,amount,evidence_date,expires_at,verify_date,confidence,payload_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.dedupe_key, input.group_key, input.proposal_type,
      input.title, input.summary, input.action, input.product_name, input.product_code, input.target_product_code ?? '',
      input.target_product_name ?? '', input.amount, input.evidence_date, input.expires_at, input.verify_date,
      input.confidence, json, stamp, stamp);
    const id = Number(result.lastInsertRowid);
    // Only replace unaccepted v9 drafts in this group. Accepted/part-executed
    // snapshots and every historical decision remain intact.
    db.prepare(`UPDATE decision_proposals SET status='expired',reject_reason=?,summary=summary||?,updated_at=?
      WHERE group_key=? AND id!=? AND status='pending' AND json_extract(payload_json,'$.execution_version')=?`)
      .run('当前证据或账户输入已更新，请使用新版本提案', '\n已由同一策略的新证据版本替代。', stamp, input.group_key, id, CONTRACT.execution_version);
    return { proposal: get(id), existing: false };
  }
  function accept(id, decisionId) {
    requireTransaction();
    const result = db.prepare(`UPDATE decision_proposals SET status='accepted',decision_id=?,accepted_at=?,updated_at=?
      WHERE id=? AND status='pending' AND json_extract(payload_json,'$.execution_version')=?`)
      .run(decisionId, new Date().toISOString(), new Date().toISOString(), id, CONTRACT.execution_version);
    if (result.changes !== 1) throw strategyError('proposal_changed', '提案已被其他请求处理，请刷新');
    return get(id);
  }
  function expire(id, reason) {
    requireTransaction();
    db.prepare(`UPDATE decision_proposals SET status='expired',reject_reason=?,updated_at=? WHERE id=? AND status='pending'
      AND json_extract(payload_json,'$.execution_version')=?`).run(String(reason).slice(0, 500), new Date().toISOString(), id, CONTRACT.execution_version);
    return get(id);
  }
  function reject(id, reason) {
    requireTransaction();
    const stamp = new Date().toISOString();
    const result = db.prepare(`UPDATE decision_proposals SET status='rejected',reject_reason=?,rejected_at=?,updated_at=?
      WHERE id=? AND status IN ('pending','accepted') AND json_extract(payload_json,'$.execution_version')=?`)
      .run(reason, stamp, stamp, id, CONTRACT.execution_version);
    if (result.changes !== 1) throw strategyError('proposal_changed', '提案状态已变化，请刷新');
    return get(id);
  }
  return { get, create, accept, expire, reject };
}

module.exports = { createStrategyProposalRepository };
