'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shiftDate, todayShanghai } = require('../lib/metrics');
const {
  createDashboardQueryService,
} = require('../server/modules/dashboard/service');
const {
  createIncomeRepository,
} = require('../server/modules/income/repository');
const { createIncomeService } = require('../server/modules/income/service');
const { createTestContext } = require('./helpers/test-context');

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Wl3sAAAAASUVORK5CYII=',
  'base64',
);

test('high-confidence product-only OCR archives product facts and derives the account total', async (t) => {
  const context = createTestContext(t);
  const { repository } = context;
  const today = todayShanghai();
  const yieldDate = shiftDate(today, -1);
  repository.initializeCapital(30000, '2026-10-01');
  repository.tradeStore.createTrade({
    trade_date: '2026-10-01',
    confirm_date: '2026-10-01',
    trade_type: 'buy',
    status: 'confirmed',
    product_code: '120056A',
    product_name: '招银理财90天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 6000,
    term_days: 90,
    source: 'manual',
    notes: '',
  });
  repository.productValuationStore.saveYieldSetting('120056A', {
    yield_lag_days: 2,
    source: 'app-rule',
    notes: '测试产品 T+2 披露',
    verified_at: yieldDate,
  });

  const incomeRepository = createIncomeRepository(repository);
  const dashboardQuery = createDashboardQueryService(repository, {
    todayProvider: () => today,
  });
  const ocr = {
    async read() {
      return {
        ok: true,
        language: 'test-ocr',
        text: '收益截图',
        parsed: {
          date: yieldDate,
          valuation_date: yieldDate,
          credit_date: yieldDate,
          daily_pnl: null,
          principal: null,
          products: [
            {
              product_code: '120056A',
              product_name: '招银理财90天',
              holding_amount: 6000,
              yield_date: yieldDate,
              credit_date: yieldDate,
              daily_pnl: 1.23,
              confidence: 95,
            },
          ],
          missing_product_codes: [],
          confidence: 95,
          warnings: [],
        },
      };
    },
  };
  const service = createIncomeService({
    incomeRepository,
    dashboardQuery,
    ocr,
    todayProvider: () => today,
  });

  const result = await service.upload({
    buffer: ONE_PIXEL_PNG,
    mime: 'image/png',
    original_name: 'product-only.png',
  });

  assert.equal(result.statusCode, 201);
  assert.equal(result.body.auto_applied, true);
  assert.equal(result.body.record.daily_pnl, 1.23);
  assert.equal(result.body.record.source, 'product-income-summary');
  assert.equal(result.body.saved_valuations.length, 1);
  assert.equal(result.body.reconciliation.status, 'waiting');
  assert.equal(result.body.inbox.status, 'applied');
  assert.equal(repository.getRecord(yieldDate).daily_pnl, 1.23);
});

test('manual income apply forwards a merged coverage range to the single product fact', (t) => {
  const context = createTestContext(t);
  const { repository } = context;
  const today = '2026-10-27';
  repository.initializeCapital(30000, '2026-10-20');
  repository.tradeStore.createTrade({
    trade_date: '2026-10-20',
    confirm_date: '2026-10-20',
    trade_type: 'buy',
    status: 'confirmed',
    product_code: '120026A',
    product_name: '招银理财14天',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 6000,
    term_days: 14,
    source: 'manual',
    notes: '',
  });
  const incomeRepository = createIncomeRepository(repository);
  const dashboardQuery = createDashboardQueryService(repository, {
    todayProvider: () => today,
  });
  const service = createIncomeService({
    incomeRepository,
    dashboardQuery,
    ocr: { read: async () => ({}) },
    todayProvider: () => today,
  });
  const item = incomeRepository.addInbox({
    original_name: 'merged-income.png',
    stored_name: '',
    mime: 'image/png',
    bytes: 1,
    sha256: 'merged-income-test',
    ocr_text: '',
    parsed: {},
  });

  const result = service.apply(item.id, {
    date: '2026-10-26',
    covered_yield_dates: ['2026-10-24', '2026-10-25', '2026-10-26'],
    products: [
      {
        product_code: '120026A',
        product_name: '招银理财14天',
        holding_amount: 6000,
        daily_pnl: 0.58,
      },
    ],
  });

  assert.equal(result.saved_valuations.length, 1);
  assert.deepEqual(result.saved_valuations[0].covered_yield_dates, [
    '2026-10-24',
    '2026-10-25',
    '2026-10-26',
  ]);
  assert.match(result.saved_valuations[0].notes, /覆盖收益日期/);
  assert.equal(result.record.daily_pnl, 0.58);
  assert.equal(result.reconciliation.status, 'waiting');
  const clearItem = incomeRepository.addInbox({
    original_name: 'clear-coverage.png',
    stored_name: '',
    mime: 'image/png',
    bytes: 1,
    sha256: 'clear-coverage-test',
    ocr_text: '',
    parsed: {},
  });
  const cleared = service.apply(clearItem.id, {
    date: '2026-10-26',
    clear_coverage: true,
    products: [
      {
        product_code: '120026A',
        product_name: '招银理财14天',
        holding_amount: 6000,
        daily_pnl: 0.58,
      },
    ],
  });
  assert.deepEqual(cleared.saved_valuations[0].covered_yield_dates, []);
  assert.match(cleared.saved_valuations[0].notes, /覆盖收益日期：无/);
  assert.throws(
    () =>
      service.apply(item.id, {
        date: '2026-10-26',
        covered_yield_dates: ['2026-10-26'],
        products: [
          { product_code: '120026A', daily_pnl: 0.58 },
          { product_code: '120056A', daily_pnl: 0.12 },
        ],
      }),
    /各产品明细中分别提供覆盖日期/,
  );
});
