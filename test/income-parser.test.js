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
