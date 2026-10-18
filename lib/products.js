'use strict';

const fs = require('node:fs');

const TARGET_ANNUALIZED = 3.0;

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
        name: raw.name.trim(),
        code: raw.code.trim(),
        issuer: raw.issuer.trim(),
        risk_level: raw.risk_level.trim(),
        term_days: numberOrNull(raw.term_days),
        score: numberOrNull(raw.score),
        min_amount: numberOrNull(raw.min_amount),
        annualized_yield: numberOrNull(raw.annualized_yield),
        benchmark: raw.benchmark.trim(),
        return_1m: numberOrNull(raw.return_1m_annualized),
        return_3m: numberOrNull(raw.return_3m_annualized),
        return_6m: numberOrNull(raw.return_6m_annualized),
        return_1y: numberOrNull(raw.return_1y_annualized),
        return_since_inception: numberOrNull(raw.return_since_inception_annualized),
        status: raw.status.trim(),
        source: raw.source.trim(),
        data_date: raw.data_date.trim(),
        notes: raw.notes.trim(),
        capacity: numberOrNull(raw.capacity),
      };
    })
    .filter((product) => product.name && product.code);
}

function bucketForTerm(termDays) {
  if (termDays === null) return 'unknown';
  if (termDays <= 30) return 'short';
  if (termDays < 180) return 'medium';
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
  return (
    /(?:PR|R)2/i.test(product.risk_level || '') &&
    product.capacity !== 0 &&
    !/募集|新发/i.test(product.status || '') &&
    Number.isFinite(product.return_1y) &&
    Number.isFinite(product.return_3m) &&
    Number.isFinite(product.return_6m)
  );
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
      observation_ready: isObservationReady(product),
      target_gap_pct:
        product.return_1y === null ? null : Number((product.return_1y - TARGET_ANNUALIZED).toFixed(4)),
    }))
    .sort((a, b) => {
      const termA = a.term_days ?? 9999;
      const termB = b.term_days ?? 9999;
      return termA - termB || a.name.localeCompare(b.name, 'zh-CN');
    });

  const candidates = decorated.filter((product) => product.observation_ready);
  const watchlist = [];
  for (const bucket of ['short', 'medium', 'long']) {
    const best = candidates
      .filter((product) => product.bucket === bucket)
      .sort((a, b) => b.observation_score - a.observation_score)[0];
    if (best) watchlist.push(best);
  }

  const oneYear = candidates
    .map((product) => product.return_1y)
    .filter((value) => Number.isFinite(value));
  const threeMonth = candidates
    .map((product) => product.return_3m)
    .filter((value) => Number.isFinite(value));
  const sixMonth = candidates
    .map((product) => product.return_6m)
    .filter((value) => Number.isFinite(value));
  const median1y = median(oneYear);
  const median3m = median(threeMonth);
  const median6m = median(sixMonth);

  return {
    all: decorated,
    watchlist,
    stats: {
      total: decorated.length,
      observation_ready: candidates.length,
      median_1y: median1y === null ? null : Number(median1y.toFixed(4)),
      median_3m: median3m === null ? null : Number(median3m.toFixed(4)),
      median_6m: median6m === null ? null : Number(median6m.toFixed(4)),
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
};
