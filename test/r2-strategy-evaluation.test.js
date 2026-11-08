'use strict';

// 冻结净收益评价（v9 结果评价）专项测试。
// 全部用例使用真实的 v9 投影、真实的执行快照和真实的个人收益事实，
// 只替换输入事实，不 mock 被测逻辑本身。

const test = require('node:test');
const assert = require('node:assert/strict');
const { strategyFixture } = require('./fixtures/r2-strategy.cjs');
const { evaluateStrategy } = require('../server/modules/r2-strategy/engine');
const {
  buildExecutionSnapshot,
} = require('../server/modules/r2-strategy/snapshot');
const {
  measureFrozenNetPnl,
  evaluateExecutionDecision,
} = require('../server/modules/r2-strategy/evaluation');
const { evaluatePrediction } = require('../lib/decision-calibration');
const {
  effectiveCoveredYieldDates,
} = require('../lib/product-income-coverage');
const { shift } = require('../server/modules/r2-screening/calendar');

const BUSINESS_DATE = '2026-11-07';
const DECISION_ID = 9001;
const BUY_ID = 101;
const REDEEM_ID = 201;
const TODAY_AFTER_ARRIVAL = '2026-12-12';

function build({ feeBps = 0, code = null } = {}) {
  const input = strategyFixture();
  if (feeBps) {
    for (const check of input.checks) check.facts.fees.purchase_bps = feeBps;
  }
  const result = evaluateStrategy(input);
  const selected = result.allocation.rows.find(
    (row) => row.amount_cents > 0 && (!code || row.identity.code === code),
  );
  const row = result.evidence.rows.find(
    (item) => item.identity.code === selected.identity.code,
  );
  const check = input.checks.find((item) => item.mapping_id === row.mapping.id);
  const snapshot = buildExecutionSnapshot({
    input,
    result,
    row,
    check,
    amountCents: selected.amount_cents,
  });
  return {
    input,
    result,
    row,
    check,
    snapshot,
    code: snapshot.mapping.product_code,
    amountCents: snapshot.amount_cents,
  };
}

function decisionFor(base, { review_meta: reviewMeta = {}, ...rest } = {}) {
  return {
    id: DECISION_ID,
    date: BUSINESS_DATE,
    action: '买入',
    strategy_version: 'r2-v9-frozen-test',
    review_meta: {
      execution_snapshot: JSON.parse(JSON.stringify(base.snapshot)),
      ...reviewMeta,
    },
    ...rest,
  };
}

function buyTrade(base, extra = {}) {
  return {
    id: BUY_ID,
    decision_id: DECISION_ID,
    trade_type: 'buy',
    status: 'confirmed',
    product_code: base.code,
    amount: base.amountCents / 100,
    trade_date: BUSINESS_DATE,
    confirm_date: base.snapshot.forecast.confirm_date,
    screenshot_id: 'synthetic-screenshot',
    ...extra,
  };
}

function redeemTrade(base, extra = {}) {
  return {
    id: REDEEM_ID,
    decision_id: DECISION_ID,
    trade_type: 'redeem',
    status: 'confirmed',
    product_code: base.code,
    amount: base.amountCents / 100,
    settlement_amount: 30.42,
    trade_date: base.snapshot.forecast.redemption_date,
    confirm_date: base.snapshot.forecast.redemption_date,
    ...extra,
  };
}

// 周末收益由周一记录按现有口径覆盖；首个冻结日恰为周一时必须显式限定
// 覆盖范围，否则周末收益会落到冻结比较期之外。
function valuationRows(base, { dailyPnl = 0.02, skip = [], mutate } = {}) {
  const rows = [];
  let id = 0;
  for (
    let date = base.snapshot.forecast.confirm_date;
    date < base.snapshot.forecast.redemption_date;
    date = shift(date, 1)
  ) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (skip.includes(date)) continue;
    rows.push({
      id: ++id,
      product_code: base.code,
      yield_date: date,
      holding_amount: base.amountCents / 100,
      daily_pnl: dailyPnl,
      notes:
        date === base.snapshot.forecast.confirm_date
          ? `覆盖收益日期：${date} 至 ${date}`
          : '',
    });
  }
  if (mutate) mutate(rows);
  return rows;
}

function settlement(base, extra = {}) {
  return {
    trade_id: REDEEM_ID,
    status: 'verified',
    product_code: base.code,
    evidence_hash: 'a'.repeat(64),
    arrival_date: base.snapshot.forecast.end_date,
    ...extra,
  };
}

function closingAllocation(extra = {}) {
  return {
    id: 1,
    buy_trade_id: BUY_ID,
    redeem_trade_id: REDEEM_ID,
    principal: 30,
    realized_pnl: 0.42,
    ...extra,
  };
}

test('历史决策没有可验证的冻结快照时保持 historical_unfrozen，不借当前全局参数补造评价', () => {
  const base = build();
  const decision = {
    id: DECISION_ID,
    date: BUSINESS_DATE,
    action: '买入',
    strategy_version: 'r2-3pct-v1',
    review_meta: {},
  };
  const measured = measureFrozenNetPnl({
    decision,
    trades: [buyTrade(base)],
    today: '2027-01-01',
  });
  assert.equal(measured.available, false);
  assert.equal(measured.reason, 'historical_unfrozen');
  assert.equal(measured.actual, null);

  const tampered = decisionFor(base);
  tampered.review_meta.execution_snapshot.amount_cents += 100;
  assert.equal(
    measureFrozenNetPnl({
      decision: tampered,
      trades: [buyTrade(base)],
      today: '2027-01-01',
    }).reason,
    'historical_unfrozen',
  );

  const candidates = evaluateExecutionDecision({
    decision,
    trades: [buyTrade(base)],
    today: '2027-06-01',
    // 旧全局 hurdle 即使存在也不得参与新执行版本评价。
    settings: { hurdle_short: 99, hurdle_medium: 99, hurdle_long: 99 },
  });
  assert.equal(candidates.length, 1);
  const [run] = candidates;
  assert.equal(run.stage, 'buy_day');
  assert.equal(run.rule_version, 'r2-3pct-v1:historical-unfrozen');
  // 历史未冻结时流程本身无法核验，保持待补证据而不是伪判通过/失败。
  assert.equal(run.process_ok, null);
  assert.equal(run.outcome, 'unknown');
  assert.equal(run.rating, '待评估');
  assert.equal(run.confidence, 45);
  assert.equal(run.confidence_level, 'low');
  assert.equal(run.evidence.historical_basis, 'historical_unfrozen');
  assert.equal(run.evidence.evaluation_contract, null);
  assert.equal(
    run.evidence.checks.find((item) => item.key === 'frozen-contract').pass,
    false,
  );
  assert.match(run.summary, /历史未冻结/);
});

test('冻结持有期内的已记录产品收益给出 confirmed_product_income，并按冻结容差判为结果好', () => {
  const base = build();
  const decision = decisionFor(base, {
    review_meta: {
      execution_portfolio_check: {
        verified: true,
        principal_cents: 10000,
        constraints_pass: true,
      },
    },
  });
  const trades = [buyTrade(base)];
  const valuations = valuationRows(base);
  assert.equal(valuations.length, 22);

  const measured = measureFrozenNetPnl({
    decision,
    trades,
    valuations,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(measured.available, true);
  assert.equal(measured.reason, 'confirmed_product_income');
  assert.equal(measured.actual, 44);
  assert.equal(
    measured.evidence.basis,
    'product_daily_valuations',
  );
  assert.equal(measured.evidence.attribution, 'confirmed_principal_prorata');
  assert.equal(measured.evidence.realization, 'booked_not_redeemed');
  assert.equal(measured.evidence.start_date, base.snapshot.forecast.confirm_date);
  assert.equal(
    measured.evidence.end_exclusive,
    base.snapshot.forecast.redemption_date,
  );
  assert.equal(measured.evidence.observed_records, 22);
  assert.equal(measured.evidence.covered_days, 30);
  assert.equal(measured.evidence.actual_fee_cents, 0);

  const candidates = evaluateExecutionDecision({
    decision,
    trades,
    valuations,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(candidates.length, 2);
  const [buyDay, maturity] = candidates;
  assert.equal(buyDay.process_ok, true);
  assert.equal(buyDay.confidence, 85);
  assert.equal(maturity.stage, 'maturity');
  assert.equal(maturity.period, base.snapshot.forecast.end_date);
  assert.equal(maturity.rule_version, base.snapshot.evaluation_contract.version);
  assert.equal(maturity.outcome, 'good');
  assert.equal(maturity.rating, '流程正确，结果好');
  assert.equal(maturity.confidence, 90);
  assert.equal(maturity.confidence_level, 'high');
  assert.equal(maturity.evidence.result.reason, 'confirmed_product_income');
  assert.equal(maturity.evidence.result.actual, 44);
  assert.equal(maturity.evidence.target_annualized_pct, 3);
  assert.equal(maturity.evidence.target_is_selection_hurdle, false);
  assert.match(maturity.summary, /44分/);
  assert.ok(
    44 >=
      base.snapshot.forecast.expected_net_pnl_cents -
        base.snapshot.evaluation_contract.result_tolerance_cents,
  );
});

test('结果低于冻结情景时判为结果差，0 元事实不被当成缺失或由公开净值补齐', () => {
  const base = build();
  const decision = decisionFor(base, {
    review_meta: {
      execution_portfolio_check: {
        verified: true,
        principal_cents: 10000,
        constraints_pass: true,
      },
    },
  });
  const valuations = valuationRows(base, {
    dailyPnl: 0,
    mutate: (rows) => {
      for (const row of rows) row.notes = `${row.notes}已确认无收益`.trim();
    },
  });
  const measured = measureFrozenNetPnl({
    decision,
    trades: [buyTrade(base)],
    valuations,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(measured.available, true);
  assert.equal(measured.actual, 0);

  const [, maturity] = evaluateExecutionDecision({
    decision,
    trades: [buyTrade(base)],
    valuations,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(maturity.outcome, 'bad');
  assert.equal(maturity.rating, '流程正确，结果差');
  assert.match(maturity.summary, /低于原情景/);
  assert.ok(
    0 <
      base.snapshot.forecast.expected_net_pnl_cents -
        base.snapshot.evaluation_contract.result_tolerance_cents,
  );
});

test('容差边界包含等号：达到 期望-容差 判好，低 1 分判差', () => {
  const base = build();
  const decision = decisionFor(base);
  const boundary =
    base.snapshot.forecast.expected_net_pnl_cents -
    base.snapshot.evaluation_contract.result_tolerance_cents;
  assert.ok(boundary > 0);

  const at = valuationRows(base, { dailyPnl: 0 });
  at[0].daily_pnl = boundary / 100;
  const good = measureFrozenNetPnl({
    decision,
    trades: [buyTrade(base)],
    valuations: at,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(good.available, true);
  assert.equal(good.actual, boundary);

  const below = valuationRows(base, { dailyPnl: 0 });
  below[0].daily_pnl = (boundary - 1) / 100;
  const bad = measureFrozenNetPnl({
    decision,
    trades: [buyTrade(base)],
    valuations: below,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(bad.actual, boundary - 1);

  const outcomeFor = (valuations) =>
    evaluateExecutionDecision({
      decision,
      trades: [buyTrade(base)],
      valuations,
      today: TODAY_AFTER_ARRIVAL,
    })[1].outcome;
  assert.equal(outcomeFor(at), 'good');
  assert.equal(outcomeFor(below), 'bad');
});

test('到账日之前不生成到期评价：before_review_date 只保留买入日流程评价', () => {
  const base = build();
  const decision = decisionFor(base);
  const trades = [buyTrade(base)];
  const valuations = valuationRows(base);

  assert.equal(
    measureFrozenNetPnl({
      decision,
      trades,
      valuations,
      today: '2026-12-10',
    }).reason,
    'before_review_date',
  );
  const candidates = evaluateExecutionDecision({
    decision,
    trades,
    valuations,
    today: '2026-12-10',
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].stage, 'buy_day');
});

test('缺少任一冻结持有日收益时进入 product_income_coverage_incomplete，并列出缺失日', () => {
  const base = build();
  const decision = decisionFor(base);
  const valuations = valuationRows(base, { skip: ['2026-11-20'] });
  const measured = measureFrozenNetPnl({
    decision,
    trades: [buyTrade(base)],
    valuations,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(measured.available, false);
  assert.equal(measured.reason, 'product_income_coverage_incomplete');
  assert.equal(measured.evidence.observed_records, 21);
  assert.equal(measured.evidence.covered_days, 29);
  assert.equal(measured.evidence.expected_days, 30);
  assert.deepEqual(measured.evidence.missing_dates, ['2026-11-20']);

  const [, maturity] = evaluateExecutionDecision({
    decision,
    trades: [buyTrade(base)],
    valuations,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(maturity.outcome, 'unknown');
  assert.equal(maturity.rating, '待评估');
  assert.match(maturity.summary, /product_income_coverage_incomplete/);
});

test('同一收益日重复事实判为 duplicate_product_fact，不任选一条计收益', () => {
  const base = build();
  const valuations = valuationRows(base);
  valuations.push({ ...valuations[3], id: 999 });
  const measured = measureFrozenNetPnl({
    decision: decisionFor(base),
    trades: [buyTrade(base)],
    valuations,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(measured.available, false);
  assert.equal(measured.reason, 'duplicate_product_fact');
});

test('合并披露覆盖到冻结比较期之外时判为 combined_period_ambiguous', () => {
  const base = build();
  // 首个冻结日正好是周一：默认周末覆盖会落到确认日之前。
  const valuations = valuationRows(base, {
    mutate: (rows) => {
      rows[0].notes = '';
    },
  });
  const measured = measureFrozenNetPnl({
    decision: decisionFor(base),
    trades: [buyTrade(base)],
    valuations,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(measured.available, false);
  assert.equal(measured.reason, 'combined_period_ambiguous');
});

test('持仓分母与整体本金不一致时判为 holding_attribution_unverified', () => {
  const base = build();
  const valuations = valuationRows(base, {
    mutate: (rows) => {
      rows[5].holding_amount += 1;
    },
  });
  const measured = measureFrozenNetPnl({
    decision: decisionFor(base),
    trades: [buyTrade(base)],
    valuations,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(measured.available, false);
  assert.equal(measured.reason, 'holding_attribution_unverified');
});

test('产品收益不是有限数字时判为 product_pnl_unverified', () => {
  const base = build();
  const valuations = valuationRows(base, {
    mutate: (rows) => {
      rows[5].daily_pnl = null;
    },
  });
  const measured = measureFrozenNetPnl({
    decision: decisionFor(base),
    trades: [buyTrade(base)],
    valuations,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(measured.available, false);
  assert.equal(measured.reason, 'product_pnl_unverified');
});

test('冻结情景含费用但缺少已核费用凭证时判为 actual_fees_unverified，补齐后才净额扣费', () => {
  const base = build({ feeBps: 500 });
  assert.ok(base.snapshot.forecast.expected_net_pnl_cents < 0);
  const valuations = valuationRows(base);
  const trades = [buyTrade(base)];

  assert.equal(
    measureFrozenNetPnl({
      decision: decisionFor(base),
      trades,
      valuations,
      today: TODAY_AFTER_ARRIVAL,
    }).reason,
    'actual_fees_unverified',
  );
  assert.equal(
    measureFrozenNetPnl({
      decision: decisionFor(base, {
        review_meta: {
          execution_costs: {
            verified: true,
            evidence_hash: 'not-a-hash',
            purchase_cents: 150,
            redemption_cents: 50,
          },
        },
      }),
      trades,
      valuations,
      today: TODAY_AFTER_ARRIVAL,
    }).reason,
    'actual_fees_unverified',
  );

  const verified = measureFrozenNetPnl({
    decision: decisionFor(base, {
      review_meta: {
        execution_costs: {
          verified: true,
          evidence_hash: 'b'.repeat(64),
          purchase_cents: 150,
          redemption_cents: 50,
        },
      },
    }),
    trades,
    valuations,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(verified.available, true);
  assert.equal(verified.actual, 44 - 200);
  assert.equal(verified.evidence.actual_fee_cents, 200);
});

test('实际金额与冻结金额不一致时判为 execution_amount_changed 并保留两端口径', () => {
  const base = build();
  const measured = measureFrozenNetPnl({
    decision: decisionFor(base),
    trades: [buyTrade(base, { amount: base.amountCents / 100 - 0.5 })],
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(measured.available, false);
  assert.equal(measured.reason, 'execution_amount_changed');
  assert.deepEqual(measured.evidence, {
    invested_cents: base.amountCents - 50,
    expected_cents: base.amountCents,
  });
});

test('确认日偏离冻结比较期时判为 comparison_period_changed，不改用实际区间重算', () => {
  const base = build();
  const measured = measureFrozenNetPnl({
    decision: decisionFor(base),
    trades: [
      buyTrade(base, { confirm_date: shift(base.snapshot.forecast.confirm_date, 1) }),
    ],
    valuations: valuationRows(base),
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(measured.available, false);
  assert.equal(measured.reason, 'comparison_period_changed');
});

test('部分赎回不假设剩余本金收益，判为 partial_redemption', () => {
  const base = build();
  const measured = measureFrozenNetPnl({
    decision: decisionFor(base),
    trades: [buyTrade(base), redeemTrade(base)],
    valuations: valuationRows(base),
    allocations: [closingAllocation({ principal: 20, realized_pnl: 2 })],
    settlements: [settlement(base)],
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(measured.available, false);
  assert.equal(measured.reason, 'partial_redemption');
  assert.deepEqual(measured.evidence, {
    redeemed_cents: 2000,
    invested_cents: 3000,
  });
});

test('赎回已确认但到账金额或已实现收益缺失时判为 settlement_amount_unverified', () => {
  const base = build();
  // 赎回尚未确认属于执行未确认，优先于到账金额核验。
  assert.equal(
    measureFrozenNetPnl({
      decision: decisionFor(base),
      trades: [buyTrade(base), redeemTrade(base, { status: 'pending' })],
      valuations: valuationRows(base),
      allocations: [closingAllocation()],
      settlements: [settlement(base)],
      today: TODAY_AFTER_ARRIVAL,
    }).reason,
    'unconfirmed_execution',
  );

  const measured = measureFrozenNetPnl({
    decision: decisionFor(base),
    trades: [buyTrade(base), redeemTrade(base, { settlement_amount: null })],
    valuations: valuationRows(base),
    allocations: [closingAllocation()],
    settlements: [settlement(base)],
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(measured.available, false);
  assert.equal(measured.reason, 'settlement_amount_unverified');

  const missingTrade = measureFrozenNetPnl({
    decision: decisionFor(base),
    trades: [buyTrade(base)],
    allocations: [closingAllocation()],
    settlements: [settlement(base)],
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(missingTrade.reason, 'settlement_amount_unverified');
});

test('到账凭证缺失或晚于评价日时判为 settlement_arrival_unverified', () => {
  const base = build();
  const decision = decisionFor(base);
  const baseInput = {
    decision,
    trades: [buyTrade(base), redeemTrade(base)],
    allocations: [closingAllocation()],
    today: TODAY_AFTER_ARRIVAL,
  };
  assert.equal(
    measureFrozenNetPnl({ ...baseInput, settlements: [] }).reason,
    'settlement_arrival_unverified',
  );
  assert.equal(
    measureFrozenNetPnl({
      ...baseInput,
      settlements: [settlement(base, { arrival_date: '2026-12-13' })],
    }).reason,
    'settlement_arrival_unverified',
  );
  assert.equal(
    measureFrozenNetPnl({
      ...baseInput,
      settlements: [settlement(base, { evidence_hash: 'xyz' })],
    }).reason,
    'settlement_arrival_unverified',
  );
});

test('已确认现金到账按实际净收益评价；到账日偏离冻结比较期同样判为比较期变更', () => {
  const base = build();
  const decision = decisionFor(base);
  const measured = measureFrozenNetPnl({
    decision,
    trades: [buyTrade(base), redeemTrade(base)],
    allocations: [closingAllocation()],
    settlements: [settlement(base)],
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(measured.available, true);
  assert.equal(measured.reason, 'confirmed_cash_settlement');
  assert.equal(measured.actual, 42);
  assert.equal(measured.evidence.basis, 'confirmed_settlement_allocation');
  assert.equal(measured.evidence.realization, 'settled_cash');
  assert.deepEqual(measured.evidence.allocation_ids, [1]);
  assert.deepEqual(measured.evidence.trade_ids, [BUY_ID]);
  assert.deepEqual(measured.evidence.settlement_trade_ids, [REDEEM_ID]);

  const [, maturity] = evaluateExecutionDecision({
    decision,
    trades: [buyTrade(base), redeemTrade(base)],
    allocations: [closingAllocation()],
    settlements: [settlement(base)],
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(maturity.outcome, 'good');
  assert.equal(maturity.evidence.result.evidence.realization, 'settled_cash');

  assert.equal(
    measureFrozenNetPnl({
      decision,
      trades: [buyTrade(base), redeemTrade(base)],
      allocations: [closingAllocation()],
      settlements: [settlement(base, { arrival_date: '2026-12-10' })],
      today: TODAY_AFTER_ARRIVAL,
    }).reason,
    'comparison_period_changed',
  );
});

test('未确认执行与未执行分开：pending 交易、无目标买入、无关联交易各有明确原因', () => {
  const base = build();
  const decision = decisionFor(base);
  assert.equal(
    measureFrozenNetPnl({ decision, trades: [], today: TODAY_AFTER_ARRIVAL }).reason,
    'not_executed',
  );
  assert.equal(
    measureFrozenNetPnl({
      decision,
      trades: [buyTrade(base, { status: 'pending' })],
      today: TODAY_AFTER_ARRIVAL,
    }).reason,
    'unconfirmed_execution',
  );
  assert.equal(
    measureFrozenNetPnl({
      decision,
      trades: [buyTrade(base), redeemTrade(base, { status: 'pending' })],
      today: TODAY_AFTER_ARRIVAL,
    }).reason,
    'unconfirmed_execution',
  );
  assert.equal(
    measureFrozenNetPnl({
      decision,
      trades: [buyTrade(base), buyTrade(base, { id: 102, status: 'cancelled' })],
      valuations: [],
      today: TODAY_AFTER_ARRIVAL,
    }).reason,
    'product_income_coverage_incomplete',
  );
  assert.equal(
    measureFrozenNetPnl({
      decision,
      trades: [buyTrade(base, { status: 'cancelled' })],
      today: TODAY_AFTER_ARRIVAL,
    }).reason,
    'not_executed',
  );
});

test('组合分母使用交易后整体组合本金，单张提案金额不进入集中度分母', () => {
  const base = build();
  const decision = decisionFor(base, {
    review_meta: {
      execution_portfolio_check: {
        verified: true,
        principal_cents: 10000,
        constraints_pass: true,
      },
    },
  });
  const [buyDay] = evaluateExecutionDecision({
    decision,
    trades: [buyTrade(base)],
    today: '2026-11-10',
  });
  assert.equal(base.snapshot.portfolio.principal_cents, 10000);
  assert.equal(base.snapshot.amount_cents, 3000);
  assert.equal(
    base.snapshot.allocation.full_investment,
    true,
  );
  const whole = buyDay.evidence.checks.find(
    (item) => item.key === 'whole-portfolio',
  );
  assert.equal(whole.pass, true);
  assert.match(whole.detail, /统一组合本金10000分/);
  assert.match(whole.detail, /不以本张提案金额作分母/);
  const actual = buyDay.evidence.checks.find(
    (item) => item.key === 'actual-portfolio',
  );
  assert.equal(actual.pass, true);
  assert.match(actual.detail, /实际统一组合本金10000分/);
  assert.equal(buyDay.process_ok, true);

  const mismatch = evaluateExecutionDecision({
    decision: decisionFor(base, {
      review_meta: {
        execution_portfolio_check: {
          verified: true,
          principal_cents: 10000,
          constraints_pass: false,
        },
      },
    }),
    trades: [buyTrade(base)],
    today: '2026-11-10',
  })[0];
  assert.equal(mismatch.process_ok, false);
  assert.match(mismatch.summary, /有执行偏差/);
});

test('实际交易后组合未核验时流程保持待确认，不用原计划替代实际敞口', () => {
  const base = build();
  const [buyDay] = evaluateExecutionDecision({
    decision: decisionFor(base),
    trades: [buyTrade(base)],
    today: '2026-11-10',
  });
  assert.equal(buyDay.process_ok, null);
  assert.equal(buyDay.confidence, 45);
  assert.equal(buyDay.confidence_level, 'low');
  const actual = buyDay.evidence.checks.find(
    (item) => item.key === 'actual-portfolio',
  );
  assert.equal(actual.pass, null);
  assert.match(actual.detail, /待核/);
});

test('执行时点、截图链与执行偏差进入流程判定，冻结版本与去重键保持稳定', () => {
  const base = build();
  const late = evaluateExecutionDecision({
    decision: decisionFor(base),
    trades: [buyTrade(base, { trade_date: '2026-11-08' })],
    today: '2026-11-10',
  })[0];
  assert.equal(
    late.evidence.checks.find((item) => item.key === 'execution-window').pass,
    false,
  );
  assert.equal(late.process_ok, false);

  const noShot = evaluateExecutionDecision({
    decision: decisionFor(base),
    trades: [buyTrade(base, { screenshot_id: null })],
    today: '2026-11-10',
  })[0];
  assert.equal(
    noShot.evidence.checks.find((item) => item.key === 'screenshots').pass,
    null,
  );
  assert.equal(noShot.process_ok, null);

  const deviated = evaluateExecutionDecision({
    decision: decisionFor(base, {
      review_meta: {
        execution_portfolio_check: {
          verified: true,
          principal_cents: 10000,
          constraints_pass: true,
        },
        execution_deviation: { excess: [{ excess_cents: 1000 }] },
      },
    }),
    trades: [buyTrade(base)],
    today: '2026-11-10',
  })[0];
  assert.equal(
    deviated.evidence.checks.find(
      (item) => item.key === 'execution-deviation',
    ).pass,
    false,
  );
  assert.equal(deviated.process_ok, false);
  assert.equal(deviated.evidence.snapshot_hash, base.snapshot.snapshot_hash);
  assert.equal(
    deviated.rule_version,
    base.snapshot.evaluation_contract.version,
  );
  assert.equal(deviated.auto_confidence_threshold, 75);
  assert.equal(deviated.dedupe_key, `decision:${DECISION_ID}:buy_day:${BUSINESS_DATE}`);
});

test('到期评价沿用冻结比较期生成稳定去重键，不受 decision.evaluation_at 或全局 hurdle 影响', () => {
  const base = build();
  const decision = decisionFor(base, { evaluation_at: ['maturity'] });
  const candidates = evaluateExecutionDecision({
    decision,
    trades: [buyTrade(base)],
    valuations: valuationRows(base),
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.deepEqual(
    candidates.map((item) => item.stage),
    ['buy_day', 'maturity'],
  );
  assert.equal(
    candidates[0].dedupe_key,
    `decision:${DECISION_ID}:buy_day:${BUSINESS_DATE}`,
  );
  assert.equal(
    candidates[1].dedupe_key,
    `decision:${DECISION_ID}:maturity:${base.snapshot.forecast.end_date}`,
  );
  for (const run of candidates) {
    assert.equal(run.rule_version, base.snapshot.evaluation_contract.version);
    assert.equal(run.evidence.evaluation_contract.min_observations, 7);
    assert.equal(run.evidence.evaluation_contract.result_metric, 'net_pnl_cents');
  }
});

test('v9 校准只接受冻结净收益口径：命中/未命中/证据不足/比较期失效分别映射', () => {
  const base = build();
  const decision = decisionFor(base);
  const trades = [buyTrade(base)];
  const valuations = valuationRows(base);
  const prediction = {
    review_date: base.snapshot.forecast.end_date,
    expected: { direction: 'at_least', target: { point: 40, unit: 'cent' } },
    evaluation: {
      method: 'v9_frozen_net_pnl',
      metric: 'net_pnl_cents',
      tolerance_abs: 0,
    },
    invalidation_triggers: ['decision_cancelled'],
  };

  const hit = evaluatePrediction({
    prediction,
    decision,
    trades,
    valuations,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(hit.status, 'hit');
  assert.equal(hit.reason_code, 'target_met');
  assert.equal(hit.actual, 44);
  assert.equal(hit.data_as_of, base.snapshot.forecast.end_date);
  assert.equal(hit.numeric_error, 4);

  const miss = evaluatePrediction({
    prediction: {
      ...prediction,
      expected: { direction: 'at_least', target: { point: 45, unit: 'cent' } },
    },
    decision,
    trades,
    valuations,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(miss.status, 'miss');
  assert.equal(miss.numeric_error, -1);

  const insufficient = evaluatePrediction({
    prediction,
    decision,
    trades,
    valuations: valuationRows(base, { skip: ['2026-11-20'] }),
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(insufficient.status, 'insufficient_data');
  assert.equal(insufficient.reason_code, 'product_income_coverage_incomplete');

  const changed = evaluatePrediction({
    prediction,
    decision,
    trades: [
      buyTrade(base, { confirm_date: shift(base.snapshot.forecast.confirm_date, 1) }),
    ],
    valuations,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(changed.status, 'invalidated');
  assert.equal(changed.reason_code, 'comparison_period_changed');

  const unfrozen = evaluatePrediction({
    prediction,
    decision: { ...decision, review_meta: {} },
    trades,
    valuations,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(unfrozen.status, 'insufficient_data');
  assert.equal(unfrozen.reason_code, 'historical_unfrozen');

  const pending = evaluatePrediction({
    prediction: { ...prediction, review_date: TODAY_AFTER_ARRIVAL },
    decision,
    trades,
    valuations,
    today: '2026-12-11',
  });
  assert.equal(pending.status, 'pending');
});

test('季度边界按冻结比较期归属：跨年收益逐日计入，期外事实不参与', () => {
  const base = build({ code: 'M1' });
  assert.equal(base.snapshot.forecast.confirm_date, '2026-11-09');
  assert.equal(base.snapshot.forecast.redemption_date, '2027-02-07');
  const decision = decisionFor(base);
  const rows = valuationRows(base, {
    mutate(list) {
      // 冻结比较期之前/之后的事实都不属于本次评价。
      list.push({
        id: 900,
        product_code: base.code,
        yield_date: '2026-11-06',
        holding_amount: base.amountCents / 100,
        daily_pnl: 999,
        notes: '',
      });
      list.push({
        id: 901,
        product_code: base.code,
        yield_date: '2027-02-08',
        holding_amount: base.amountCents / 100,
        daily_pnl: 999,
        notes: '',
      });
    },
  });
  const inWindow = rows.filter(
    (row) => row.yield_date >= '2026-11-09' && row.yield_date < '2027-02-07',
  );
  // 比较期确实跨越月末与年末/季末。
  assert.ok(inWindow.some((row) => row.yield_date === '2026-11-30'));
  assert.ok(inWindow.some((row) => row.yield_date === '2026-12-01'));
  assert.ok(inWindow.some((row) => row.yield_date === '2026-12-31'));
  assert.ok(inWindow.some((row) => row.yield_date === '2027-01-01'));

  const measured = measureFrozenNetPnl({
    decision,
    trades: [buyTrade(base)],
    valuations: rows,
    today: '2027-02-10',
  });
  assert.equal(measured.available, false);
  assert.equal(measured.reason, 'product_income_coverage_incomplete');
  // 12-31、01-01、01-04 等跨月/跨年行都已按自然日计入；唯一缺口是期末周末：
  // 比较期在 2027-02-07（周日）结束，02-06 的收益要等 02-08（周一）才披露，
  // 而 02-08 已在冻结期外。此处显式暴露该缺口，不用 0 元或期外记录填补。
  assert.deepEqual(measured.evidence.missing_dates, ['2027-02-06']);
  assert.equal(measured.evidence.covered_days, 89);
  assert.equal(measured.evidence.expected_days, 90);
  assert.equal(measured.evidence.observed_records, inWindow.length);
});

test('收益覆盖在月末/季末仍按自然日归属，不跨出冻结比较期', () => {
  // 2027-01-04 是周一，默认覆盖跨年的 01-02、01-03、01-04。
  assert.deepEqual(effectiveCoveredYieldDates('', '2027-01-04'), [
    '2027-01-02',
    '2027-01-03',
    '2027-01-04',
  ]);
  assert.deepEqual(
    effectiveCoveredYieldDates(
      '覆盖收益日期：2026-12-31 至 2027-01-02',
      '2027-01-02',
    ),
    ['2026-12-31', '2027-01-01', '2027-01-02'],
  );
  // 归属日不在区间内时不猜测覆盖范围。
  assert.deepEqual(
    effectiveCoveredYieldDates(
      '覆盖收益日期：2026-12-30 至 2026-12-31',
      '2027-01-02',
    ),
    [],
  );
  // 非周一且无显式覆盖：不自动吞并前后日期。
  assert.deepEqual(effectiveCoveredYieldDates('', '2027-01-05'), []);
});

test('事实修正后重新度量得到新结果，历史评价不自动追加版本', () => {
  const base = build();
  const decision = decisionFor(base);
  const original = measureFrozenNetPnl({
    decision,
    trades: [buyTrade(base)],
    valuations: valuationRows(base),
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(original.available, true);
  const correctedRows = valuationRows(base, {
    mutate(rows) {
      const row = rows.find((item) => item.yield_date === '2026-11-16');
      assert.ok(row);
      row.daily_pnl = 0.5;
    },
  });
  const corrected = measureFrozenNetPnl({
    decision,
    trades: [buyTrade(base)],
    valuations: correctedRows,
    today: TODAY_AFTER_ARRIVAL,
  });
  assert.equal(corrected.available, true);
  // 修正单日 0.02 → 0.50 元，多 48 分。
  assert.equal(corrected.actual, original.actual + 48);
});

// 事实修正后的版本追加集成路径由 test/automation-store.test.js 的
// “v9 fact corrections append a new maturity evaluation version” 覆盖。
