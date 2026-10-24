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

test('weighted annualized return requires all three horizons without renormalizing', () => {
  assert.equal(
    weightedAnnualizedReturn({
      return_3m: 2,
      return_6m: 3,
      return_1y: 4,
    }),
    2.7,
  );
  assert.equal(
    weightedAnnualizedReturn({
      return_3m: 2,
      return_6m: null,
      return_1y: 4,
    }),
    null,
  );
  assert.equal(
    weightedAnnualizedReturn({
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
      return_3m: 2.14,
      return_6m: 2.88,
      return_1y: null,
    }),
    2.4175,
  );
  assert.equal(
    referenceYield({
      return_3m: 3.25,
      return_6m: null,
      return_1y: null,
    }),
    3.25,
  );
  assert.equal(
    referenceYield({
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
    view.all
      .filter((product) => product.weighted_yield_pct !== null)
      .every(
      (product) =>
        product.weighted_yield_pct ===
        Number(
          (
            product.return_3m * 0.5 +
            product.return_6m * 0.3 +
            product.return_1y * 0.2
          ).toFixed(4),
        ),
      ),
  );
});
