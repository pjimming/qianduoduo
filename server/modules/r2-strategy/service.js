'use strict';

const { todayShanghai } = require('../../../lib/metrics');
const { CONTRACT, CONTRACT_HASH, fingerprint } = require('./contract');
const { createStrategyRepository, strategyError, payload } = require('./repository');
const { evaluateStrategy, compactStrategyResult } = require('./engine');
const { adaptSnapshot, identityKey } = require('./evidence');
const { reviewPretrade } = require('./pretrade');
const { resolveHoldingRedemption } = require('./holdings');
const { buildStrategyInboxItems } = require('./inbox');
const { moneyCents } = require('./account');
const { createTransactionManager } = require('../../../lib/transaction');
const { isoDate } = require('../r2-screening/calendar');
const { readHoldingSupplements } = require('../../jobs/r2-holding-monitor-artifact');
const { combineHoldingEvidence } = require('./holding-evidence');
const { productFamilyKey } = require('../../../lib/products');

const ACTOR = 'local-user';
const HASH = /^[a-f0-9]{64}$/;
// Bump whenever engine/account/allocation output can change without a ledger
// write. It is part of the frozen input hash so a code change invalidates the
// persisted strategy job instead of reusing a stale result.
const CALCULATION_VERSION = 2;

function requiredText(value, name, max = 80) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw strategyError('invalid_input', `${name}格式不正确`, 400);
  }
  return value.trim();
}
function optionalText(value, name, max = 80) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, name, max);
}
function sequence(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw strategyError('invalid_input', `${name}必须为0以上的安全整数`, 400);
  return value;
}
function projectMapping(row) {
  return row ? { id: row.id, source: row.source, channel: row.channel, sales_code: row.sales_code,
    product_code: row.product_code, registration_code: row.registration_code ?? null,
    verified_at: row.verified_at, verified_by: row.verified_by, evidence_hash: row.evidence_hash } : null;
}
function projectCheck(row) {
  return row ? { id: row.id, mapping_id: row.mapping_id, lot_id: row.lot_id, version: row.version,
    facts: row.facts, verified_at: row.verified_at, verified_by: row.verified_by,
    content_hash: row.evidence_hash } : null;
}
function publicEvidence(row) {
  if (!row) return null;
  const value = { name: row.name, issuer: row.issuer, registration: row.registration ?? null,
    term: row.term ? { kind: row.term.kind, days: Number.isSafeInteger(row.term.days) ? row.term.days : null } : null,
    performance_date: row.performance_date ?? null,
    quota: row.quota ?? null, min_amount: row.min_amount ?? null,
    evidence_tier: row.evidence_tier ?? null,
    detail: row.detail ? { equity_upper_pct: row.detail.equity_upper_pct ?? null,
      valuation_basis: row.detail.valuation_basis ?? null, sale_channel: row.detail.sale_channel ?? null } : null,
    evidence: (row.evidence ?? []).map(item => ({ kind: item.kind, url: item.url, hash: item.hash,
      summary: item.summary ?? null })) };
  return value;
}

function factPaths(value, prefix = '') {
  if (value === null || value === undefined || value === '') return [];
  if (typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, item]) => factPaths(item, prefix ? `${prefix}.${key}` : key));
}

// Public evidence is safe to place into the form, but it is not a manual
// verification. Document hashes/versions are suggestions; read_and_verified and
// checked_on stay empty until the user confirms them.
function publicPrefill(row, product) {
  if (!row) return null;
  const facts = {};
  const prospectus = (row.evidence ?? []).find(item => item.kind === 'prospectus' &&
    HASH.test(item.summary?.document_hash ?? ''));
  const documentVersion = prospectus
    ? (typeof prospectus.summary?.disclosure_date === 'string' && prospectus.summary.disclosure_date.trim()
      ? prospectus.summary.disclosure_date.trim()
      : typeof prospectus.summary?.title === 'string' ? prospectus.summary.title.trim() : '')
    : '';
  if (row.term && ['minimum', 'closed'].includes(row.term.kind) && Number.isSafeInteger(row.term.days)) {
    facts.terms = { kind: row.term.kind, days: row.term.days };
  }
  if (prospectus && documentVersion) {
    const document = { hash: prospectus.summary.document_hash, version: documentVersion };
    facts.terms = { ...(facts.terms ?? {}), document: { ...document } };
    facts.assets = { prospectus: { ...document } };
  }
  if (Number.isFinite(row.detail?.equity_upper_pct)) {
    facts.assets = { ...(facts.assets ?? {}), equity_upper_pct: row.detail.equity_upper_pct };
  }
  const minimum = Number(row.min_amount);
  if (Number.isFinite(minimum) && minimum >= 0) {
    facts.allocation = { minimum_cents: Math.round(minimum * 100) };
  }
  const benchmark = String(product?.benchmark ?? '').replace(/\\s+/g, '').trim();
  if (benchmark && product?.code) {
    facts.allocation = { ...(facts.allocation ?? {}), strategy_family: {
      key: productFamilyKey(product), basis: 'benchmark_proxy',
      evidence_hash: fingerprint({ kind: 'benchmark_proxy', product_code: product.code, benchmark, source: 'product_master' }),
    } };
  }
  if (!Object.keys(facts).length) return null;
  return { facts, paths: factPaths(facts) };
}

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
    return { state: store.state(), mappings: store.listMappings(), checks: store.currentChecks(),
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
      recommendation_ready: false, note: '推荐能力以当前已核验配置和采纳复核为准' };
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
  function adaptedEvidence(input, monitoring = false) {
    try {
      const context = adaptSnapshot(input.sourceSnapshot, input.date, input.mappings);
      return monitoring && input.holdingSupplements?.length
        ? combineHoldingEvidence({ context, supplements: input.holdingSupplements, mappings: input.mappings, date: input.date }) : context;
    }
    catch { return null; }
  }
  function publicRow(adapted, identity) {
    return adapted?.rows.find(row => identityKey(row.identity) === identityKey(identity)) ?? null;
  }
  // Resolve a ledger product code to a published bank share without writing a
  // mapping. This is intentionally read-only: the user still confirms the
  // mapping before any pretrade fact can be saved.
  function matchShare({ productCode, source = 'cmb' } = {}) {
    const code = requiredText(productCode, '账本产品代码', 80);
    const sourceName = requiredText(source, '公开来源', 40);
    const adapted = adaptedEvidence(frozenInput().input, false);
    const seen = new Map();
    for (const row of adapted?.rows ?? []) {
      if (!row?.identity || String(row.identity.code) !== code || String(row.identity.source) !== sourceName) continue;
      const key = identityKey(row.identity);
      if (!seen.has(key)) seen.set(key, {
        source: row.identity.source,
        channel: row.identity.channel,
        code: row.identity.code,
        registration_code: row.registration ?? row.detail?.registration ?? null,
        name: row.name ?? null,
      });
    }
    const candidates = [...seen.values()];
    return { matched: candidates.length === 1, product_code: code, candidates };
  }
  function holdingFor(input, lotId) {
    return input.portfolio.holdings.find(row => String(row.lot_id) === lotId) ?? null;
  }
  function settlementTrade(input, lotId, mapping) {
    const match = /^trade:([1-9]\d*)$/.exec(lotId);
    if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
    const trade = input.portfolio.trades.find(row => row.id === Number(match[1]));
    if (!trade || trade.status !== 'confirmed' || trade.trade_type !== 'redeem' ||
        !mapping || trade.product_code !== mapping.product_code) {
      throw strategyError('invalid_input', '到账复核须关联同产品的已确认赎回交易', 400);
    }
    return trade;
  }
  function buildReview({ input, identity, mapping, lotId, check }) {
    const adapted = adaptedEvidence(input, Boolean(lotId));
    const row = publicRow(adapted, identity);
    if (lotId) {
      const trade = settlementTrade(input, lotId, mapping);
      if (trade) {
        const facts = check?.facts;
        const verified = facts?.kind === 'trade_settlement' && facts.status === 'verified' &&
          facts.trade_id === trade.id && facts.product_code === trade.product_code &&
          HASH.test(facts.evidence_hash ?? '') && isoDate(facts.arrival_date) &&
          facts.arrival_date >= (trade.confirm_date || trade.trade_date) && facts.arrival_date <= input.date;
        return { executable: Boolean(verified), blockers: verified ? [] : ['settlement_unverified'], limits: null };
      }
      const holding = holdingFor(input, lotId);
      if (!holding) throw strategyError('invalid_input', '持仓批次不属于当前账户', 400);
      if (mapping && String(holding.product_code) !== String(mapping.product_code)) {
        throw strategyError('invalid_input', '持仓批次与映射产品不一致', 400);
      }
      const redemption = resolveHoldingRedemption(holding, row, check, input.date);
      return { executable: redemption.redeemable_now === true,
        blockers: redemption.redeemable_now ? [] : [check ? redemption.reason : 'holding_redemption_unverified'],
        limits: null };
    }
    if (!row) return { executable: false, blockers: [mapping ? 'public_evidence_unavailable' : 'mapping_missing'], limits: null };
    return reviewPretrade({ row, check, date: input.date });
  }
  function review({ channel, code, lot = '', source = 'cmb' } = {}) {
    const salesChannel = requiredText(channel, '销售渠道', 40);
    const salesCode = requiredText(code, '销售份额', 80);
    const sourceName = requiredText(source, '公开来源', 40);
    const lotId = optionalText(lot, '持仓批次', 160) ?? '';
    const frozen = frozenInput();
    const input = frozen.input;
    const candidates = input.mappings.filter(row => !row.revoked_at && row.channel === salesChannel && row.sales_code === salesCode);
    const mapping = candidates.find(row => row.source === sourceName) ?? (candidates.length === 1 ? candidates[0] : null);
    const identity = mapping ? { source: mapping.source, channel: mapping.channel, code: mapping.sales_code }
      : { source: sourceName, channel: salesChannel, code: salesCode };
    if (lotId && !settlementTrade(input, lotId, mapping) && !holdingFor(input, lotId)) throw strategyError('invalid_input', '持仓批次不属于当前账户', 400);
    const check = mapping ? store.latestCheck(mapping.id, lotId) : null;
    const reviewBody = buildReview({ input, identity, mapping, lotId, check });
    const row = publicRow(adaptedEvidence(input, Boolean(lotId)), identity);
    const productCode = row?.mapping?.product_code ?? mapping?.product_code ?? null;
    const product = productCode ? (input.products ?? []).find(item => item.code === productCode) ?? null : null;
    return { identity, mapping: projectMapping(mapping), check: projectCheck(check),
      public_evidence: publicEvidence(row), suggestions: lotId ? null : publicPrefill(row, product), review: reviewBody,
      business_date: input.date, activation_seq: input.state?.activation_seq ?? 0, input_fingerprint: frozen.fingerprint };
  }
  function saveMapping(body = {}) {
    const source = requiredText(body.source, '公开来源', 40);
    const channel = requiredText(body.channel, '销售渠道', 40);
    const salesCode = requiredText(body.sales_code, '销售份额', 80);
    const productCode = requiredText(body.product_code, '账本产品代码', 80);
    const registration = optionalText(body.registration_code, '登记编码', 80);
    const date = todayProvider();
    const input = ledgerInput(date);
    const prior = input.mappings.find(row => !row.revoked_at && row.product_code === productCode) ?? null;
    // A repeated save of the same precise share is idempotent even though the
    // server timestamps differ. A different share must be an explicit supersede.
    if (prior && prior.source === source && prior.channel === channel && prior.sales_code === salesCode &&
        (prior.registration_code ?? null) === registration) return { mapping: projectMapping(prior), existing: true };
    const expectedSeq = body.expected_seq === undefined ? (input.state?.activation_seq ?? 0) : sequence(body.expected_seq, '策略序号');
    const supersedes = body.supersedes_id === undefined || body.supersedes_id === null ? null : sequence(body.supersedes_id, '被替换映射编号');
    const mapping = store.appendMapping({ expected_seq: expectedSeq, product_code: productCode, source, channel,
      sales_code: salesCode, registration_code: registration,
      evidence_hash: fingerprint({ source, channel, sales_code: salesCode, product_code: productCode, registration_code: registration }),
      verified_by: ACTOR, verified_at: new Date().toISOString(), supersedes_id: supersedes });
    return { mapping: projectMapping(mapping), existing: false };
  }
  function validateCheckFacts({ facts, mapping, lotId, trade, date }) {
    const factsJson = payload(facts);
    const value = JSON.parse(factsJson);
    const identity = { source: mapping.source, channel: mapping.channel, code: mapping.sales_code };
    if (!value.identity || identityKey(value.identity) !== identityKey(identity)) {
      throw strategyError('invalid_input', '复核事实的产品份额身份与映射不一致', 400);
    }
    if (trade) {
      if (value.kind !== 'trade_settlement' || value.payload_version !== 1 ||
          value.trade_id !== trade.id || value.product_code !== trade.product_code ||
          !HASH.test(value.evidence_hash ?? '') || !isoDate(value.arrival_date) ||
          value.arrival_date < (trade.confirm_date || trade.trade_date) ||
          (value.status === 'verified' && value.arrival_date > date)) {
        throw strategyError('invalid_input', '到账事实须包含同笔赎回、真实到账日和原始证据哈希', 400);
      }
    } else if (lotId) {
      if (value.kind !== 'holding_redemption') throw strategyError('invalid_input', '持仓批次复核必须为赎回事实', 400);
    } else if (value.kind !== 'product_pretrade' || value.payload_version !== 1) {
      throw strategyError('invalid_input', '产品复核必须为v1交易前复核事实', 400);
    }
    if (value.status !== undefined && !['verified', 'pending', 'withdrawn'].includes(value.status)) {
      throw strategyError('invalid_input', '复核状态无效', 400);
    }
    if (!lotId && (value.registration_code ?? null) !== (mapping.registration_code ?? null)) {
      throw strategyError('invalid_input', '复核事实的登记编码与映射不一致', 400);
    }
    return factsJson;
  }
  function saveCheck(body = {}) {
    if (!Number.isSafeInteger(body.mapping_id) || body.mapping_id < 1) throw strategyError('invalid_input', '映射编号无效', 400);
    const lotId = optionalText(body.lot_id, '持仓批次', 160) ?? '';
    const date = todayProvider();
    const input = frozenInput().input;
    const mapping = input.mappings.find(row => !row.revoked_at && row.id === body.mapping_id) ?? null;
    if (!mapping) throw strategyError('mapping_changed', '映射已撤回或不存在', 409);
    const trade = lotId ? settlementTrade(input, lotId, mapping) : null;
    if (lotId && !trade) {
      const holding = holdingFor(input, lotId);
      if (!holding) throw strategyError('invalid_input', '持仓批次不属于当前账户', 400);
      if (String(holding.product_code) !== String(mapping.product_code)) {
        throw strategyError('invalid_input', '持仓批次与映射产品不一致', 400);
      }
    }
    const factsJson = validateCheckFacts({ facts: body.facts, mapping, lotId, trade, date });
    const expectedSeq = body.expected_seq === undefined ? (input.state?.activation_seq ?? 0) : sequence(body.expected_seq, '策略序号');
    const supersedes = body.supersedes_id === undefined || body.supersedes_id === null ? null : sequence(body.supersedes_id, '被替换复核编号');
    const latest = store.latestCheck(mapping.id, lotId);
    const identity = { source: mapping.source, channel: mapping.channel, code: mapping.sales_code };
    if (latest && latest.facts_json === factsJson) {
      if (supersedes !== null && supersedes !== latest.id) throw strategyError('check_changed', '复核事实已变化，请重新加载', 409);
      return { check: projectCheck(latest), review: buildReview({ input, identity, mapping, lotId, check: latest }), existing: true };
    }
    const saved = store.appendCheck({ mappingId: mapping.id, lotId, supersedesId: supersedes, facts: JSON.parse(factsJson),
      verifiedBy: ACTOR, verifiedAt: new Date().toISOString(), expectedSeq });
    return { check: projectCheck(saved), review: buildReview({ input, identity, mapping, lotId, check: saved }), existing: false };
  }
  return { status, workspace, inboxItems, preview, recompute, review, matchShare, saveMapping, saveCheck,
    frozenInput, readLedgerInput: ledgerInput };
}

module.exports = { createStrategyService, monthEndWindow };
