'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildHoldingReview,
  calculateSwitch,
  referenceYield,
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

test('reference yield weights 3M/6M/1Y and ignores missing fields', () => {
  assert.equal(
    referenceYield({ return_3m: 2, return_6m: 3, return_1y: 4 }),
    2.7,
  );
  assert.equal(referenceYield({ return_3m: 2, return_6m: null, return_1y: 4 }), 2.5714);
  assert.equal(referenceYield({}), null);
});

test('switch calculation matches the documented break-even example', () => {
  const result = calculateSwitch({
    amount: 100000,
    currentYieldPct: 3,
    horizonDays: 90,
    redemptionFeeBps: 0,
    idleDays: 3,
    newYieldPct: 3.5,
    purchaseFeeBps: 0,
  });
  assert.equal(result.new_days, 87);
  assert.equal(result.current_gross, 739.73);
  assert.equal(result.difference, 94.52);
  assert.ok(Math.abs(result.break_even_yield_pct - 3.1034) < 0.01);
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
    quotaByCode: { NEW90: { available: 50000, max_order: 50000, verified_at: '2026-10-20' } },
    today: '2026-10-20',
    snapshotDate: '2026-10-19',
  });
  assert.equal(review.verdict, 'replace');
  assert.equal(review.candidates[0].verdict, 'replace');
  assert.equal(review.candidates[0].execution_ready, true);
  assert.ok(review.candidates[0].switch.difference > review.thresholds.min_gain_amount);
  assert.equal(review.horizon_days, 42);
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
    today: '2026-10-20',
    snapshotDate: '2026-10-19',
  });
  assert.equal(review.candidates[0].verdict, 'hold');
  assert.equal(review.verdict, 'hold');
});

test('a much shorter candidate cannot be compared as if its yield lasted the full horizon', () => {
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
    today: '2026-10-20',
  });
  assert.equal(review.candidates[0].comparison_days, 7);
  assert.equal(review.candidates[0].verdict, 'watch');
  assert.match(review.candidates[0].reasons.join('；'), /短于比较期/);
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

test('daily-open holding uses the configured comparison horizon and open-day reminder', () => {
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
    setting: { compare_horizon_days: 45, next_redeem_open_date: '2026-10-22' },
    today: '2026-10-20',
  });
  assert.equal(review.horizon_days, 45);
  assert.equal(review.reminder.level, 'window');
  assert.match(review.reminder.text, /赎回开放日/);
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

test('an unverified redemption rule is surfaced as a data gap and blocks execution readiness', () => {
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
    today: '2026-10-20',
  });
  assert.equal(review.verdict, 'replace');
  assert.equal(review.candidates[0].execution_ready, false);
  assert.ok(review.data_gaps.some((gap) => /T\+N 未核验/.test(gap)));
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
