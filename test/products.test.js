'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  buildProductView,
  isObservationReady,
  isProductPoolEligible,
  loadProductsFromCsv,
  parseCsv,
  referenceYield,
  returnEvidenceTier,
  weightedAnnualizedReturn,
} = require('../lib/products');

const { productCsv } = require('./fixtures');
const csvPath = productCsv;

test('parseCsv handles quoted commas', () => {
  const rows = parseCsv('name,note\nA,"hello, world"\nB,"a ""quote"""');
  assert.equal(rows[1][1], 'hello, world');
  assert.equal(rows[2][1], 'a "quote"');
});

test('weighted annualized return aliases the term-adjusted reference yield', () => {
  assert.equal(
    weightedAnnualizedReturn({
      term_days: 90,
      return_3m: 2,
      return_6m: 3,
      return_1y: 4,
    }),
    2.7,
  );
  assert.equal(
    weightedAnnualizedReturn({
      term_days: 90,
      return_3m: 2,
      return_6m: null,
      return_1y: 4,
    }),
    2.5714,
  );
  assert.equal(
    weightedAnnualizedReturn({
      term_days: 90,
      return_3m: null,
      return_6m: null,
      return_1y: null,
    }),
    null,
  );
});

test('reference yield renormalizes available horizons without treating missing 1Y as zero', () => {
  assert.equal(
    referenceYield({
      term_days: 90,
      return_3m: 2.14,
      return_6m: 2.88,
      return_1y: null,
    }),
    2.4175,
  );
  assert.equal(
    referenceYield({
      term_days: 90,
      return_3m: 3.25,
      return_6m: null,
      return_1y: null,
    }),
    3.25,
  );
  assert.equal(
    referenceYield({
      term_days: 90,
      return_3m: null,
      return_6m: null,
      return_1y: null,
    }),
    null,
  );
});

test('evidence tiers separate full, 6M, 3M, 1M and insufficient data products', () => {
  const base = {
    name: '普通固收产品',
    code: 'TEST',
    risk_level: 'R2',
    currency_code: '10',
    pub_prv: 'A',
    term_days: 90,
    status: '开放中',
    capacity: null,
    return_1m: 2,
    return_3m: 2,
    return_6m: 2,
    return_1y: null,
    history_months: 8,
  };
  assert.equal(returnEvidenceTier({ ...base, return_1y: 2, history_months: 18 }), 'full_1y');
  assert.equal(returnEvidenceTier(base), 'six_month');
  assert.equal(
    returnEvidenceTier({ ...base, return_6m: null, history_months: 4 }),
    'three_month',
  );
  assert.equal(
    returnEvidenceTier({ ...base, return_3m: null, return_6m: null, history_months: 2 }),
    'one_month',
  );
  assert.equal(
    returnEvidenceTier({
      ...base,
      return_1m: null,
      return_3m: null,
      return_6m: null,
      history_months: 2,
    }),
    'no_data',
  );
  assert.equal(
    isObservationReady({
      ...base,
      return_6m: null,
      history_months: 2,
      return_3m: 3,
    }),
    false,
  );
});

test('product pool rejects invalid term-day encodings and keeps 0/100 boundaries', () => {
  const base = {
    id: 1,
    name: '普通固收产品',
    short_name: '',
    code: 'BOUNDARY',
    issuer: '示例理财',
    risk_level: 'R2',
    currency_code: '10',
    pub_prv: 'A',
    status: '开放中',
    capacity: null,
    min_amount: 1000,
    annualized_yield: 3,
    return_1m: 2,
    return_3m: 3,
    return_6m: 4,
    return_1y: 5,
    history_months: 18,
    data_date: '2026-10-22',
    source: 'test',
    fee_bps: 0,
    next_open_date: '',
  };
  const invalidTerms = [
    undefined,
    null,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ];
  for (const term_days of invalidTerms) {
    const product = { ...base, id: String(term_days), code: `BAD-${String(term_days)}`, term_days };
    assert.equal(isProductPoolEligible(product), false, `term_days=${String(term_days)}`);
  }

  const cash = { ...base, id: 2, code: 'CASH0', term_days: 0 };
  const medium = { ...base, id: 3, code: 'MEDIUM100', term_days: 100 };
  const invalidProducts = invalidTerms.map((term_days, index) => ({
    ...base,
    id: 10 + index,
    code: `INVALID${index}`,
    term_days,
  }));
  const view = buildProductView([...invalidProducts, cash, medium], {
    principal: 30000,
    holdings: [],
    pending_trades: [],
  });

  assert.deepEqual(
    view.all.map((product) => product.code),
    ['CASH0', 'MEDIUM100'],
  );
  assert.equal(view.all.find((product) => product.code === 'CASH0').bucket, 'cash');
  assert.equal(
    view.all.find((product) => product.code === 'CASH0').evidence_automatic,
    false,
  );
  assert.equal(view.all.find((product) => product.code === 'MEDIUM100').bucket, 'medium');
  assert.equal(view.stats.total, 2);
  assert.equal(view.stats.bucket_counts.cash, 1);
  assert.equal(view.stats.bucket_counts.medium, 1);
  assert.equal(
    Object.values(view.stats.scored_bucket_counts).reduce(
      (sum, count) => sum + count,
      0,
    ),
    view.stats.observation_ready,
  );
  assert.deepEqual(
    Object.keys(view.selection.reference_weights).sort(),
    ['cash', 'long', 'medium', 'short'],
  );
});

test('product view loads the ordinary universe and allocates dynamically', () => {
  const products = loadProductsFromCsv(csvPath);
  const view = buildProductView(products, { principal: 30000 });
  assert.equal(view.all.length, products.length);
  assert.ok(view.all.length >= 400);
  assert.ok(view.watchlist.length >= 3);
  assert.equal(view.allocation.status, 'quota_unverified');
  assert.equal(view.allocation.principal, 30000);
  assert.ok(view.allocation.allocated_amount > 0);
  assert.ok(view.allocation.allocated_amount <= view.allocation.available_cash + 0.01);
  assert.ok(view.observation_list.length > 0);
  for (const pick of view.watchlist) {
    assert.ok(view.all.some((product) => product.code === pick.code));
    assert.equal(pick.selected, true);
    assert.ok(pick.target_amount > 0);
    assert.ok(pick.target_pct <= 30.001);
    assert.equal(pick.quota_status, 'unverified');
  }
  assert.ok(view.stats.median_1y > 0);
  assert.ok(view.stats.universe_median_1y > 0);
  assert.ok(view.all.every((product) => isProductPoolEligible(product)));
  assert.ok(
    view.all.filter((product) => product.observation_ready).length ===
      view.stats.observation_ready,
  );
  assert.equal(
    Object.values(view.stats.evidence_counts).reduce(
      (sum, count) => sum + count,
      0,
    ),
    view.all.length,
  );
  assert.ok(view.all.every((product) => product.currency_code === '10'));
  assert.ok(view.all.every((product) => product.pub_prv === 'A'));
  assert.ok(
    view.all.every(
      (product) =>
        product.weighted_yield_pct === product.reference_yield_pct,
    ),
  );
  assert.ok(
    view.all.every(
      (product) =>
        ['available', 'unavailable'].includes(product.reference_yield_status) &&
        product.yield_policy_version === view.selection.yield_policy_version &&
        Array.isArray(product.reference_available_horizons) &&
        product.reference_normalized_weights &&
        typeof product.reference_normalized_weights === 'object',
    ),
  );
  assert.ok(
    view.all
      .filter((product) => product.bucket === 'cash')
      .every(
        (product) =>
          product.observation_ready === false &&
          product.observation_score === null &&
          product.selection_score === null,
      ),
  );
  assert.equal(view.selection.version, 'r2-dynamic-v4');
  assert.equal(view.selection.front_load_scheme, 'B');
});
