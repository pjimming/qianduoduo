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

function compactProductText(text) {
  return normalizeText(text)
    .replace(/(?<=[A-Z0-9])[ \t]+(?=[A-Z0-9])/g, '')
    .replace(/[−–—]/g, '-');
}

function productMarker(compactText, product) {
  const code = String(product.code || product.product_code || '')
    .trim()
    .toUpperCase();
  if (code) {
    const upperText = compactText.toUpperCase();
    let searchFrom = 0;
    while (searchFrom < upperText.length) {
      const index = upperText.indexOf(code, searchFrom);
      if (index < 0) break;
      const before = index > 0 ? upperText[index - 1] : '';
      const after = upperText[index + code.length] || '';
      if (!/[A-Z0-9]/.test(before) && !/[A-Z0-9]/.test(after)) {
        return {
          code,
          name: product.name || product.product_name || '',
          index,
        };
      }
      searchFrom = index + 1;
    }
  }
  const name = String(product.name || product.product_name || '')
    .replace(/\s+/g, '')
    .replace(/[（）()【】\[\]·•\-—_/\\]/g, '');
  if (name.length >= 4) {
    const snippets = [name, name.slice(0, Math.min(10, name.length))];
    for (const snippet of snippets) {
      const index = compactText.indexOf(snippet);
      if (index >= 0) {
        return {
          code,
          name: product.name || product.product_name || '',
          index,
        };
      }
    }
  }
  return null;
}

/**
 * 从一张收益/持仓截图中按产品代码切出产品明细。只有已知持仓才进入候选，
 * 避免把金额、日期或其它八位数字误当成产品代码。
 */
function extractProductValuations(rawText, options = {}) {
  const text = compactProductText(rawText);
  const products = Array.isArray(options.products) ? options.products : [];
  const markers = products
    .map((product) => productMarker(text, product))
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);
  const uniqueMarkers = [];
  for (const marker of markers) {
    if (
      uniqueMarkers.some(
        (item) => item.code === marker.code && item.index === marker.index,
      )
    ) {
      continue;
    }
    uniqueMarkers.push(marker);
  }

  return uniqueMarkers.map((marker, index) => {
    const next = uniqueMarkers[index + 1];
    const context = text.slice(marker.index, next ? next.index : text.length);
    const dailyPnl = extractDailyPnl(context);
    const holdingAmount = extractPrincipal(context);
    const confidence =
      (marker.code ? 35 : 15) +
      (dailyPnl !== null ? 45 : 0) +
      (holdingAmount !== null ? 20 : 0);
    return {
      product_code: marker.code,
      product_name: marker.name,
      holding_amount: holdingAmount,
      daily_pnl: dailyPnl,
      confidence,
      warnings: [
        ...(dailyPnl === null ? ['未识别到该产品当日收益'] : []),
        ...(holdingAmount === null ? ['未识别到该产品持仓金额'] : []),
      ],
    };
  });
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
  const products = extractProductValuations(text, {
    products: options.products || options.holdings || [],
  }).map((product) => {
    return {
      ...product,
      yield_date: recordDate,
      credit_date: recordDate,
      warnings: [...(product.warnings || [])],
    };
  });
  const knownCodes = (options.products || options.holdings || [])
    .map((product) => String(product.code || product.product_code || '').toUpperCase())
    .filter(Boolean);
  const detectedCodes = products
    .map((product) => product.product_code)
    .filter(Boolean);
  const missingProductCodes = knownCodes.filter(
    (code) => !detectedCodes.includes(code),
  );
  const firstProductIndex = knownCodes
    .map((code) => text.toUpperCase().indexOf(code))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  // 多产品截图只从第一只产品之前读取账户合计，避免把首只产品收益冒充总账。
  const accountHeaderText =
    products.length > 1 && firstProductIndex >= 0
      ? text.slice(0, firstProductIndex)
      : text;
  const explicitDailyPnl = extractDailyPnl(accountHeaderText);
  const allDetectedProductsHaveDaily =
    products.length > 0 &&
    products.every((product) => product.daily_pnl !== null);
  const productDailyTotal = allDetectedProductsHaveDaily
    ? Math.round(
        (products.reduce((sum, product) => sum + Number(product.daily_pnl), 0) +
          Number.EPSILON) *
          100,
      ) / 100
    : null;
  const completeProductDaily =
    knownCodes.length > 0 &&
    products.length === knownCodes.length &&
    products.every((product) => product.daily_pnl !== null);
  const dailyPnl =
    explicitDailyPnl !== null
      ? explicitDailyPnl
      : completeProductDaily
        ? productDailyTotal
        : null;
  const hasAccountPrincipalLabel =
    /理财总资产|总资产|账户余额|当前本金/.test(text);
  const productHoldingTotal =
    products.length &&
    products.every((product) => product.holding_amount !== null)
      ? Math.round(
          (products.reduce(
            (sum, product) => sum + Number(product.holding_amount),
            0,
          ) +
            Number.EPSILON) *
            100,
        ) / 100
      : null;
  const principal = hasAccountPrincipalLabel
    ? extractPrincipal(text)
    : productHoldingTotal ?? extractPrincipal(text);
  const explicitIncomeLabel =
    /昨日收益|当日收益|今日收益|昨日盈亏|当日盈亏|日收益|收益金额/.test(text);

  let confidence = 0;
  if (dailyPnl !== null) confidence += 60;
  if (detectedDate) confidence += 25;
  if (principal !== null) confidence += 10;
  if (text) confidence += 5;
  if (
    dailyPnl !== null &&
    explicitDailyPnl === null &&
    completeProductDaily
  ) {
    confidence = Math.max(confidence, detectedDate ? 95 : 70);
  }

  const warnings = [
    ...(dailyPnl === null ? ['未识别到昨日/当日收益'] : []),
    ...(detectedDate ? [] : ['未识别到截图日期，已使用最近披露日']),
    ...(explicitIncomeLabel ? [] : ['未看到明确的收益字段标签，请核对数字']),
    ...(explicitDailyPnl === null && completeProductDaily
      ? ['账户总收益缺失，暂用已识别产品收益合计']
      : []),
    ...(explicitDailyPnl !== null &&
    productDailyTotal !== null &&
    Math.abs(explicitDailyPnl - productDailyTotal) > 0.01
      ? [
          `账户总收益与产品明细合计相差 ¥${(
            explicitDailyPnl - productDailyTotal
          ).toFixed(2)}`,
        ]
      : []),
    ...(missingProductCodes.length
      ? [`本次未拍到：${missingProductCodes.join('、')}`]
      : []),
    ...(text ? [] : ['截图没有可识别文字']),
  ];

  return {
    date: recordDate,
    valuation_date: recordDate,
    credit_date: recordDate,
    daily_pnl: dailyPnl,
    principal,
    product_daily_total: productDailyTotal,
    products,
    missing_product_codes: missingProductCodes,
    confidence,
    warnings,
    fields_found: [
      ...(detectedDate ? ['date'] : []),
      ...(dailyPnl !== null ? ['daily_pnl'] : []),
      ...(principal !== null ? ['principal'] : []),
      ...(products.length ? ['products'] : []),
    ],
  };
}

module.exports = {
  extractProductValuations,
  extractDailyPnl,
  extractLabeledNumber,
  extractPrincipal,
  parseIncomeText,
};
