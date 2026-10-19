'use strict';

const fs = require('node:fs');

const TARGET_ANNUALIZED = 3.0;
const SELECTION_VERSION = 'r2-full-pool-v1';
const SELECTION_PER_BUCKET = 3;
const MAX_PER_ISSUER = 2;
const MIN_HISTORY_MONTHS = 12;
const PRIVATE_PRODUCT_PATTERN = /私行|私银|私享|尊享|企享|专属|私募/;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => value.trim() !== ''));
}

function numberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(String(value).replaceAll(',', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function loadProductsFromCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows
    .slice(1)
    .map((values) => {
      const raw = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
      return {
        name: (raw.name || '').trim(),
        code: (raw.code || '').trim(),
        short_name: (raw.short_name || '').trim(),
        issuer: (raw.issuer || '').trim(),
        risk_level: (raw.risk_level || '').trim(),
        currency_code: (raw.currency_code || '').trim(),
        pub_prv: (raw.pub_prv || '').trim(),
        soc_tag: (raw.soc_tag || '').trim(),
        product_type: (raw.product_type || '').trim(),
        term_days: numberOrNull(raw.term_days),
        score: numberOrNull(raw.score),
        min_amount: numberOrNull(raw.min_amount),
        annualized_yield: numberOrNull(raw.annualized_yield),
        benchmark: (raw.benchmark || '').trim(),
        return_1m: numberOrNull(raw.return_1m_annualized),
        return_3m: numberOrNull(raw.return_3m_annualized),
        return_6m: numberOrNull(raw.return_6m_annualized),
        return_1y: numberOrNull(raw.return_1y_annualized),
        return_since_inception: numberOrNull(raw.return_since_inception_annualized),
        status: (raw.status || '').trim(),
        source: (raw.source || '').trim(),
        data_date: (raw.data_date || '').trim(),
        notes: (raw.notes || '').trim(),
        capacity: numberOrNull(raw.capacity),
        history_months: numberOrNull(raw.history_months),
        fee_bps: numberOrNull(raw.fee_bps),
        next_open_date: (raw.next_open_date || '').trim(),
      };
    })
    .filter((product) => product.name && product.code);
}

function bucketForTerm(termDays) {
  if (termDays === null) return 'unknown';
  if (termDays <= 1) return 'cash';
  if (termDays <= 30) return 'short';
  if (termDays <= 100) return 'medium';
  return 'long';
}

function observationScore(product) {
  const m3 = product.return_3m ?? 0;
  const m6 = product.return_6m ?? 0;
  const y1 = product.return_1y ?? 0;
  let score = m3 * 0.45 + m6 * 0.3 + y1 * 0.25;

  // A sharp one-month divergence is a signal to re-check, not extra yield.
  if (product.return_1m !== null && product.return_1m < m3 - 0.5) {
    score -= 0.08;
  }
  return score;
}

function isObservationReady(product) {
  const risk = String(product.risk_level || '').toUpperCase();
  const name = `${product.name || ''} ${product.short_name || ''}`;
  const historyMonths = product.history_months;
  return (
    /^(?:PR|R)2$/.test(risk) &&
    (!product.currency_code || product.currency_code === '10') &&
    (!product.pub_prv || product.pub_prv === 'A') &&
    !PRIVATE_PRODUCT_PATTERN.test(name) &&
    !String(product.code || '').includes('/') &&
    product.capacity !== 0 &&
    Number.isFinite(product.term_days) &&
    product.term_days >= 0 &&
    (historyMonths === null || historyMonths >= MIN_HISTORY_MONTHS) &&
    /开放中/.test(product.status || '') &&
    !/募集|新发|未开放/.test(product.status || '') &&
    !/募集|新发/i.test(product.status || '') &&
    Number.isFinite(product.return_1m) &&
    Number.isFinite(product.return_1y) &&
    Number.isFinite(product.return_3m) &&
    Number.isFinite(product.return_6m)
  );
}

function selectionScore(product) {
  let score = observationScore(product);

  // A large gap between 1Y and 6M often means the 1Y figure is carried by an
  // older, non-repeatable period. Penalise it instead of chasing the headline.
  if (Number.isFinite(product.return_1y) && Number.isFinite(product.return_6m)) {
    const frontLoadGap = product.return_1y - product.return_6m;
    if (frontLoadGap > 1) {
      score -= Math.min(0.25, (frontLoadGap - 1) * 0.15);
    }
  }

  // Prefer products that have survived at least one full credit cycle leg.
  if (Number.isFinite(product.history_months)) {
    if (product.history_months >= 24) score += 0.03;
    else if (product.history_months >= 18) score += 0.015;
  }
  return score;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function buildProductView(products) {
  const decorated = products
    .map((product) => ({
      ...product,
      bucket: bucketForTerm(product.term_days),
      observation_score: Number(observationScore(product).toFixed(4)),
      selection_score: Number(selectionScore(product).toFixed(4)),
      observation_ready: isObservationReady(product),
      selected: false,
      selection_rank: null,
      target_gap_pct:
        product.return_1y === null ? null : Number((product.return_1y - TARGET_ANNUALIZED).toFixed(4)),
    }))
    .filter((product) => product.observation_ready)
    .sort((a, b) => {
      const termA = a.term_days ?? 9999;
      const termB = b.term_days ?? 9999;
      return termA - termB || a.name.localeCompare(b.name, 'zh-CN');
    });

  const candidates = decorated;
  const watchlist = [];
  const issuerCounts = new Map();

  function pickForBucket(bucket, limit = SELECTION_PER_BUCKET, enforceIssuerCap = true) {
    const peers = candidates
      .filter((product) => product.bucket === bucket && !product.selected)
      .sort(
        (a, b) =>
          b.selection_score - a.selection_score ||
          b.return_3m - a.return_3m ||
          b.return_6m - a.return_6m ||
          a.code.localeCompare(b.code),
      );
    for (const product of peers) {
      if (watchlist.filter((item) => item.bucket === bucket).length >= limit) break;
      const issuerCount = issuerCounts.get(product.issuer) || 0;
      if (enforceIssuerCap && issuerCount >= MAX_PER_ISSUER) continue;
      product.selected = true;
      product.selection_rank = watchlist.length + 1;
      watchlist.push(product);
      issuerCounts.set(product.issuer, issuerCount + 1);
    }
  }

  for (const bucket of ['short', 'medium', 'long']) {
    pickForBucket(bucket);
    // If issuer diversification leaves a bucket short, fill it with the next
    // best products rather than returning fewer than three candidates.
    if (watchlist.filter((item) => item.bucket === bucket).length < SELECTION_PER_BUCKET) {
      pickForBucket(bucket, SELECTION_PER_BUCKET, false);
    }
  }

  const selectedOneYear = watchlist
    .map((product) => product.return_1y)
    .filter((value) => Number.isFinite(value));
  const selectedThreeMonth = watchlist
    .map((product) => product.return_3m)
    .filter((value) => Number.isFinite(value));
  const selectedSixMonth = watchlist
    .map((product) => product.return_6m)
    .filter((value) => Number.isFinite(value));
  const universeOneYear = candidates
    .map((product) => product.return_1y)
    .filter((value) => Number.isFinite(value));
  const universeThreeMonth = candidates
    .map((product) => product.return_3m)
    .filter((value) => Number.isFinite(value));
  const universeSixMonth = candidates
    .map((product) => product.return_6m)
    .filter((value) => Number.isFinite(value));
  const median1y = median(selectedOneYear);
  const median3m = median(selectedThreeMonth);
  const median6m = median(selectedSixMonth);
  const universeMedian1y = median(universeOneYear);
  const universeMedian3m = median(universeThreeMonth);
  const universeMedian6m = median(universeSixMonth);
  const bucketCounts = decorated.reduce((counts, product) => {
    if (product.bucket in counts) counts[product.bucket] += 1;
    return counts;
  }, { cash: 0, short: 0, medium: 0, long: 0 });

  return {
    all: decorated,
    watchlist,
    selection: {
      version: SELECTION_VERSION,
      per_bucket: SELECTION_PER_BUCKET,
      max_per_issuer: MAX_PER_ISSUER,
      min_history_months: MIN_HISTORY_MONTHS,
      selected_count: watchlist.length,
      rules: [
        '仅保留人民币、公募、R2/PR2、开放中的普通可买产品',
        '剔除私行/私银/私享/尊享/企享/专属/私募产品',
        '要求 1M/3M/6M/1Y 完整且成立满 12 个月',
        '短/中/长每个期限桶保留 3 只，单一发行方最多 2 只',
        '评分以 3M/6M 为主，1Y 仅在无前视偏差罚分时计入',
      ],
    },
    stats: {
      total: decorated.length,
      observation_ready: candidates.length,
      selected_count: watchlist.length,
      median_1y: median1y === null ? null : Number(median1y.toFixed(4)),
      median_3m: median3m === null ? null : Number(median3m.toFixed(4)),
      median_6m: median6m === null ? null : Number(median6m.toFixed(4)),
      universe_median_1y:
        universeMedian1y === null ? null : Number(universeMedian1y.toFixed(4)),
      universe_median_3m:
        universeMedian3m === null ? null : Number(universeMedian3m.toFixed(4)),
      universe_median_6m:
        universeMedian6m === null ? null : Number(universeMedian6m.toFixed(4)),
      bucket_counts: bucketCounts,
      target_annualized: TARGET_ANNUALIZED,
      target_gap_pct:
        median1y === null ? null : Number((median1y - TARGET_ANNUALIZED).toFixed(4)),
      target_coverage_pct:
        median1y === null ? null : Number(((median1y / TARGET_ANNUALIZED) * 100).toFixed(1)),
    },
  };
}

module.exports = {
  bucketForTerm,
  buildProductView,
  isObservationReady,
  loadProductsFromCsv,
  observationScore,
  parseCsv,
  selectionScore,
  SELECTION_VERSION,
};
