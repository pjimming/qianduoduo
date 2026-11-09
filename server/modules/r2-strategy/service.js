'use strict';

const { todayShanghai } = require('../../../lib/metrics');
const { CONTRACT, CONTRACT_HASH, fingerprint } = require('./contract');
const { createStrategyRepository, strategyError } = require('./repository');
const { evaluateStrategy, compactStrategyResult } = require('./engine');
const { buildStrategyInboxItems } = require('./inbox');
const { moneyCents } = require('./account');
const { createTransactionManager } = require('../../../lib/transaction');
const { readHoldingSupplements } = require('../../jobs/r2-holding-monitor-artifact');

// Bump whenever engine/account/allocation output can change without a ledger
// write. It is part of the frozen input hash so a code change invalidates the
// persisted strategy job instead of reusing a stale result.
const CALCULATION_VERSION = 3;

function monthEndWindow(date, months) {
  const start = new Date(`${date}T00:00:00Z`);
  const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, Math.min(start.getUTCDate(), last))).toISOString().slice(0, 10);
}

function createStrategyService({ repository, screening = null, strategyRepository = null, todayProvider = todayShanghai,
  evaluate = evaluateStrategy, engineOptions = {} }) {
  if (!repository?.db) throw new Error('执行策略服务需要账本repository');
  const transactionManager = repository.transactionManager ?? createTransactionManager(repository.db);
  const store = strategyRepository ?? createStrategyRepository(repository.db, { transactionManager });
  function readLedger(date) {
    const settings = repository.getAllocationSettings();
    const capital = repository.getCapitalState(date);
    const cashNeeds = [];
    let required = 0;
    for (const [months, field] of [[3, 'cashflow_0_3'], [6, 'cashflow_3_6'], [12, 'cashflow_6_12']]) {
      required += moneyCents(settings[field] ?? 0);
      if (required) cashNeeds.push({ by_date: monthEndWindow(date, months), required_cents: required, basis: 'legacy_window_end' });
    }
    return { state: store.state(),
      portfolio: { principal: settings.principal_override ?? capital.current_principal ?? 0,
        holdings: repository.tradeStore.getPortfolio(), trades: repository.tradeStore.listTrades(),
        reservations: store.reservations(), decisions: repository.listDecisions() },
      products: repository.listProducts(),
      settings: { max_single_pct: settings.max_single_pct, liquidity_floor_pct: settings.liquidity_floor_pct, cash_needs: cashNeeds }, date,
      calculation_version: CALCULATION_VERSION };
  }
  function ledgerInput(date) {
    if (transactionManager.isActive()) return readLedger(date);
    repository.db.exec('BEGIN');
    try { const input = readLedger(date); repository.db.exec('COMMIT'); return input; }
    catch (error) { repository.db.exec('ROLLBACK'); throw error; }
  }
  function frozenInput() {
    const date = todayProvider();
    let sourceSnapshot = null, sourceIssue = null;
    try { sourceSnapshot = screening?.executionSnapshot() ?? null; }
    catch { sourceIssue = 'screening_unavailable'; }
    const input = { ...ledgerInput(date), sourceSnapshot,
      holdingSupplements: readHoldingSupplements(repository.dbPath, date) };
    return { input, sourceIssue, fingerprint: fingerprint(input) };
  }
  function status() {
    const state = store.state();
    return { contract: CONTRACT, contract_hash: CONTRACT_HASH, migrated: Boolean(state),
      mode: state?.mode ?? 'legacy', activation_seq: state?.activation_seq ?? 0,
      contract_matches: state ? state.contract_hash === CONTRACT_HASH : false,
      jobs: store.jobSummary(), watermark: store.watermark('strategy'),
      recommendation_ready: false, note: '推荐能力以当前公开数据可行性为准' };
  }
  function workspace() {
    const frozen = frozenInput();
    const previous = store.latestCompleted('strategy');
    return { ...status(), business_date: frozen.input.date, source_issue: frozen.sourceIssue,
      run_id: frozen.input.sourceSnapshot?.run?.id ?? null, input_fingerprint: frozen.fingerprint,
      result: previous?.result ?? null, stale: Boolean(previous && previous.input.frozen_input_hash !== frozen.fingerprint) };
  }
  function inboxItems({ today = todayProvider() } = {}) {
    const state = store.state();
    if (state?.mode !== 'v9') return [];
    const previous = store.latestCompleted('strategy');
    if (!previous?.result) return [];
    if ((previous.result.input?.activation_seq ?? null) !== state.activation_seq) return [];
    return buildStrategyInboxItems({ result: previous.result, mode: state.mode, today });
  }
  function preview({ expectedInputFingerprint } = {}) {
    const frozen = frozenInput();
    if (expectedInputFingerprint && expectedInputFingerprint !== frozen.fingerprint) throw strategyError('input_changed', '账户或公开证据已更新，请重新加载');
    const result = evaluate(frozen.input, engineOptions);
    return { input_fingerprint: frozen.fingerprint, source_issue: frozen.sourceIssue, persisted: false,
      result: compactStrategyResult(result) };
  }
  function recompute({ expectedInputFingerprint } = {}) {
    const frozen = frozenInput();
    if (expectedInputFingerprint && expectedInputFingerprint !== frozen.fingerprint) throw strategyError('input_changed', '账户或公开证据已更新，请重新加载');
    if (!['shadow', 'v9'].includes(frozen.input.state?.mode)) return preview({ expectedInputFingerprint: frozen.fingerprint });
    const seq = frozen.input.state.activation_seq;
    const job = store.enqueue({ eventType: 'strategy', expectedSeq: seq,
      input: { frozen_input_hash: frozen.fingerprint, business_date: frozen.input.date, activation_seq: seq } });
    if (job.status === 'done') return { job_id: job.id, result: job.result, persisted: true, existing: true, input_fingerprint: frozen.fingerprint };
    const claim = store.claim({ expectedSeq: seq, id: job.id });
    if (!claim) return { job_id: job.id, persisted: true, pending: true, input_fingerprint: frozen.fingerprint };
    const lease = { id: claim.id, token: claim.lease_token, expectedSeq: seq, inputHash: claim.input_hash };
    try {
      const result = evaluate(frozen.input, engineOptions);
      const current = frozenInput();
      if (current.fingerprint !== frozen.fingerprint) throw strategyError('input_changed', '计算期间账户或公开证据变化，请重算');
      const completed = store.complete(lease, () => {
        // A concurrent account write between the outside read and BEGIN
        // IMMEDIATE must not commit an old cash calculation.
        const { sourceSnapshot: ignored, holdingSupplements: ignoredSupplements, ...oldLedger } = frozen.input;
        if (fingerprint(ledgerInput(frozen.input.date)) !== fingerprint(oldLedger)) throw strategyError('input_changed', '提交前账户已变化，请重算');
        return compactStrategyResult(result);
      });
      return { job_id: job.id, persisted: true, result: completed.result, input_fingerprint: frozen.fingerprint };
    } catch (error) {
      try { store.fail(lease, error.code ?? 'calculation_failed'); } catch { /* Lost leases and activation changes cannot be overwritten. */ }
      throw error;
    }
  }
  return { status, workspace, inboxItems, preview, recompute, frozenInput, readLedgerInput: ledgerInput };
}

module.exports = { createStrategyService, monthEndWindow };
