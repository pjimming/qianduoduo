'use strict';

const {
  extractDate,
  normalizeText,
} = require('./trade-parser');

const DAY_MS = 24 * 60 * 60 * 1000;

function shiftDate(date, days) {
  const stamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(stamp)) return date;
  return new Date(stamp + days * DAY_MS).toISOString().slice(0, 10);
}

function parseNumber(value) {
  const normalized = String(value || '')
    .replaceAll(',', '')
    .replace(/[−–—]/g, '-')
    .replace(/\s+/g, '');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function extractLabeledNumber(text, labels) {
  const normalized = normalizeText(text)
    .replace(/(\d)\s+(?=\d)/g, '$1')
    .replace(/[−–—]/g, '-');
  for (const label of labels) {
    const pattern = new RegExp(
      `(?:${label})[^\\d+\\-]{0,18}([+\\-]?\\s*[¥]?\\s*[\\d,]+(?:\\.\\d{1,2})?)`,
    );
    const match = normalized.match(pattern);
    if (!match) continue;
    const value = parseNumber(match[1]);
    if (value !== null) return value;
  }
  return null;
}

function extractDailyPnl(text) {
  return extractLabeledNumber(text, [
    '昨日收益',
    '当日收益',
    '今日收益',
    '昨日盈亏',
    '当日盈亏',
    '日收益',
    '收益金额',
  ]);
}

function extractPrincipal(text) {
  return extractLabeledNumber(text, [
    '持仓金额',
    '持有金额',
    '理财总资产',
    '总资产',
    '当前本金',
    '本金',
    '账户余额',
  ]);
}

/**
 * 解析招行收益/持仓截图的候选字段。日期缺失时回退到最近已披露日，
 * 但只有截图里明确出现日期和收益数字时才获得高置信度并自动入账。
 */
function parseIncomeText(rawText, options = {}) {
  const text = normalizeText(rawText);
  const today = options.today || new Date().toISOString().slice(0, 10);
  const fallbackDate =
    options.reportingDate || shiftDate(today, -1);
  const detectedDate = extractDate(text, today.slice(0, 4));
  const recordDate = detectedDate || fallbackDate;
  const dailyPnl = extractDailyPnl(text);
  const principal = extractPrincipal(text);
  const explicitIncomeLabel =
    /昨日收益|当日收益|今日收益|昨日盈亏|当日盈亏|日收益|收益金额/.test(text);

  let confidence = 0;
  if (dailyPnl !== null) confidence += 60;
  if (detectedDate) confidence += 25;
  if (principal !== null) confidence += 10;
  if (text) confidence += 5;

  const warnings = [
    ...(dailyPnl === null ? ['未识别到昨日/当日收益'] : []),
    ...(detectedDate ? [] : ['未识别到截图日期，已使用最近披露日']),
    ...(explicitIncomeLabel ? [] : ['未看到明确的收益字段标签，请核对数字']),
    ...(text ? [] : ['截图没有可识别文字']),
  ];

  return {
    date: recordDate,
    daily_pnl: dailyPnl,
    principal,
    confidence,
    warnings,
    fields_found: [
      ...(detectedDate ? ['date'] : []),
      ...(dailyPnl !== null ? ['daily_pnl'] : []),
      ...(principal !== null ? ['principal'] : []),
    ],
  };
}

module.exports = {
  extractDailyPnl,
  extractLabeledNumber,
  extractPrincipal,
  parseIncomeText,
};
