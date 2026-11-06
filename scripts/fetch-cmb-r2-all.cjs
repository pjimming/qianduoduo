#!/usr/bin/env node
'use strict';

/**
 * 拉取招行 R2 公开全量池，并生成：
 *   data/cmb_r2_all-YYYY-MM-DD.csv       全量原始结果
 *   data/cmb_r2_universe-YYYY-MM-DD.csv  普通可买候选池
 *   data/cmb_r2_selected-YYYY-MM-DD.csv  研究观察池（不含资金分配）
 *   data/cmb_r2_snapshot-YYYY-MM-DD.csv  应用快照（开放 + 未开放展示记录）
 *
 * 只使用公开接口，不登录账户、不抓取实时额度、不替用户下单。
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  buildProductView,
  isProductPoolEligible,
} = require('../lib/products');
const {
  captureObservationFromFile,
} = require('../lib/yield-observation');

const ROOT = path.resolve(__dirname, '..');
const { openPublicBrowser, createProductListClient, queryProducts } = require('../server/modules/r2-screening/product-list');
const DATA_DIR = path.join(ROOT, 'data');
const HEADERS = [
  'name',
  'short_name',
  'code',
  'issuer',
  'risk_level',
  'currency_code',
  'pub_prv',
  'soc_tag',
  'product_type',
  'term_days',
  'min_amount',
  'annualized_yield',
  'benchmark',
  'return_1m_annualized',
  'return_3m_annualized',
  'return_6m_annualized',
  'return_1y_annualized',
  'return_since_inception_annualized',
  'status',
  'source',
  'data_date',
  'history_months',
  'fee_bps',
  'next_open_date',
];
const CHINESE_NUMBERS = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function numberOrNull(value) {
  const number = Number(String(value ?? '').replace('%', ''));
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function parseDate(value) {
  const source = text(value);
  let match = /^(\d{4})(\d{2})(\d{2})$/.exec(source);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(source);
  if (match) {
    return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(source) ? source : '';
}

function daysBetween(left, right) {
  if (!left || !right) return null;
  const leftMs = Date.parse(`${left}T00:00:00Z`);
  const rightMs = Date.parse(`${right}T00:00:00Z`);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs)
    ? Math.round((rightMs - leftMs) / 86400000)
    : null;
}

function chineseNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  if (CHINESE_NUMBERS[value] !== undefined) return CHINESE_NUMBERS[value];
  if (value.includes('十')) {
    const [tens, ones] = value.split('十');
    return (tens ? CHINESE_NUMBERS[tens] ?? 1 : 1) * 10 + (ones ? CHINESE_NUMBERS[ones] ?? 0 : 0);
  }
  return null;
}

function parseTerm(name) {
  const source = text(name);
  let match = /(\d+)\s*(天|日)/.exec(source);
  if (match) return Number(match[1]);
  match = /(\d+)\s*个?月/.exec(source);
  if (match) return Math.round(Number(match[1]) * 30.44);
  match = /(\d+)\s*(?:年|Y)/i.exec(source);
  if (match) return Math.round(Number(match[1]) * 365);
  match = /(\d+)\s*M/i.exec(source);
  if (match) return Math.round(Number(match[1]) * 30.44);
  match = /([一二两三四五六七八九十]+)\s*(天|日)/.exec(source);
  if (match && chineseNumber(match[1])) return chineseNumber(match[1]);
  match = /([一二两三四五六七八九十]+)\s*个?月/.exec(source);
  if (match && chineseNumber(match[1])) return Math.round(chineseNumber(match[1]) * 30.44);
  const terms = [
    ['双周', 14],
    ['周周', 7],
    ['周开', 7],
    ['双月', 60],
    ['月月', 30],
    ['季季', 90],
    ['季开', 90],
    ['半年', 180],
    ['年年', 365],
    ['两年', 730],
    ['十四月', 426],
    ['二十六月', 790],
    ['九月', 270],
    ['七月', 210],
    ['四个月', 122],
    ['六个月', 183],
    ['三个月', 91],
    ['一个月', 30],
    ['一年', 365],
  ];
  for (const [keyword, days] of terms) {
    if (source.includes(keyword)) return days;
  }
  if (/日开|日日|天天|每日开放/.test(source)) return 0;
  return null;
}

function performanceMap(product) {
  const map = {};
  for (const item of product?.pastPerf?.tqilstw4z3 || []) {
    const value = numberOrNull(item.zyeaYld);
    if (item.zprfTyp && value !== null) map[item.zprfTyp] = value;
  }
  return map;
}

function toProduct(raw) {
  const perf = performanceMap(raw);
  const start = parseDate(raw.zrunDat);
  const end = parseDate(raw.zprfDat);
  const historyDays = daysBetween(start, end);
  const feeParts = [raw.zchrCst, raw.chrmn2, raw.chrsal].map(numberOrNull);
  return {
    name: text(raw.name),
    short_name: text(raw.shortName),
    code: text(raw.code),
    issuer: text(raw.orgName),
    risk_level: text(raw.risk),
    currency_code: text(raw.ccynbr),
    pub_prv: text(raw.pubPrv),
    soc_tag: text(raw.socTag),
    product_type: text(raw.subType),
    term_days: parseTerm(`${raw.shortName || ''} ${raw.name || ''}`),
    score: null,
    min_amount: numberOrNull(raw.buynfq),
    annualized_yield: perf.D ?? null,
    benchmark: text(raw.zbasPrf),
    return_1m: perf.A ?? null,
    return_3m: perf.B ?? null,
    return_6m: perf.C ?? null,
    return_1y: perf.D ?? null,
    return_since_inception: perf.F ?? null,
    status: text(raw.statusText) === '1' ? '开放中' : '未开放',
    source: '招行理财产品统一查询平台-公开接口-全量',
    data_date: end,
    history_months: historyDays === null ? null : Number((historyDays / 30.44).toFixed(1)),
    fee_bps:
      feeParts.some((part) => part === null)
        ? null
        : Number((feeParts.reduce((sum, part) => sum + part, 0) * 100).toFixed(0)),
    next_open_date: parseDate(raw.begdat),
    notes: '',
    capacity: null,
  };
}

function csvEscape(value) {
  const source = text(value);
  return /[",\n\r]/.test(source) ? `"${source.replaceAll('"', '""')}"` : source;
}

function toRow(product) {
  return {
    name: product.name,
    short_name: product.short_name,
    code: product.code,
    issuer: product.issuer,
    risk_level: product.risk_level,
    currency_code: product.currency_code,
    pub_prv: product.pub_prv,
    soc_tag: product.soc_tag,
    product_type: product.product_type,
    term_days: product.term_days ?? '',
    min_amount: product.min_amount ?? '',
    annualized_yield: product.annualized_yield ?? '',
    benchmark: product.benchmark,
    return_1m_annualized: product.return_1m ?? '',
    return_3m_annualized: product.return_3m ?? '',
    return_6m_annualized: product.return_6m ?? '',
    return_1y_annualized: product.return_1y ?? '',
    return_since_inception_annualized: product.return_since_inception ?? '',
    status: product.status,
    source: product.source,
    data_date: product.data_date,
    history_months: product.history_months ?? '',
    fee_bps: product.fee_bps ?? '',
    next_open_date: product.next_open_date,
  };
}

function writeCsv(filePath, products) {
  const lines = [HEADERS.join(',')];
  for (const product of products) {
    const row = toRow(product);
    lines.push(HEADERS.map((header) => csvEscape(row[header])).join(','));
  }
  fs.writeFileSync(filePath, `\uFEFF${lines.join('\n')}\n`, 'utf8');
}

function todayShanghai() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function main() {
  const browser = await openPublicBrowser();
  try {
    const client = await createProductListClient(browser.context);
    const queryAll = async (status) => (await queryProducts(client, status)).rows;

    const rawProducts = await queryAll('1');
    let rawUnopened = [];
    let unopenedError = null;
    try {
      rawUnopened = await queryAll('2');
    } catch (error) {
      unopenedError =
        error instanceof Error ? error.message : String(error);
    }

    const products = rawProducts.map(toProduct).filter((product) => product.code);
    const unopenedProducts = rawUnopened
      .map(toProduct)
      .filter((product) => product.code);
    const universe = products.filter(isProductPoolEligible);
    const view = buildProductView(universe);
    const today = todayShanghai();
    const allPath = path.join(DATA_DIR, `cmb_r2_all-${today}.csv`);
    const universePath = path.join(DATA_DIR, `cmb_r2_universe-${today}.csv`);
    const selectedPath = path.join(DATA_DIR, `cmb_r2_selected-${today}.csv`);
    const snapshotPath = path.join(DATA_DIR, `cmb_r2_snapshot-${today}.csv`);
    const snapshotProducts = [
      ...new Map(
        [...products, ...unopenedProducts].map((product) => [
          product.code,
          product,
        ]),
      ).values(),
    ];
    writeCsv(allPath, products);
    writeCsv(universePath, universe);
    writeCsv(selectedPath, view.observation_list);
    writeCsv(snapshotPath, snapshotProducts);
    let observation;
    try {
      observation = captureObservationFromFile({
        root: ROOT,
        inputPath: universePath,
      });
    } catch (error) {
      observation = {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    let refresh = null;
    try {
      const response = await fetch('http://127.0.0.1:8765/api/products/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      refresh = { status: response.status, body: (await response.text()).slice(0, 240) };
    } catch (error) {
      refresh = { error: error instanceof Error ? error.message : String(error) };
    }

    console.log(
      JSON.stringify(
        {
          today,
          total: products.length,
          unopened: unopenedProducts.length,
          snapshot_total: snapshotProducts.length,
          unopened_error: unopenedError,
          universe: universe.length,
          selected: view.observation_list.length,
          bucket_counts: view.stats.bucket_counts,
          selected_codes: view.observation_list.map((product) => product.code),
          files: {
            allPath,
            universePath,
            selectedPath,
            snapshotPath,
          },
          observation: observation
            ? {
                status: observation.status,
                data_date: observation.data_date || null,
                message: observation.message || '',
                sample_count: observation.review?.sample_count ?? null,
                remaining_samples:
                  observation.review?.remaining_samples ?? null,
                remaining_preferred_samples:
                  observation.review?.remaining_preferred_samples ?? null,
                preferred_samples_reached:
                  observation.review?.preferred_samples_reached ?? null,
                review_status:
                  observation.review?.review_status ??
                  observation.review?.status ??
                  null,
                ledger_issues: observation.review?.ledger_issues || [],
                review_triggers:
                  observation.review?.triggers?.map((item) => ({
                    severity: item.severity,
                    key: item.key,
                    summary: item.summary,
                  })) || [],
              }
            : null,
          refresh,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
