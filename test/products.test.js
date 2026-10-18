'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  buildProductView,
  loadProductsFromCsv,
  parseCsv,
} = require('../lib/products');

const csvPath = path.join(__dirname, '..', 'data', 'cmb_r2_products_2026-10-18.csv');

test('parseCsv handles quoted commas', () => {
  const rows = parseCsv('name,note\nA,"hello, world"\nB,"a ""quote"""');
  assert.equal(rows[1][1], 'hello, world');
  assert.equal(rows[2][1], 'a "quote"');
});

test('product view picks one observation candidate per term bucket', () => {
  const products = loadProductsFromCsv(csvPath);
  const view = buildProductView(products);
  assert.equal(view.all.length, 14);
  assert.equal(view.watchlist.length, 3);
  assert.deepEqual(
    view.watchlist.map((product) => product.code),
    ['107340A', '107359A', '107326A'],
  );
  assert.equal(view.stats.median_1y, 1.62);
  assert.ok(view.stats.target_gap_pct < 0);
  assert.equal(view.all.find((product) => product.code === '670030V/N/P/T').observation_ready, false);
});
