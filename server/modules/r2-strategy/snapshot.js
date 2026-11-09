'use strict';

const { CONTRACT, CONTRACT_HASH, PREVIOUS_CONTRACT_HASH, fingerprint, freeze } = require('./contract');
const { identityKey } = require('./evidence');
const { buildBuyForecast } = require('./forecast');
const { payload } = require('./repository');

function buildExecutionSnapshot({ result, row, amountCents, purpose = 'buy' }) {
  if (purpose !== 'buy') throw new Error('该快照构建器仅支持已核验买入；退出与切换需使用各自用例');
  const selection = result.allocation.rows.find(item => identityKey(item.identity) === identityKey(row.identity));
  if (purpose === 'buy' && (!result.may_generate_buy_proposals || !selection || selection.amount_cents !== amountCents)) {
    throw new Error('当前策略、配置金额或公开数据可行性未通过，不能冻结正式买入快照');
  }
  const forecast = buildBuyForecast({ row, amountCents, date: result.input.business_date });
  if (purpose === 'buy' && forecast.status !== 'available') throw new Error('收益情景不可计算，不能冻结正式买入快照');
  const body = JSON.parse(JSON.stringify({ payload_version: CONTRACT.payload_version, purpose,
    execution_version: CONTRACT.execution_version, contract_hash: CONTRACT_HASH, contract: CONTRACT,
    input: result.input, input_fingerprint: result.input_fingerprint,
    identity: row.identity, mapping: row.mapping, source_evidence: row,
    amount_cents: amountCents,
    portfolio: result.account,
    allocation: { version: result.allocation.version, fingerprint: result.allocation.fingerprint,
      full_investment: result.allocation.full_investment, bucket_budgets_cents: result.allocation.bucket_budgets_cents,
      liquidity_required_cents: result.allocation.liquidity_required_cents, liquidity_cents: result.allocation.liquidity_cents,
      rows: result.allocation.rows.filter(item => item.amount_cents > 0), constraints: result.allocation.constraints },
    forecast,
    evaluation_contract: { version: CONTRACT.evaluation_policy_version, min_observations: 7, minimum_coverage_ratio: 0.5,
      auto_confidence_threshold: 75, value_attribution: 'confirmed_principal_prorata',
      result_metric: 'net_pnl_cents', result_tolerance_cents: Math.max(1, Math.round(amountCents * 0.001 * forecast.total_days / 365)),
      target_annualized_pct: 3, target_is_selection_hurdle: false, monthly_yield_is_personal_return_hurdle: false },
  }));
  // The per-decision evidence copy must stand on its own if the source database
  // is offline. It is not a copy of every public share or a public NAV ledger.
  const snapshot = { ...body, snapshot_hash: fingerprint(body) };
  payload(snapshot);
  return freeze(snapshot);
}

function verifyExecutionSnapshot(snapshot, { historical = false } = {}) {
  const hashAllowed = snapshot?.contract_hash === CONTRACT_HASH ||
    (historical && snapshot?.contract_hash === PREVIOUS_CONTRACT_HASH);
  if (!snapshot || snapshot.payload_version !== 1 || snapshot.purpose !== 'buy' || snapshot.execution_version !== CONTRACT.execution_version ||
      !hashAllowed || !snapshot.contract || fingerprint(snapshot.contract) !== snapshot.contract_hash ||
      snapshot.evaluation_contract?.version !== CONTRACT.evaluation_policy_version || !snapshot.portfolio?.verified ||
      snapshot.allocation?.full_investment !== true || !Number.isSafeInteger(snapshot.amount_cents) || snapshot.amount_cents <= 0 ||
      snapshot.forecast?.status !== 'available') return false;
  const { snapshot_hash: hash, ...body } = snapshot;
  return typeof hash === 'string' && hash === fingerprint(body) && Buffer.byteLength(JSON.stringify(snapshot)) <= CONTRACT.max_snapshot_bytes;
}

module.exports = { buildBuyForecast, buildExecutionSnapshot, verifyExecutionSnapshot };
