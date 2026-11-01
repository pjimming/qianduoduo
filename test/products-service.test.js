'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createProductsService,
} = require('../server/modules/products/service');

function product(overrides) {
  return {
    name: '测试产品',
    code: 'TEST001',
    short_name: '',
    issuer: '招银理财',
    risk_level: 'R2',
    product_type: '代销理财',
    term_days: 7,
    min_amount: 1,
    annualized_yield: 2.5,
    benchmark: '测试基准',
    return_1m: 2.4,
    return_3m: 2.3,
    return_6m: 2.2,
    return_1y: null,
    return_since_inception: 2.1,
    status: '开放中',
    source: 'test',
    data_date: '2026-10-29',
    notes: '',
    history_months: 8,
    fee_bps: 27,
    next_open_date: '',
    ...overrides,
  };
}

test('unopened snapshot endpoint includes only display-only closed products', () => {
  const repository = {
    listProducts() {
      return [
        product({
          name: '开放产品',
          code: 'OPEN001',
          status: '开放中',
        }),
        product({
          name: '未开放产品',
          code: '120019K',
          status: '未开放',
          data_date: '2026-10-29',
        }),
        product({
          name: '另一只未开放产品',
          code: 'CLOSED002',
          status: '未开放',
          data_date: '2026-10-28',
        }),
      ];
    },
  };
  const service = createProductsService(repository);
  const result = service.listUnopenedProducts();

  assert.equal(result.count, 2);
  assert.equal(result.snapshot_date, '2026-10-29');
  assert.deepEqual(
    result.products.map((item) => item.code),
    ['120019K', 'CLOSED002'],
  );
  assert.ok(result.products.every((item) => item.display_only === true));
  assert.ok(result.products.every((item) => item.status === '未开放'));
  assert.equal(result.products[0].bucket, 'short');
});
