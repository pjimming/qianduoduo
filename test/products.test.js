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

test('product view picks one observation candidate per term bucket', () => {
  const products = loadProductsFromCsv(csvPath);
  const view = buildProductView(products);
  assert.equal(view.all.length, products.length);
  assert.ok(view.all.length >= 14);
  assert.equal(view.watchlist.length, 3);
  assert.deepEqual(
    view.watchlist.map((product) => product.bucket),
    ['short', 'medium', 'long'],
  );
  for (const pick of view.watchlist) {
    assert.ok(view.all.some((product) => product.code === pick.code));
    const peers = view.all.filter(
      (product) => product.bucket === pick.bucket && product.observation_ready,
    );
    assert.ok(peers.length > 0);
    assert.equal(
      pick.observation_score,
      Math.max(...peers.map((product) => product.observation_score)),
    );
  }
  assert.ok(view.stats.median_1y > 0);
  assert.ok(view.stats.median_1y < view.stats.target_annualized);
  assert.ok(view.stats.target_gap_pct < 0);
  assert.ok(view.all.some((product) => product.observation_ready === false));
});
