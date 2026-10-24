'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BUCKET_COMPARISON_DAYS,
  buildHoldingReview,
  calculateSwitch,
  comparisonDaysForBucket,
  dynamicMinGainAmount,
  referenceYield,
  resolveSwitchWaitDays,
} = require('../lib/holdings-review');

let sequence = 0;

function product(overrides = {}) {
  sequence += 1;
  return {
    name: `测试产品${sequence}`,
    code: `H${String(sequence).padStart(4, '0')}`,
    short_name: '',
    issuer: '招银理财',
    risk_level: 'R2',
    currency_code: '10',
    pub_prv: 'A',
    soc_tag: 'C',
    product_type: '代销理财',
    term_days: 90,
    score: null,
    min_amount: 1,
    annualized_yield: 3,
    benchmark: '测试基准',
    return_1m: 3,
    return_3m: 3,
    return_6m: 3,
    return_1y: 3,
    return_since_inception: 3,
    status: '开放中',
    source: 'test',
    data_date: '2026-10-19',
    notes: '',
    capacity: null,
    history_months: 24,
    fee_bps: 10,
    next_open_date: '',
    bucket: 'medium',
    selection_score: 3,
    ...overrides,
  };
}

function holding(overrides = {}) {
  return {
    id: 1,
    lot_id: '1:OLD90',
    product_name: '旧产品90天',
    product_code: 'OLD90',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 100000,
    purchase_date: '2026-09-01',
    term_days: 90,
    maturity_date: '2026-12-01',
    ...overrides,
  };
}

function current(overrides = {}) {
  return product({
    code: 'OLD90',
    name: '旧产品90天',
    term_days: 90,
    return_3m: 2,
    return_6m: 2,
    return_1y: 2,
    ...overrides,
  });
}

function candidateRule(
  code,
  purchaseConfirmDays = 1,
  verifiedAt = '2026-10-20',
) {
  return {
    [code]: {
      purchase_confirm_days: purchaseConfirmDays,
      verified_at: verifiedAt,
    },
  };
}

test('reference yield weights 3M/6M/1Y and ignores missing fields', () => {
  assert.equal(
    referenceYield({ return_3m: 2, return_6m: 3, return_1y: 4 }),
    2.7,
  );
  assert.equal(referenceYield({ return_3m: 2, return_6m: null, return_1y: 4 }), 2.5714);
  assert.equal(referenceYield({}), null);
});

test('bucket comparison horizons are fixed constants', () => {
  assert.deepEqual(BUCKET_COMPARISON_DAYS, {
    short: 30,
    medium: 100,
    long: 360,
  });
  assert.equal(comparisonDaysForBucket('short'), 30);
  assert.equal(comparisonDaysForBucket('medium'), 100);
  assert.equal(comparisonDaysForBucket('long'), 360);
});

test('switch waiting days are derived from redemption, arrival and purchase confirmation', () => {
  assert.deepEqual(resolveSwitchWaitDays({
    redemption_days: 1,
    arrival_days: 0,
    verified_at: '2026-10-20',
  }, {
    purchase_confirm_days: 2,
    verified_at: '2026-10-20',
  }), {
    value: 3,
    status: 'verified',
    source: '已核验：当前产品赎回 T+1 + 到账 T+0 + 候选申购确认 T+2',
  });
  assert.deepEqual(resolveSwitchWaitDays({}, {}), {
    value: 2,
    status: 'estimated',
    source:
      '估算：当前产品赎回 T+1（默认） + 到账 T+0（默认） + 候选申购确认 T+1（默认）',
  });
  assert.deepEqual(
    resolveSwitchWaitDays(
      { redemption_days: 2, arrival_days: 0, verified_at: '2026-10-20' },
      {},
    ),
    {
      value: 3,
      status: 'estimated',
      source:
        '估算：当前产品赎回 T+2 + 到账 T+0 + 候选申购确认 T+1（默认）',
    },
  );
});

test('switch calculation compounds returns and solves the break-even annual yield', () => {
  const result = calculateSwitch({
    amount: 100000,
    currentYieldPct: 3,
    horizonDays: 90,
    redemptionFeeBps: 0,
    switchWaitDays: 3,
    newYieldPct: 3.5,
    purchaseFeeBps: 0,
  });
  assert.equal(result.new_days, 87);
  assert.equal(result.current_gross, 731.51);
  assert.equal(result.difference, 91.84);
  assert.ok(Math.abs(result.break_even_yield_pct - 3.105) < 0.001);
  assert.equal('idle_cost' in result, false);

  const breakEven = calculateSwitch({
    amount: 100000,
    currentYieldPct: 3,
    horizonDays: 90,
    switchWaitDays: 3,
    newYieldPct: result.break_even_yield_pct,
  });
  assert.ok(Math.abs(breakEven.difference) < 0.02);
});

test('minimum gain threshold scales with holding principal instead of using a fixed 10 yuan', () => {
  assert.equal(dynamicMinGainAmount(3000), 3);
  assert.equal(dynamicMinGainAmount(7500), 7.5);
  assert.equal(dynamicMinGainAmount(100000), 100);
  assert.equal(dynamicMinGainAmount(6000, 13), 1);
  assert.equal(dynamicMinGainAmount(6000, 30), 2);
  assert.equal(dynamicMinGainAmount(6000, 90), 6);
  assert.equal(dynamicMinGainAmount(6000, 180), 12);
  assert.equal(dynamicMinGainAmount(0), 1);

  const review = buildHoldingReview({
    holding: holding({ amount: 7500 }),
    products: [],
    universe: [current()],
    today: '2026-10-20',
  });
  assert.equal(
    review.thresholds.min_gain_amount,
    dynamicMinGainAmount(7500, review.horizon_days),
  );
  assert.equal(review.thresholds.min_gain_rule_pct, 0.1);
  assert.equal(review.thresholds.min_gain_base_days, 90);
  assert.equal(review.thresholds.min_gain_floor, 1);
  assert.equal(review.summary.includes('门槛 ¥10.00'), false);
});

test('same-term candidate above the net gain threshold is a replace candidate', () => {
  const candidate = product({
    code: 'NEW90',
    name: '新产品90天',
    term_days: 90,
    return_3m: 3.5,
    return_6m: 3.5,
    return_1y: 3.5,
  });
  const review = buildHoldingReview({
    holding: holding(),
    products: [candidate],
    universe: [current()],
    setting: {
      redemption_days: 1,
      arrival_days: 1,
      verified_at: '2026-10-20',
      redemption_fee_bps: 0,
      purchase_fee_bps: 0,
      next_redeem_open_date: '2026-10-20',
    },
    settingsByCode: candidateRule('NEW90'),
    quotaByCode: { NEW90: { available: 50000, max_order: 50000, verified_at: '2026-10-20' } },
    today: '2026-10-20',
    snapshotDate: '2026-10-19',
  });
  assert.equal(review.verdict, 'replace');
  assert.equal(review.candidates[0].verdict, 'replace');
  assert.equal(review.candidates[0].execution_ready, true);
  assert.equal(
    review.candidates[0].min_gain_amount,
    dynamicMinGainAmount(100000, review.candidates[0].comparison_days),
  );
  assert.ok(review.candidates[0].switch.difference > review.thresholds.min_gain_amount);
  assert.equal(review.horizon_days, 100);
  assert.equal(review.candidates[0].comparison_days, 100);
});

test('3M replacement candidates cannot bypass the 10% single-product cap', () => {
  const candidate = product({
    code: 'NEW3M',
    name: '三月期候选',
    term_days: 90,
    return_3m: 5,
    return_6m: null,
    return_1y: null,
    history_months: 4,
  });
  const review = buildHoldingReview({
    holding: holding({ amount: 100000 }),
    products: [candidate],
    universe: [current()],
    principal: 100000,
    setting: {
      redemption_days: 1,
      arrival_days: 1,
      verified_at: '2026-10-20',
      redemption_fee_bps: 0,
      purchase_fee_bps: 0,
      next_redeem_open_date: '2026-10-20',
    },
    settingsByCode: candidateRule('NEW3M'),
    quotaByCode: { NEW3M: { available: 50000, max_order: 50000 } },
    today: '2026-10-20',
    snapshotDate: '2026-10-19',
  });
  const row = review.candidates.find((item) => item.code === 'NEW3M');
  assert.ok(row);
  assert.equal(row.evidence_tier, 'three_month');
  assert.equal(row.evidence_single_cap_pct, 10);
  assert.equal(row.evidence_single_cap_amount, 10000);
  assert.equal(row.verdict, 'watch');
  assert.ok(row.reasons.some((item) => item.includes('单只 10%')));
  assert.notEqual(review.verdict, 'replace');
});

test('yield edge below 0.15pp is not worth switching even if fees are zero', () => {
  const candidate = product({
    code: 'TINY90',
    term_days: 90,
    return_3m: 2.05,
    return_6m: 2.05,
    return_1y: 2.05,
  });
  const review = buildHoldingReview({
    holding: holding(),
    products: [candidate],
    universe: [current()],
    setting: {
      redemption_days: 1,
      arrival_days: 1,
      verified_at: '2026-10-20',
    },
    settingsByCode: candidateRule('TINY90'),
    today: '2026-10-20',
    snapshotDate: '2026-10-19',
  });
  assert.equal(review.candidates[0].verdict, 'hold');
  assert.equal(review.verdict, 'hold');
});

test('a shorter minimum-holding candidate uses the bucket horizon without a term penalty', () => {
  const shortCandidate = product({
    code: 'WEEK7',
    term_days: 7,
    bucket: 'short',
    return_3m: 6,
    return_6m: 4,
    return_1y: 2.7,
  });
  const review = buildHoldingReview({
    holding: holding({ term_days: 14, maturity_date: '2026-11-03' }),
    products: [shortCandidate],
    universe: [
      current({
        term_days: 14,
        bucket: 'short',
        return_3m: 1.28,
        return_6m: 1.82,
        return_1y: 2.75,
      }),
    ],
    setting: { redemption_days: 1, arrival_days: 1, verified_at: '2026-10-20' },
    settingsByCode: candidateRule('WEEK7', 2),
    today: '2026-10-20',
  });
  assert.equal(review.horizon_days, 30);
  assert.equal(review.candidates[0].comparison_days, 30);
  assert.equal(review.candidates[0].purchase_confirm_days, 2);
  assert.equal(review.candidates[0].switch_wait_days, 4);
  assert.equal(review.candidates[0].effective_days, 26);
  assert.equal('term_warning' in review.candidates[0], false);
  assert.equal(review.candidates[0].verdict, 'replace');
  assert.doesNotMatch(review.candidates[0].reasons.join('；'), /短于比较期/);
});

test('a positive but sub-threshold net gain stays in watch', () => {
  const candidate = product({
    code: 'SMALL90',
    term_days: 90,
    return_3m: 2.2,
    return_6m: 2.2,
    return_1y: 2.2,
  });
  const review = buildHoldingReview({
    holding: holding(),
    products: [candidate],
    universe: [current()],
    setting: {
      redemption_days: 1,
      arrival_days: 1,
      verified_at: '2026-10-20',
    },
    settingsByCode: candidateRule('SMALL90'),
    today: '2026-10-20',
    snapshotDate: '2026-10-19',
  });
  assert.equal(review.candidates[0].verdict, 'watch');
  assert.match(review.candidates[0].reasons[0], /低于门槛/);
});

test('candidates outside the same risk/term bucket are excluded', () => {
  const wrongRisk = product({ code: 'R3', risk_level: 'R3', term_days: 90 });
  const wrongTerm = product({ code: 'LONG', term_days: 365, bucket: 'long' });
  const review = buildHoldingReview({
    holding: holding(),
    products: [wrongRisk, wrongTerm],
    universe: [current()],
    today: '2026-10-20',
  });
  assert.equal(review.candidates.length, 0);
  assert.equal(review.verdict, 'hold');
});

test('daily-open holding uses the fixed short-bucket horizon and open-day reminder', () => {
  const review = buildHoldingReview({
    holding: holding({
      product_code: 'DAILY',
      product_name: '日开产品',
      term_days: 0,
      maturity_date: null,
    }),
    products: [],
    universe: [
      product({
        code: 'DAILY',
        name: '日开产品',
        term_days: 0,
        bucket: 'cash',
        next_open_date: '2026-10-22',
        return_3m: 1.5,
        return_6m: 1.5,
        return_1y: 1.5,
      }),
    ],
    setting: { next_redeem_open_date: '2026-10-22' },
    today: '2026-10-20',
  });
  assert.equal(review.horizon_days, 30);
  assert.equal(review.reminder.level, 'window');
  assert.match(review.reminder.text, /赎回开放日/);
});

test('daily-open holding compares with the short bucket instead of other daily-open products', () => {
  const cashPeer = product({
    code: 'DAILY-PEER',
    name: '另一个日开产品',
    term_days: 0,
    bucket: 'cash',
    return_3m: 9,
    return_6m: 9,
    return_1y: 9,
  });
  const short7 = product({
    code: 'SHORT7',
    name: '短期限7天产品',
    term_days: 7,
    bucket: 'short',
    return_3m: 3,
    return_6m: 3,
    return_1y: 3,
  });
  const short30 = product({
    code: 'SHORT30',
    name: '短期限30天产品',
    term_days: 30,
    bucket: 'short',
    return_3m: 2.8,
    return_6m: 2.8,
    return_1y: 2.8,
  });
  const review = buildHoldingReview({
    holding: holding({
      product_code: 'DAILY',
      product_name: '日开产品',
      term_days: 0,
      maturity_date: null,
    }),
    products: [cashPeer, short7, short30],
    universe: [
      product({
        code: 'DAILY',
        name: '日开产品',
        term_days: 0,
        bucket: 'cash',
        return_3m: 1.5,
        return_6m: 1.5,
        return_1y: 1.5,
      }),
    ],
    setting: {},
    today: '2026-10-20',
  });
  assert.equal(review.horizon_days, 30);
  assert.deepEqual(
    review.candidates.map((item) => item.code).sort(),
    ['SHORT30', 'SHORT7'],
  );
  assert.ok(review.candidates.every((item) => item.bucket === 'short'));
  assert.ok(
    review.candidates.every((item) =>
      item.reasons.includes('日开持仓按短期限（7–30 天）候选比较'),
    ),
  );
  assert.ok(
    review.candidates.every((item) => item.term_days > 0 && item.term_days <= 30),
  );
  assert.ok(review.candidates.every((item) => item.comparison_days === 30));
});

test('long-bucket products use the fixed 360-day horizon instead of their own terms', () => {
  const longCandidate = product({
    code: 'LONG791',
    name: '长期791天产品',
    term_days: 791,
    bucket: 'long',
    return_3m: 3,
    return_6m: 3,
    return_1y: 3,
  });
  const review = buildHoldingReview({
    holding: holding({
      product_code: 'OLD180',
      product_name: '旧产品180天',
      term_days: 180,
      maturity_date: '2027-04-19',
    }),
    products: [longCandidate],
    universe: [
      current({
        code: 'OLD180',
        name: '旧产品180天',
        term_days: 180,
        bucket: 'long',
        return_3m: 2,
        return_6m: 2,
        return_1y: 2,
      }),
    ],
    today: '2026-10-20',
  });
  assert.equal(review.horizon_days, 360);
  assert.equal(review.candidates[0].comparison_days, 360);
});

test('maturity inside 14 days creates a replacement window reminder', () => {
  const review = buildHoldingReview({
    holding: holding({ maturity_date: '2026-11-02' }),
    products: [],
    universe: [current()],
    today: '2026-10-20',
  });
  assert.equal(review.reminder.level, 'window');
  assert.match(review.reminder.text, /替换\/续作比较窗口/);
});

test('an unverified redemption rule uses a labelled estimate and still computes candidate economics', () => {
  const candidate = product({
    code: 'NEW90',
    term_days: 90,
    return_3m: 4,
    return_6m: 4,
    return_1y: 4,
  });
  const review = buildHoldingReview({
    holding: holding(),
    products: [candidate],
    universe: [current()],
    setting: { next_redeem_open_date: '2026-10-20' },
    settingsByCode: candidateRule('NEW90'),
    today: '2026-10-20',
  });
  assert.equal(review.verdict, 'replace');
  assert.ok(review.candidates[0].switch);
  assert.equal(review.candidates[0].switch_wait_days, 2);
  assert.equal(review.candidates[0].switch_wait_status, 'estimated');
  assert.match(review.candidates[0].switch_wait_source, /^估算/);
  assert.equal(review.candidates[0].effective_days, 98);
  assert.equal(review.candidates[0].execution_ready, false);
  assert.ok(
    review.data_gaps.some((gap) => /T\+N 未核验.*估算/.test(gap)),
  );
  assert.ok(
    review.candidates[0].data_gaps.some((gap) =>
      /切换等待按 2 天估算/.test(gap),
    ),
  );
});

test('zero remaining quota blocks candidate execution readiness', () => {
  const candidate = product({
    code: 'SOLD901',
    term_days: 90,
    return_3m: 4,
    return_6m: 4,
    return_1y: 4,
  });
  const review = buildHoldingReview({
    holding: holding(),
    products: [candidate],
    universe: [current()],
    setting: {
      redemption_days: 1,
      arrival_days: 1,
      verified_at: '2026-10-20',
      next_redeem_open_date: '2026-10-20',
    },
    settingsByCode: candidateRule('SOLD901'),
    quotaByCode: {
      SOLD901: { available: 0, max_order: 0, verified_at: '2026-10-20' },
    },
    today: '2026-10-20',
  });
  assert.equal(review.candidates[0].execution_ready, false);
  assert.ok(
    review.candidates[0].data_gaps.some((gap) => /额度售罄或为 0/.test(gap)),
  );
});

test('latest replacement decision is matched back to the holding', () => {
  const review = buildHoldingReview({
    holding: holding(),
    products: [],
    universe: [current()],
    today: '2026-10-20',
    decisions: [
      {
        id: 9,
        date: '2026-10-20',
        action: '切换',
        product_name: '旧产品 → 新产品',
        review_meta: { holding_code: 'OLD90', candidate_code: 'NEW90' },
      },
    ],
  });
  assert.equal(review.decision.id, 9);
});

test('a locked fixed-term lot cannot be labelled replace-now', () => {
  const candidate = product({
    code: 'NEW90',
    name: '新产品90天',
    term_days: 90,
    return_3m: 4,
    return_6m: 4,
    return_1y: 4,
  });
  const review = buildHoldingReview({
    holding: holding({ maturity_date: '2027-01-18' }),
    products: [candidate],
    universe: [current()],
    setting: { redemption_days: 1, arrival_days: 1, verified_at: '2026-10-20' },
    settingsByCode: candidateRule('NEW90'),
    quotaByCode: { NEW90: { available: 50000, verified_at: '2026-10-20' } },
    today: '2026-10-20',
  });
  assert.equal(review.redemption.redeemable_now, false);
  assert.equal(review.redemption.state, 'locked');
  assert.equal(review.verdict, 'hold');
  assert.equal(review.verdict_label, '继续持有（锁定期）');
  assert.equal(review.candidates[0].verdict, 'replace');
  assert.equal(review.candidates[0].verdict_label, '到期后可替换');
  assert.equal(review.planned_action?.candidate_code, 'NEW90');
  assert.match(review.summary, /现在不能执行替换/);
});
