'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  buildProductView,
  loadProductsFromCsv,
  parseCsv,
} = require('../lib/products');

const { productCsv } = require('./fixtures');
const csvPath = productCsv;

test('parseCsv handles quoted commas', () => {
  const rows = parseCsv('name,note\nA,"hello, world"\nB,"a ""quote"""');
  assert.equal(rows[1][1], 'hello, world');
  assert.equal(rows[2][1], 'a "quote"');
});

test('product view loads the ordinary universe and picks three per term bucket', () => {
  const products = loadProductsFromCsv(csvPath);
  const view = buildProductView(products);
  assert.equal(view.all.length, products.length);
  assert.ok(view.all.length >= 400);
  assert.equal(view.watchlist.length, 9);
  assert.deepEqual(view.watchlist.map((product) => product.bucket), [
    'short',
    'short',
    'short',
    'medium',
    'medium',
    'medium',
    'long',
    'long',
    'long',
  ]);
  for (const bucket of ['short', 'medium', 'long']) {
    assert.equal(
      view.watchlist.filter((product) => product.bucket === bucket).length,
      3,
    );
  }
  const issuerCounts = view.watchlist.reduce((counts, product) => {
    counts[product.issuer] = (counts[product.issuer] || 0) + 1;
    return counts;
  }, {});
  assert.ok(Object.values(issuerCounts).every((count) => count <= 2));
  for (const pick of view.watchlist) {
    assert.ok(view.all.some((product) => product.code === pick.code));
    const peers = view.all.filter(
      (product) => product.bucket === pick.bucket,
    );
    assert.ok(peers.length > 0);
    assert.ok(pick.selection_score >= 0);
    assert.equal(pick.selected, true);
  }
  assert.ok(view.stats.median_1y > 0);
  assert.ok(view.stats.median_1y < view.stats.target_annualized);
  assert.ok(view.stats.target_gap_pct < 0);
  assert.ok(view.stats.universe_median_1y > 0);
  assert.ok(view.all.every((product) => product.observation_ready));
  assert.ok(view.all.every((product) => product.currency_code === '10'));
  assert.ok(view.all.every((product) => product.pub_prv === 'A'));
});
