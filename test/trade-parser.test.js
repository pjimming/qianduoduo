'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractAmount,
  extractCode,
  extractStatus,
  parseTradeText,
} = require('../lib/trade-parser');

const products = [
  {
    code: '120026A',
    name: '招银理财招睿添金（和享）14天持有期6号A',
    issuer: '招银理财',
    risk_level: 'R2',
    term_days: 14,
  },
  {
    code: '13328D',
    name: '招银理财招睿丰和180天持有期5号D',
    issuer: '招银理财',
    risk_level: 'R2',
    term_days: 180,
  },
];

test('trade parser reads amount, code, date, type and status from CMB text', () => {
  const text = `
    购买成功
    产品名称：招银理财招睿丰和180天持有期5号D
    产品代码：13328D
    交易金额：￥7,500.00
    确认份额：7,412.3500
    交易日期：2026年10月19日
    确认日期：2026-10-20
  `;
  const parsed = parseTradeText(text, { products, today: '2026-10-19' });
  assert.equal(parsed.trade_type, 'buy');
  assert.equal(parsed.status, 'confirmed');
  assert.equal(parsed.product_code, '13328D');
  assert.equal(parsed.product_name, '招银理财招睿丰和180天持有期5号D');
  assert.equal(parsed.amount, 7500);
  assert.equal(parsed.trade_date, '2026-10-19');
  assert.equal(parsed.confirm_date, '2026-10-20');
  assert.equal(parsed.term_days, 180);
  assert.equal(parsed.maturity_date, '2027-04-17');
  assert.ok(parsed.confidence >= 90);
});

test('trade parser recognizes redemption and pending states', () => {
  const text = `
    赎回申请已受理，交易进行中，可撤单
    招银理财招睿添金（和享）14天持有期6号A
    120026A
    赎回金额 3,000.00 元
  `;
  const parsed = parseTradeText(text, { products, today: '2026-10-19' });
  assert.equal(parsed.trade_type, 'redeem');
  assert.equal(parsed.status, 'pending');
  assert.equal(parsed.amount, 3000);
  assert.equal(parsed.product_code, '120026A');
  assert.equal(parsed.confirm_date, null);
});

test('trade parser falls back to manual correction when OCR is empty', () => {
  const parsed = parseTradeText('', { products, today: '2026-10-19' });
  assert.equal(parsed.trade_date, '2026-10-19');
  assert.equal(parsed.trade_type, 'buy');
  assert.equal(parsed.status, 'pending');
  assert.equal(parsed.amount, null);
  assert.equal(parsed.confidence, 0);
  assert.match(parsed.warnings.join(' '), /金额/);
});

test('trade parser helpers tolerate full-width text', () => {
  const text = '金额：￥１，２３４．５０\n交易状态：已确认\n产品代码：１２３４５Ａ';
  assert.equal(extractAmount(text), 1234.5);
  assert.equal(extractStatus(text), 'confirmed');
  assert.equal(extractCode(text), '12345A');
});
