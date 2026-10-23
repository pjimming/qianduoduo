'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProductView, normalizeAllocationSettings } = require('../lib/products');

let sequence = 0;

function product(overrides = {}) {
  sequence += 1;
  return {
    name: `测试产品${sequence}`,
    code: `T${String(sequence).padStart(4, '0')}`,
    short_name: '',
    issuer: '测试理财A',
    risk_level: 'R2',
    currency_code: '10',
    pub_prv: 'A',
    soc_tag: 'C',
    product_type: '代销理财',
    term_days: 14,
    score: null,
    min_amount: 1,
    annualized_yield: 3,
    benchmark: '测试基准',
    return_1m: 2,
    return_3m: 2.5,
    return_6m: 2.7,
    return_1y: 2.9,
    return_since_inception: 2.8,
    status: '开放中',
    source: 'test',
    data_date: '2026-10-19',
    notes: '',
    capacity: null,
    history_months: 24,
    fee_bps: 10,
    next_open_date: '2026-10-20',
    ...overrides,
  };
}

function peers(bucket, count, issuerPrefix = 'A') {
  const term = bucket === 'short' ? 14 : bucket === 'medium' ? 90 : 180;
  return Array.from({ length: count }, (_, index) =>
    product({
      term_days: term,
      issuer: `${issuerPrefix}${index % 3}`,
      benchmark: `基准${bucket}${index % 3}`,
      return_3m: 2.5 - index * 0.05,
      return_6m: 2.7 - index * 0.05,
      return_1y: 2.9 - index * 0.05,
    }),
  );
}

function basePool() {
  return [
    ...peers('short', 5),
    ...peers('medium', 5),
    ...peers('long', 5),
  ];
}

test('dynamic allocation scales product count with capital and respects single-product cap', () => {
  const small = buildProductView(basePool(), { principal: 60000 });
  const large = buildProductView(basePool(), { principal: 3000000 });
  assert.ok(large.watchlist.length > small.watchlist.length);
  assert.ok(small.watchlist.every((item) => item.target_pct <= 30.001));
  assert.ok(large.watchlist.every((item) => item.target_pct <= 30.001));
  assert.ok(
    Math.abs(
      large.watchlist.reduce((sum, item) => sum + item.target_amount, 0) -
        large.allocation.allocated_amount,
    ) < 0.01,
  );
});

test('small capital near the minimum purchase leaves money unallocated instead of forcing a buy', () => {
  const pool = basePool().map((item) => ({ ...item, min_amount: 600 }));
  const tooSmall = buildProductView(pool, { principal: 1000 });
  assert.equal(tooSmall.watchlist.length, 0);
  assert.equal(tooSmall.allocation.status, 'no_allocation');
  assert.equal(tooSmall.allocation.unallocated_amount, 1000);
  assert.ok(tooSmall.observation_list.length > 0);

  const enough = buildProductView(pool, { principal: 2000 });
  assert.ok(enough.watchlist.length >= 3);
  assert.ok(enough.watchlist.every((item) => item.target_amount >= 600));
});

test('zero and insufficient quotas are skipped or truncated and explained', () => {
  const pool = peers('short', 3).map((item, index) => ({
    ...item,
    code: `Q${index + 1}`,
    return_3m: 3 - index * 0.1,
    return_6m: 3 - index * 0.1,
    return_1y: 3 - index * 0.1,
  }));
  const view = buildProductView(pool, {
    principal: 100000,
    settings: {
      quota_by_code: {
        Q1: { available: 0 },
        Q2: { available: 5000 },
      },
    },
  });
  const q2 = view.watchlist.find((item) => item.code === 'Q2');
  const q3 = view.watchlist.find((item) => item.code === 'Q3');
  assert.equal(view.watchlist.some((item) => item.code === 'Q1'), false);
  assert.equal(q2.target_amount, 5000);
  assert.equal(q2.quota_status, 'limited');
  assert.ok(q3);
  assert.equal(q3.quota_status, 'unverified');
  assert.ok(view.allocation.reasons.some((item) => item.includes('额度未核验')));
});

test('pending buys reduce available cash and count toward concentration without becoming holdings', () => {
  const view = buildProductView(basePool(), {
    principal: 30000,
    pending_trades: [
      {
        status: 'pending',
        trade_type: 'buy',
        product_code: '120026A',
        product_name: '待确认产品',
        issuer: '测试理财A0',
        amount: 30000,
        term_days: 14,
      },
    ],
  });
  assert.equal(view.allocation.available_cash, 0);
  assert.equal(view.allocation.pending.amount, 30000);
  assert.equal(view.allocation.holdings.amount, 0);
  assert.equal(view.watchlist.length, 0);
  assert.equal(view.allocation.status, 'no_cash');
});

test('existing holdings remove the matching bucket deficit', () => {
  const view = buildProductView(basePool(), {
    principal: 30000,
    holdings: [
      {
        product_code: 'HELD-SHORT',
        product_name: '已有短期',
        issuer: '测试理财A0',
        amount: 9000,
        term_days: 14,
      },
    ],
  });
  const short = view.allocation.buckets.find((item) => item.key === 'short');
  assert.equal(short.existing_amount, 9000);
  assert.equal(short.new_amount, 0);
  assert.equal(view.watchlist.some((item) => item.bucket === 'short'), false);
  assert.ok(view.watchlist.some((item) => item.bucket === 'medium'));
  assert.ok(view.watchlist.some((item) => item.bucket === 'long'));
});

test('issuer exposure is display-only and never caps allocation', () => {
  const pool = Array.from({ length: 10 }, (_, index) =>
    product({
      code: `SAME-ISSUER-${index + 1}`,
      issuer: '同一发行方',
      benchmark: `唯一底层${index + 1}`,
      term_days: 14,
    }),
  );
  const view = buildProductView(pool, {
    principal: 100000,
    settings: { bucket_targets: { short: 100, medium: 0, long: 0 } },
  });
  assert.equal(view.allocation.allocated_amount, 100000);
  assert.equal(
    view.watchlist.reduce((sum, item) => sum + item.target_amount, 0),
    100000,
  );
  assert.equal(
    view.watchlist.reduce(
      (sum, item) => sum + (item.issuer === '同一发行方' ? item.target_amount : 0),
      0,
    ),
    100000,
  );
  assert.equal(view.allocation.allocation_policy.issuer_display_only, true);
});

test('liquidity floor and near-term cash flow force enough short allocation', () => {
  const floorView = buildProductView(basePool(), {
    principal: 100000,
    settings: { bucket_targets: { short: 10, medium: 45, long: 45 }, liquidity_floor_pct: 30 },
  });
  const short = floorView.allocation.buckets.find((item) => item.key === 'short');
  assert.ok(short.new_amount >= 30000);
  assert.equal(floorView.allocation.liquidity.status, 'covered');

  const cashflowView = buildProductView(basePool(), {
    principal: 100000,
    settings: {
      bucket_targets: { short: 10, medium: 45, long: 45 },
      liquidity_floor_pct: 10,
      cashflow_0_3: 40000,
    },
  });
  const cashflowShort = cashflowView.allocation.buckets.find((item) => item.key === 'short');
  assert.ok(cashflowShort.new_amount >= 40000);
  assert.equal(cashflowView.allocation.cashflow[0].status, 'covered');
});

test('missing quota data is marked unverified instead of pretending the product is buyable', () => {
  const view = buildProductView(basePool(), { principal: 100000 });
  assert.equal(view.allocation.status, 'quota_unverified');
  assert.ok(view.watchlist.every((item) => item.quota_status === 'unverified'));
  assert.ok(view.allocation.quota_unverified_count > 0);
});

test('allocation settings normalize unsafe inputs and default to 30/35/35', () => {
  const settings = normalizeAllocationSettings({
    max_single_pct: 80,
    max_issuer_pct: 10,
    bucket_targets: { short: 20, medium: 40, long: 40 },
  });
  assert.equal(settings.max_single_pct, 30);
  assert.equal(Object.hasOwn(settings, 'max_issuer_pct'), false);
  assert.equal(settings.daily_open_target_pct, 0);
  assert.deepEqual(settings.bucket_targets, { short: 20, medium: 40, long: 40 });
});

test('daily-open products never receive a target even under maximum liquidity and cash-flow pressure', () => {
  const cashProducts = Array.from({ length: 4 }, (_, index) =>
    product({
      term_days: 0,
      code: `CASH${index + 1}`,
      return_3m: 8 - index * 0.1,
      return_6m: 8 - index * 0.1,
      return_1y: 8 - index * 0.1,
    }),
  );
  const view = buildProductView([...cashProducts, ...basePool()], {
    principal: 100000,
    settings: {
      liquidity_floor_pct: 100,
      cashflow_0_3: 100000,
      bucket_targets: { short: 30, medium: 35, long: 35 },
    },
  });
  assert.equal(view.watchlist.some((item) => item.bucket === 'cash'), false);
  assert.ok(view.watchlist.length > 0);
  assert.ok(
    view.watchlist.every((item) => item.bucket === 'short' && item.target_amount > 0),
  );
  assert.equal(view.allocation.daily_open.target_pct, 0);
  assert.equal(view.allocation.daily_open.target_amount, 0);
});

test('existing daily-open holdings remain visible as migration facts without becoming a new target', () => {
  const view = buildProductView(basePool(), {
    principal: 30000,
    holdings: [
      {
        product_code: '107320A',
        product_name: '招银理财招睿添利日开1号A',
        issuer: '招银理财',
        amount: 3000,
        term_days: 0,
      },
    ],
  });
  assert.equal(view.allocation.daily_open.existing_amount, 3000);
  assert.equal(view.allocation.daily_open.target_amount, 0);
  assert.equal(view.allocation.daily_open.migration_required, true);
  assert.equal(view.watchlist.some((item) => item.bucket === 'cash'), false);
  assert.ok(view.allocation.buckets.find((item) => item.key === 'short').new_amount > 0);
  assert.equal(view.allocation.liquidity.existing_amount, 0);
  assert.ok(view.allocation.reasons.some((item) => item.includes('现有日开')));
});

test('a nearly filled bucket keeps small residual cash instead of opening a tiny new position', () => {
  const pool = [
    product({ code: 'SHORT-NEW-1', term_days: 14, return_1y: 3.1 }),
    product({ code: 'SHORT-NEW-2', term_days: 21, return_1y: 3.0 }),
  ];
  const view = buildProductView(pool, {
    principal: 100000,
    holdings: [
      {
        product_code: 'SHORT-OLD-OUTSIDE-POOL',
        product_name: '已确认短期持仓',
        issuer: '其他发行方',
        amount: 29000,
        term_days: 14,
      },
      {
        product_code: 'MEDIUM-HELD',
        product_name: '已确认中期持仓',
        issuer: '其他发行方',
        amount: 35000,
        term_days: 90,
      },
      {
        product_code: 'LONG-HELD',
        product_name: '已确认长期持仓',
        issuer: '其他发行方',
        amount: 35000,
        term_days: 180,
      },
    ],
  });
  const short = view.allocation.buckets.find((item) => item.key === 'short');
  assert.equal(view.allocation.available_cash, 1000);
  assert.equal(view.watchlist.length, 0);
  assert.equal(short.budget_amount, 1000);
  assert.equal(short.unallocated_amount, 1000);
  assert.equal(short.new_position_amount, 0);
  assert.ok(
    short.reasons.some((item) => item.includes('有意义最低仓位')),
  );
  assert.ok(
    view.allocation.reasons.some((item) => item.includes('不会为分完残余资金新开小仓')),
  );
});

test('same-bucket confirmed holdings receive residual cash before any new product', () => {
  const pool = peers('short', 3).map((item, index) => ({
    ...item,
    code: `TOPUP-${index + 1}`,
    min_amount: 100,
  }));
  const view = buildProductView(pool, {
    principal: 100000,
    holdings: [
      {
        product_code: 'TOPUP-1',
        product_name: '已确认持仓产品1',
        issuer: pool[0].issuer,
        amount: 29000,
        term_days: 14,
      },
      {
        product_code: 'MEDIUM-HELD',
        product_name: '已确认中期持仓',
        issuer: '其他发行方',
        amount: 35000,
        term_days: 90,
      },
      {
        product_code: 'LONG-HELD',
        product_name: '已确认长期持仓',
        issuer: '其他发行方',
        amount: 35000,
        term_days: 180,
      },
    ],
  });
  const productRow = view.watchlist.find((item) => item.code === 'TOPUP-1');
  const short = view.allocation.buckets.find((item) => item.key === 'short');
  assert.ok(productRow);
  assert.equal(productRow.allocation_mode, 'top_up');
  assert.equal(productRow.target_amount, 1000);
  assert.equal(productRow.meaningful_min_amount, 100);
  assert.equal(short.top_up_amount, 1000);
  assert.equal(short.new_position_amount, 0);
  assert.equal(view.allocation.top_up_amount, 1000);
  assert.equal(view.allocation.new_position_amount, 0);
  assert.equal(
    view.watchlist.filter((item) => item.allocation_mode === 'new').length,
    0,
  );
});

test('new positions are opened only when the allocation reaches the meaningful minimum', () => {
  const pool = peers('short', 3).map((item, index) => ({
    ...item,
    code: `MIN-NEW-${index + 1}`,
    min_amount: 100,
  }));
  const view = buildProductView(pool, {
    principal: 100000,
    holdings: [
      {
        product_code: 'SHORT-HELD',
        product_name: '已确认短期持仓',
        issuer: '其他发行方',
        amount: 25000,
        term_days: 14,
      },
      {
        product_code: 'MEDIUM-HELD',
        product_name: '已确认中期持仓',
        issuer: '其他发行方',
        amount: 34000,
        term_days: 90,
      },
      {
        product_code: 'LONG-HELD',
        product_name: '已确认长期持仓',
        issuer: '其他发行方',
        amount: 35000,
        term_days: 180,
      },
    ],
  });
  const newPosition = view.watchlist.find((item) =>
    item.code.startsWith('MIN-NEW-'),
  );
  assert.ok(newPosition);
  assert.equal(newPosition.allocation_mode, 'new');
  assert.equal(newPosition.meaningful_min_amount, 5000);
  assert.ok(newPosition.target_amount >= newPosition.meaningful_min_amount);
  assert.equal(view.allocation.top_up_amount, 0);
  assert.ok(view.allocation.new_position_amount >= 5000);
});

test('exhausted quota or reached cap blocks top-up and leaves residual cash unallocated', () => {
  const pool = peers('short', 3).map((item, index) => ({
    ...item,
    code: `BLOCKED-${index + 1}`,
    min_amount: 100,
  }));
  const quotaView = buildProductView(pool, {
    principal: 100000,
    settings: {
      quota_by_code: {
        'BLOCKED-1': { available: 0 },
      },
    },
    holdings: [
      {
        product_code: 'BLOCKED-1',
        product_name: '额度耗尽持仓',
        issuer: pool[0].issuer,
        amount: 29000,
        term_days: 14,
      },
      {
        product_code: 'MEDIUM-HELD',
        product_name: '已确认中期持仓',
        issuer: '其他发行方',
        amount: 35000,
        term_days: 90,
      },
      {
        product_code: 'LONG-HELD',
        product_name: '已确认长期持仓',
        issuer: '其他发行方',
        amount: 35000,
        term_days: 180,
      },
    ],
  });
  const quotaShort = quotaView.allocation.buckets.find(
    (item) => item.key === 'short',
  );
  assert.equal(
    quotaView.watchlist.some((item) => item.code === 'BLOCKED-1'),
    false,
  );
  assert.equal(quotaShort.unallocated_amount, 1000);
  assert.ok(quotaShort.reasons.some((item) => item.includes('额度不足')));

  const capView = buildProductView(pool, {
    principal: 100000,
    settings: {
      max_single_pct: 25,
      bucket_targets: { short: 35, medium: 32.5, long: 32.5 },
    },
    holdings: [
      {
        product_code: 'BLOCKED-1',
        product_name: '单只上限持仓',
        issuer: pool[0].issuer,
        amount: 25000,
        term_days: 14,
      },
      {
        product_code: 'SHORT-OTHER',
        product_name: '其他短期持仓',
        issuer: '其他发行方',
        amount: 6500,
        term_days: 14,
      },
      {
        product_code: 'MEDIUM-HELD',
        product_name: '已确认中期持仓',
        issuer: '其他发行方',
        amount: 32500,
        term_days: 90,
      },
      {
        product_code: 'LONG-HELD',
        product_name: '已确认长期持仓',
        issuer: '其他发行方',
        amount: 32500,
        term_days: 180,
      },
    ],
  });
  const capShort = capView.allocation.buckets.find(
    (item) => item.key === 'short',
  );
  assert.equal(
    capView.watchlist.some((item) => item.code === 'BLOCKED-1'),
    false,
  );
  assert.equal(capShort.unallocated_amount, 3500);
  assert.ok(capShort.reasons.some((item) => item.includes('上限')));
  assert.ok(capShort.reasons.some((item) => item.includes('有意义最低仓位')));
});
