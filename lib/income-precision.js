'use strict';

const SCALE = 10000;

function assertIncomeUnits(value) {
  if (!Number.isSafeInteger(value)) throw new Error('收益万分位必须为安全整数');
  return value;
}

// Parse decimal text first: multiplying a binary float can lose half-cent signs.
function toIncomeUnits(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    throw new Error('收益金额不能为空');
  }
  const raw = String(value).trim();
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match || (match[3] || '').length > 4) {
    throw new Error('收益金额必须是最多四位小数的有效数字');
  }
  const units = BigInt(match[2]) * 10000n + BigInt((match[3] || '').padEnd(4, '0'));
  const signed = match[1] === '-' ? -units : units;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('收益金额超出安全整数范围');
  }
  return Number(signed);
}

function fromIncomeUnits(units) {
  return assertIncomeUnits(units) / SCALE;
}

function roundIncomeUnitsToCents(units) {
  assertIncomeUnits(units);
  const absolute = BigInt(units < 0 ? -units : units);
  const rounded = Number((absolute + 50n) / 100n);
  return rounded === 0 ? 0 : units < 0 ? -rounded : rounded;
}

function effectiveIncomeUnits(record) {
  if (record.daily_pnl_1e4 !== null && record.daily_pnl_1e4 !== undefined) {
    return assertIncomeUnits(Number(record.daily_pnl_1e4));
  }
  return toIncomeUnits(record.daily_pnl);
}

function sumIncomeUnits(records) {
  return records.reduce((sum, row) => assertIncomeUnits(sum + effectiveIncomeUnits(row)), 0);
}

module.exports = { SCALE, assertIncomeUnits, toIncomeUnits, fromIncomeUnits,
  roundIncomeUnitsToCents, effectiveIncomeUnits, sumIncomeUnits };
