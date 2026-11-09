'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CONTRACT_HASH } = require('../server/modules/r2-strategy/contract');
const { buildHoldingActionPlans } = require('../server/modules/r2-strategy/holding-actions');

const DATE = '2026-11-07';
const ID_A = { source: 'cmb', channel: 'D07', code: 'A' };
const ID_B = { source: 'cmb', channel: 'D07', code: 'B' };
const HOLDING = { lot_id: 'lot-1', holding_id: 11, product_code: 'A', product_name: '产品A',
  amount: 100000, confirm_date: '2026-08-01' };

function monitorRow(overrides = {}) {
  return { identity: ID_A, mapping: { product_code: 'A' }, holding_yield_state: 'pass',
    performance: { '1m': '3.00' }, performance_date: '2026-11-06', metrics: { drawdown: { band: 'normal' } },
    nav_fresh: true, term: { kind: 'minimum', days: 30 }, category: 'bond', detail: { equity_upper_pct: 0 },
    reference: { status: 'available', value_pct: 3.0 }, screening_status: 'qualified', rank: 1, run_id: 1,
    evidence_hash: 'c'.repeat(64), monitoring_verified: true, ...overrides };
}

function candidate({ code = 'B', termDays = 30, yieldPct = 3.6, rank = 1 } = {}) {
  return { identity: { source: 'cmb', channel: 'D07', code }, mapping: { product_code: code },
    name: `产品${code}`, group: `${termDays}/bond`, rank, evidence_hash: 'd'.repeat(64),
    automatic_eligible: true, term: { kind: 'minimum', days: termDays }, category: 'bond',
    reference: { status: 'available', value_pct: yieldPct }, quota: { status: 0, amount: null },
    min_amount: null, registration: null };
}

const PASS_PORTFOLIO = () => ({ ok: true, reasons: [], risk_not_worse: true, liquidity_not_worse: true });

function run({ rows = [monitorRow()], candidates = [], holdings = [HOLDING],
  validateReplacement = null, available = true } = {}) {
  const monitoringContext = { date: DATE, contract_hash: CONTRACT_HASH, fingerprint: 'monitor-fp',
    available: false, blockers: [], rows };
  const context = { ...monitoringContext, fingerprint: 'new-fp', available, rows: candidates };
  return buildHoldingActionPlans({ holdings, context, monitoringContext, date: DATE, validateReplacement });
}

test('低于门槛的日开持仓按账本可赎性生成可执行退出计划，费用与到账仍提示待核', () => {
  let validatorCalls = 0;
  const result = run({ rows: [monitorRow({ holding_yield_state: 'below', performance: { '1m': '2.14' } })],
    candidates: [candidate()],
    validateReplacement: () => { validatorCalls += 1; return PASS_PORTFOLIO(); } });
  const plan = result.plans[0];
  assert.equal(plan.state, 'exit_required');
  assert.equal(plan.action, '赎回');
  assert.equal(plan.planned_action, 'redeem');
  assert.equal(plan.executable, true);
  assert.deepEqual(plan.candidates, []);
  assert.equal(validatorCalls, 0, '退出分支不得进入替换经济性或组合复核');
  assert.deepEqual(plan.blockers, []);
  assert.ok(plan.warnings.some(text => text.includes('未核验')));
  assert.match(plan.dedupe_key, /^[a-f0-9]{64}$/);
});

test('仅售罄或未进前三不触发退出，也不把观察计划当成已成交赎回', () => {
  const result = run({ rows: [monitorRow({ screening_status: 'sold_out', rank: 8 })] });
  const plan = result.plans[0];
  assert.equal(result.monitoring.rows[0].state, 'hold');
  assert.equal(plan.action, '观察');
  assert.equal(plan.planned_action, 'review_holding');
  assert.equal(plan.state, 'hold');
  assert.equal(plan.executable, false);
  assert.deepEqual(plan.candidates, []);
  assert.ok(plan.blockers.includes('no_verified_replacement_candidates'));
});

test('回撤、期限或资产不符只做风险复核，不推成已成交赎回', () => {
  const result = run({ rows: [monitorRow({ term: { kind: 'minimum', days: 200 },
    detail: { equity_upper_pct: 6 }, nav_fresh: false })] });
  const monitor = result.monitoring.rows[0];
  assert.equal(monitor.state, 'risk_review');
  for (const code of ['term_risk_review', 'equity_limit_review', 'nav_evidence_unverified']) {
    assert.ok(monitor.risk_reasons.includes(code), code);
  }
  const plan = result.plans[0];
  assert.equal(plan.action, '观察');
  assert.equal(plan.executable, false);
  assert.ok(!plan.action.includes('赎回'));
  assert.deepEqual(plan.blockers, monitor.risk_reasons);
  assert.ok(plan.redemption, '风险复核仍展示赎回规则，但不形成赎回计划');
});

test('增量不足时只记录经济性未达标，不产生可执行替换', () => {
  const result = run({ holdings: [{ ...HOLDING, amount: 100 }], rows: [monitorRow()],
    candidates: [candidate({ yieldPct: 3.15 })], validateReplacement: PASS_PORTFOLIO });
  const plan = result.plans[0];
  assert.equal(plan.executable, false);
  assert.equal(plan.state, 'hold');
  assert.equal(plan.candidates[0].yield_edge_pp, 0.15);
  assert.equal(plan.candidates[0].min_gain_amount, 1);
  assert.equal(plan.candidates[0].economic_pass, false);
  assert.ok(plan.candidates[0].blockers.includes('switch_economics_not_met'));
});

test('经济性达标的短比较期替换因赎回费用未知而不可执行', () => {
  const result = run({ candidates: [candidate({ termDays: 30, yieldPct: 3.6 })], validateReplacement: PASS_PORTFOLIO });
  const plan = result.plans[0];
  assert.equal(plan.executable, false);
  assert.equal(plan.state, 'hold');
  assert.equal(plan.planned_action, 'review_holding');
  assert.equal(plan.comparison.days, 30);
  assert.equal(plan.comparison.end_date, '2026-12-07');
  assert.equal(plan.comparison.minimum_gain_amount, 33.33);
  const chosen = plan.candidates[0];
  assert.equal(chosen.economics, null);
  assert.equal(chosen.economic_pass, false);
  assert.ok(chosen.blockers.includes('redemption_fee_unverified'));
  assert.ok(chosen.blockers.includes('switch_economics_not_met'));
  assert.equal(chosen.executable, false);
  assert.match(plan.dedupe_key, /^[a-f0-9]{64}$/);
});

test('中长比较期按100/360天情景计算，最低增益随本金与天数变化', () => {
  const medium = run({ rows: [monitorRow({ term: { kind: 'minimum', days: 90 } })],
    candidates: [candidate({ termDays: 90, yieldPct: 3.6 })], validateReplacement: PASS_PORTFOLIO });
  assert.equal(medium.plans[0].executable, false);
  assert.equal(medium.plans[0].comparison.days, 100);
  assert.equal(medium.plans[0].comparison.minimum_gain_amount, 111.11);
  assert.equal(medium.plans[0].candidates[0].reinvestment_required, true);
  assert.match(medium.plans[0].candidates[0].reinvestment_note, /再投资/);

  const long = run({ rows: [monitorRow({ term: { kind: 'minimum', days: 180 } })],
    candidates: [candidate({ termDays: 180, yieldPct: 3.6 })], validateReplacement: PASS_PORTFOLIO });
  assert.equal(long.plans[0].executable, false);
  assert.equal(long.plans[0].comparison.days, 360);
  assert.equal(long.plans[0].comparison.minimum_gain_amount, 400);
});

test('候选超过190天上限不进入替换', () => {
  const tooLong = run({ rows: [monitorRow({ term: { kind: 'minimum', days: 180 } })],
    candidates: [candidate({ termDays: 200, yieldPct: 3.9 })], validateReplacement: PASS_PORTFOLIO });
  assert.deepEqual(tooLong.plans[0].candidates, []);
  assert.ok(tooLong.plans[0].blockers.includes('no_verified_replacement_candidates'));
});

test('组合复核同步执行并保留其风险与流动性阻断', () => {
  const seen = [];
  const result = run({ candidates: [candidate({ yieldPct: 3.6 })],
    validateReplacement: args => { seen.push(args); return { ok: false, reasons: ['family_concentration'],
      risk_not_worse: false, liquidity_not_worse: false }; } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].amount_cents, 10000000);
  assert.equal(seen[0].comparison_days, 30);
  assert.deepEqual(seen[0].candidate.identity, ID_B);
  assert.ok(seen[0].limits.product_key);
  assert.equal(typeof seen[0].limits.liquidity_eligible, 'boolean');
  const plan = result.plans[0];
  assert.equal(plan.executable, false);
  for (const code of ['family_concentration', 'replacement_risk_unverified', 'replacement_liquidity_unverified']) {
    assert.ok(plan.candidates[0].blockers.includes(code), code);
  }

  assert.throws(() => buildHoldingActionPlans({
    holdings: [HOLDING],
    context: { date: DATE, contract_hash: CONTRACT_HASH, fingerprint: 'n', available: true, blockers: [],
      rows: [candidate({ yieldPct: 3.6 })] },
    monitoringContext: { date: DATE, contract_hash: CONTRACT_HASH, fingerprint: 'm', available: false,
      blockers: [], rows: [monitorRow()] },
    date: DATE,
    validateReplacement: async () => PASS_PORTFOLIO() }), /同步/);
});

test('同一输入的计划、指纹和去重键稳定，强制退出键不随批次指纹变化', () => {
  const args = { rows: [monitorRow({ holding_yield_state: 'below', performance: { '1m': '2.10' } })] };
  const first = run(args);
  const second = run(args);
  assert.deepEqual(first.plans, second.plans);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(first), true);
  assert.match(first.plans[0].content_hash, /^[a-f0-9]{64}$/);

  const changedContext = buildHoldingActionPlans({
    holdings: [HOLDING],
    context: { date: DATE, contract_hash: CONTRACT_HASH, fingerprint: 'changed', available: true, blockers: [], rows: [] },
    monitoringContext: { date: DATE, contract_hash: CONTRACT_HASH, fingerprint: 'changed-monitor', available: false,
      blockers: [], rows: [monitorRow({ holding_yield_state: 'below', performance: { '1m': '2.10' } })] },
    date: DATE });
  assert.equal(changedContext.plans[0].dedupe_key, first.plans[0].dedupe_key);

  assert.throws(() => buildHoldingActionPlans({ holdings: [HOLDING],
    context: { date: '2026-11-08', contract_hash: CONTRACT_HASH, fingerprint: 'x', available: true, blockers: [], rows: [] },
    monitoringContext: { date: '2026-11-08', contract_hash: CONTRACT_HASH, fingerprint: 'y', available: false,
      blockers: [], rows: [] }, date: DATE }), /冻结上下文/);
});
