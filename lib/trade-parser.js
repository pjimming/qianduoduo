'use strict';

function fullWidthToHalf(value) {
  return String(value || '')
    .replace(/[０-９]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0),
    )
    .replace(/[Ａ-Ｚａ-ｚ]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0),
    )
    .replace(/[，]/g, ',')
    .replace(/[．。·]/g, '.')
    .replace(/[：]/g, ':')
    .replace(/[￥]/g, '¥')
    .replace(/\u00a0/g, ' ');
}

function normalizeText(text) {
  return fullWidthToHalf(text)
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function compactAlphanumeric(text) {
  return normalizeText(text).replace(
    /(?<=[A-Z0-9])\s+(?=[A-Z0-9])/g,
    '',
  );
}

function todayYmd(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function extractDate(text, fallbackYear) {
  const normalized = normalizeText(text).replace(/(\d)\s+(?=\d)/g, '$1');
  const full = normalized.match(
    /(20\d{2})\s*[年\-/.一]\s*(\d{1,2})\s*[月\-/.一]\s*(\d{1,2})\s*日?/,
  );
  if (full) {
    return `${full[1]}-${String(full[2]).padStart(2, '0')}-${String(
      full[3],
    ).padStart(2, '0')}`;
  }
  const short = normalized.match(/(\d{1,2})月(\d{1,2})日/);
  if (short && fallbackYear) {
    return `${fallbackYear}-${String(short[1]).padStart(2, '0')}-${String(
      short[2],
    ).padStart(2, '0')}`;
  }
  return null;
}

function parseNumber(value) {
  const number = Number(String(value).replaceAll(',', ''));
  return Number.isFinite(number) ? number : null;
}

function stripDateFragments(text) {
  return text
    .replace(
      /20\d{2}\s*[年\-/.一]\s*\d{1,2}\s*[月\-/.一]\s*\d{1,2}\s*日?/g,
      ' ',
    )
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日/g, ' ');
}

function extractAmount(text) {
  const normalized = stripDateFragments(normalizeText(text))
    .replace(/(\d)\s*,\s*(?=\d)/g, '$1,')
    .replace(/(\d)\s*\.\s*(\d{1,2})(?!\d)/g, '$1.$2')
    .replace(/(\d)\s+(?=\d)/g, '$1');
  const labelled = [
    /(?:交易金额|成交金额|购买金额|买入金额|申购金额|赎回金额|金额|本金)[^\d¥]{0,8}[¥]?\s*([\d,]+(?:\.\d{1,2})?)/,
    /[¥]\s*([\d,]+(?:\.\d{1,2})?)/,
    /(?<![\d.])(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*元/,
  ];
  for (const pattern of labelled) {
    const match = normalized.match(pattern);
    if (match) {
      const amount = parseNumber(match[1]);
      if (amount !== null && amount > 0) return amount;
    }
  }
  return null;
}

function extractShares(text) {
  const match = normalizeText(text).match(
    /(?:持有份额|确认份额|赎回份额|份额)[^\d]{0,8}([\d,]+(?:\.\d{1,4})?)/,
  );
  if (!match) return null;
  const value = parseNumber(match[1]);
  return value && value > 0 ? value : null;
}

function extractTermDays(text) {
  const match = normalizeText(text).match(/(\d{1,4})\s*天(?:持有|封闭|期)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 0 && value <= 3650 ? value : null;
}

function extractTradeType(text) {
  const normalized = normalizeText(text);
  const compact = normalized.replace(/\s+/g, '');
  if (/切换|转换/.test(compact)) return 'switch';
  if (/赎回|卖出/.test(compact)) return 'redeem';
  if (/购买|买入|申购/.test(compact)) return 'buy';
  return null;
}

function extractStatus(text) {
  const normalized = normalizeText(text);
  const compact = normalized.replace(/\s+/g, '');
  if (/已撤单|已撤销|撤单成功|交易撤销/.test(compact)) return 'cancelled';
  if (/已确认|确认成功|购买成功|买入成功|赎回成功|交易成功|已成交/.test(compact)) {
    return 'confirmed';
  }
  if (/待确认|进行中|处理中|已受理|确认中|可撤单/.test(compact)) {
    return 'pending';
  }
  return null;
}

function extractCode(text) {
  const matches = compactAlphanumeric(text).match(
    /(?<![A-Z0-9])(\d{5,8}[A-Z])(?![A-Z0-9])/g,
  );
  if (!matches || !matches.length) return null;
  return matches[0].toUpperCase();
}

function compactName(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[（）()【】\[\]·•\-—_/\\]/g, '')
    .toUpperCase();
}

function coreProductName(name) {
  return String(name || '')
    .replace(
      /(?:固定收益类|混合类|权益类|商品及金融衍生品类)?理财(?:计划|产品)$/u,
      '',
    )
    .trim();
}

function longestCommonSubsequenceLength(a, b) {
  if (!a || !b) return 0;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  let previous = new Array(short.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= long.length; i += 1) {
    const current = new Array(short.length + 1).fill(0);
    for (let j = 1; j <= short.length; j += 1) {
      if (long[i - 1] === short[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    previous = current;
  }
  return best;
}

function findProduct(text, products) {
  const normalized = text.replace(/\s+/g, '');
  const code = extractCode(text);
  if (code) {
    const byCode = products.find(
      (product) => String(product.code).toUpperCase() === code,
    );
    if (byCode) return { code: byCode.code, product: byCode };
  }
  const sorted = [...products].sort(
    (a, b) => String(b.name).length - String(a.name).length,
  );
  for (const product of sorted) {
    const name = String(product.name || '').replace(/\s+/g, '');
    const shortName = name.replace(/^招银理财/, '');
    const coreName = coreProductName(name).replace(/\s+/g, '');
    if (name && normalized.includes(name)) {
      return { code: product.code, product };
    }
    if (shortName.length >= 6 && normalized.includes(shortName)) {
      return { code: product.code, product };
    }
    if (coreName.length >= 8 && normalized.includes(coreName)) {
      return { code: product.code, product };
    }
  }
  // OCR 常漏掉「号」等单字，名称完全包含匹配会失败。这里用字符子序列
  // 相似度兜底，并要求与第二名拉开差距，避免 A/B 份额混淆。
  const target = compactName(text);
  let best = null;
  let runnerUp = 0;
  for (const product of sorted) {
    const name = compactName(coreProductName(product.name) || product.name);
    if (name.length < 8) continue;
    const ratio = longestCommonSubsequenceLength(target, name) / name.length;
    if (!best || ratio > best.ratio) {
      runnerUp = best ? best.ratio : 0;
      best = { product, ratio };
    } else if (ratio > runnerUp) {
      runnerUp = ratio;
    }
  }
  if (best && best.ratio >= 0.9 && best.ratio - runnerUp >= 0.01) {
    return { code: best.product.code, product: best.product };
  }
  return { code, product: null };
}

function extractConfirmDate(text, tradeDate) {
  const compact = normalizeText(text).replace(/\s+/g, '');
  const match = compact.match(
    /(?:确认日|确认日期|确认时间)[^\d]{0,6}(20\d{2}[年\-/.一]\d{1,2}[月\-/.一]\d{1,2}日?)/,
  );
  if (!match) return null;
  const date = extractDate(match[1], tradeDate?.slice(0, 4));
  return date && tradeDate && date >= tradeDate ? date : null;
}

function confidenceOf(fields) {
  const weights = {
    trade_date: 20,
    trade_type: 15,
    product_code: 20,
    product_name: 15,
    amount: 20,
    status: 10,
  };
  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    if (fields[key]) score += weight;
  }
  return score;
}

/**
 * 把 OCR 文本解析成可校正的交易草稿。解析只做候选提取，
 * 金额、产品、状态都必须由用户在收件箱里确认后才写入流水。
 */
function parseTradeText(rawText, options = {}) {
  const text = normalizeText(rawText);
  const today = options.today || todayYmd();
  const products = Array.isArray(options.products) ? options.products : [];
  const detectedDate = extractDate(text, today.slice(0, 4));
  const detectedType = extractTradeType(text);
  const detectedStatus = extractStatus(text);
  const tradeDate = detectedDate || today;
  const tradeType = detectedType || 'buy';
  const status = detectedStatus || 'pending';
  const amount = extractAmount(text);
  const shares = extractShares(text);
  const found = findProduct(text, products);
  const product = found.product;
  const detectedCode = product?.code || found.code || '';
  const detectedName = product?.name || '';
  const termDays = product?.term_days ?? extractTermDays(text);
  const confirmDate =
    status === 'confirmed'
      ? extractConfirmDate(text, tradeDate) || tradeDate
      : null;
  const fields = {
    trade_date: tradeDate,
    confirm_date: confirmDate,
    trade_type: tradeType,
    status,
    product_code: detectedCode,
    product_name: detectedName,
    issuer: product?.issuer || '',
    risk_level: product?.risk_level || 'R2',
    amount,
    shares,
    term_days: termDays,
    maturity_date: null,
  };
  if (
    product?.term_days &&
    (tradeType === 'buy' || tradeType === 'switch')
  ) {
    const stamp = Date.parse(`${tradeDate}T00:00:00Z`);
    if (Number.isFinite(stamp)) {
      fields.maturity_date = new Date(
        stamp + product.term_days * 86400000,
      )
        .toISOString()
        .slice(0, 10);
    }
  }
  const confidence = confidenceOf({
    trade_date: detectedDate,
    trade_type: detectedType,
    product_code: detectedCode,
    product_name: detectedName,
    amount,
    status: detectedStatus,
  });
  return {
    ...fields,
    confidence,
    fields_found: Object.entries(fields)
      .filter(([, value]) => value !== null && value !== '')
      .map(([key]) => key),
    warnings: [
      ...(amount === null ? ['未识别到金额'] : []),
      ...(fields.product_code ? [] : ['未识别到产品代码']),
      ...(fields.product_name ? [] : ['未匹配到产品名称']),
      ...(text ? [] : ['截图没有可识别文字']),
    ],
  };
}

module.exports = {
  extractAmount,
  extractCode,
  extractDate,
  extractShares,
  extractStatus,
  extractTradeType,
  findProduct,
  normalizeText,
  parseTradeText,
};
