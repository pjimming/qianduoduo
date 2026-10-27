'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseIncomeText } = require('../lib/income-parser');

test('income parser extracts disclosed daily P&L, date and principal', () => {
  const parsed = parseIncomeText(
    `
    招银理财
    2026年10月19日
    昨日收益 +12.34
    持仓金额 ¥108,600.20
    `,
    { today: '2026-10-20', reportingDate: '2026-10-19' },
  );
  assert.equal(parsed.date, '2026-10-19');
  assert.equal(parsed.daily_pnl, 12.34);
  assert.equal(parsed.principal, 108600.2);
  assert.equal(parsed.confidence, 100);
  assert.deepEqual(parsed.warnings, []);
});

test('income parser preserves negative P&L and flags a missing date', () => {
  const parsed = parseIncomeText('昨日收益 − 3.5 元', {
    today: '2026-10-20',
    reportingDate: '2026-10-19',
  });
  assert.equal(parsed.date, '2026-10-19');
  assert.equal(parsed.daily_pnl, -3.5);
  assert.equal(parsed.confidence, 65);
  assert.ok(parsed.warnings.some((item) => item.includes('未识别到截图日期')));
});

test('income parser does not invent a P&L number', () => {
  const parsed = parseIncomeText('累计收益 123.45', {
    today: '2026-10-20',
    reportingDate: '2026-10-19',
  });
  assert.equal(parsed.daily_pnl, null);
  assert.ok(parsed.confidence < 75);
  assert.ok(parsed.warnings.some((item) => item.includes('未识别到昨日')));
});

test('income parser splits one screenshot into multiple product valuations', () => {
  const products = [
    { code: '120056A', name: '招银理财稳享90天' },
    { code: '120026A', name: '招银理财日日欣14天' },
    { code: '107320A', name: '招银理财月月宝30天' },
  ];
  const parsed = parseIncomeText(
    `
    招行理财持仓
    2026年10月20日
    120056A 招银理财稳享90天
    持仓金额 6,000.00
    昨日收益 +1.44
    120026A 招银理财日日欣14天
    持仓金额 3,000.00
    昨日收益 +0.58
    107320A 招银理财月月宝30天
    持仓金额 1,200.00
    昨日收益 +0.29
    `,
    {
      today: '2026-10-21',
      reportingDate: '2026-10-20',
      products,
    },
  );
  assert.equal(parsed.date, '2026-10-20');
  assert.equal(parsed.products.length, 3);
  assert.deepEqual(
    parsed.products.map((item) => [
      item.product_code,
      item.holding_amount,
      item.daily_pnl,
    ]),
    [
      ['120056A', 6000, 1.44],
      ['120026A', 3000, 0.58],
      ['107320A', 1200, 0.29],
    ],
  );
  assert.equal(parsed.daily_pnl, null);
  assert.equal(parsed.principal, 10200);
  assert.equal(parsed.confidence, 95);
  assert.deepEqual(parsed.missing_product_codes, []);
  assert.ok(
    parsed.warnings.some(
      (item) =>
        item.includes('未识别到账户级收益总额') &&
        item.includes('不生成账户收益'),
    ),
  );
});

test('product split marks omitted holdings as not captured', () => {
  const parsed = parseIncomeText(
    `
    2026年10月20日
    昨日收益 -0.25
    120056A
    持仓金额 5,000.00
    当日收益 -0.25
    `,
    {
      today: '2026-10-21',
      reportingDate: '2026-10-20',
      products: [
        { code: '120056A', name: '产品A' },
        { code: '120026A', name: '产品B' },
      ],
    },
  );
  assert.equal(parsed.products.length, 1);
  assert.equal(parsed.products[0].product_code, '120056A');
  assert.equal(parsed.products[0].daily_pnl, -0.25);
  assert.deepEqual(parsed.missing_product_codes, ['120026A']);
});

test('generic daily P&L beside product details is not treated as an account total', () => {
  const parsed = parseIncomeText(
    `
    2026年10月20日
    昨日收益 2.31
    120056A
    持仓金额 6,000.00
    昨日收益 1.44
    120026A
    持仓金额 3,000.00
    昨日收益 0.58
    `,
    {
      today: '2026-10-21',
      reportingDate: '2026-10-20',
      products: [
        { code: '120056A', name: '产品A' },
        { code: '120026A', name: '产品B' },
      ],
    },
  );
  assert.equal(parsed.daily_pnl, null);
  assert.equal(parsed.product_daily_total, 2.02);
  assert.ok(
    parsed.warnings.some(
      (item) =>
        item.includes('未标明为账户总收益') &&
        item.includes('只归档产品明细'),
    ),
  );
});

test('explicit account total is compared with product details only as provisional evidence', () => {
  const parsed = parseIncomeText(
    `
    2026年10月20日
    账户总收益 2.31
    120056A
    持仓金额 6,000.00
    昨日收益 1.44
    120026A
    持仓金额 3,000.00
    昨日收益 0.58
    `,
    {
      today: '2026-10-21',
      reportingDate: '2026-10-20',
      products: [
        { code: '120056A', name: '产品A' },
        { code: '120026A', name: '产品B' },
      ],
    },
  );
  assert.equal(parsed.daily_pnl, 2.31);
  assert.equal(parsed.account_pnl_source, 'explicit-account-total');
  assert.equal(parsed.product_daily_total, 2.02);
  assert.ok(
    parsed.warnings.some(
      (item) =>
        item.includes('账户总收益与产品明细合计相差') &&
        item.includes('最大 T+N'),
    ),
  );
});

test('single-product cumulative income is never promoted to the account total', () => {
  const parsed = parseIncomeText(
    `
    2026年10月20日
    累计总收益 99.99
    120056A
    昨日收益 1.44
    `,
    {
      today: '2026-10-21',
      reportingDate: '2026-10-20',
      products: [{ code: '120056A', name: '产品A' }],
    },
  );
  assert.equal(parsed.products[0]?.daily_pnl, 1.44);
  assert.equal(parsed.daily_pnl, null);
  assert.equal(parsed.product_daily_total, 1.44);
});

test('income parser keeps the user-provided disclosure date for every product without lag shifting', () => {
  const parsed = parseIncomeText(
    `
    2026年10月21日
    昨日收益 1.20
    120056A
    持仓金额 6,000.00
    昨日收益 1.20
    `,
    {
      today: '2026-10-22',
      reportingDate: '2026-10-21',
      products: [{ code: '120056A', name: '产品A' }],
    },
  );
  assert.equal(parsed.date, '2026-10-21');
  assert.equal(parsed.products[0].yield_date, '2026-10-21');
  assert.equal(parsed.products[0].credit_date, '2026-10-21');
});

test('single-product merged update keeps its explicit coverage range without splitting the amount', () => {
  const parsed = parseIncomeText(
    `
    2026年10月26日
    120026A 招银理财14天
    昨日收益 0.58
    该次更新覆盖10月24日至26日，收益在10月26日合并更新
    `,
    {
      today: '2026-10-27',
      reportingDate: '2026-10-26',
      products: [{ code: '120026A', name: '招银理财14天' }],
    },
  );

  assert.equal(parsed.products[0].yield_date, '2026-10-26');
  assert.equal(parsed.products[0].daily_pnl, 0.58);
  assert.deepEqual(parsed.products[0].covered_yield_dates, [
    '2026-10-24',
    '2026-10-25',
    '2026-10-26',
  ]);
  assert.deepEqual(parsed.covered_yield_dates, [
    '2026-10-24',
    '2026-10-25',
    '2026-10-26',
  ]);
});
