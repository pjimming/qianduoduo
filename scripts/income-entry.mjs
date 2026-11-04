#!/usr/bin/env node
/**
 * 收益截图入账一键脚本（纯 HTTP，无第三方依赖）。
 *
 * 把「上传截图 → 按产品/收益日入账 → 打印验收单」收敛成一次调用，
 * 默认只做预检（dry-run），加 --apply 才写库。
 *
 * 用法：
 *   node scripts/income-entry.mjs --template > spec.json   # 打印规格骨架
 *   node scripts/income-entry.mjs run/income.json
 *   node scripts/income-entry.mjs run/income.json --apply
 *   node scripts/income-entry.mjs run/income.json --base http://127.0.0.1:8765
 *
 * 预检包含两部分：与库中同 (product_code, yield_date) 值比对（差 >0.005 视为冲突，
 * 整张截图不写），以及与当前持仓对照的覆盖检查（按 T+N 标注未到期/已到期缺口）。
 *
 * 规格文件：
 * {
 *   "screenshots": [
 *     {
 *       "path": "C:/Users/Administrator/.dsh/attachments/v1/objects/xx/yy",  // 可选；已有 inbox_id 时可省略
 *       "filename": "2026-11-02至11-03-多宝收益明细.jpg",
 *       "inbox_id": 30,                       // 可选：对已上传的截图直接 apply
 *       "date": "2026-11-03",                 // 截图/账户日期（收益归属日按产品 yield_date）
 *       "notes": "收益截图核对",
 *       "products": [
 *         { "product_code": "JX040210", "yield_date": "2026-11-02",
 *           "daily_pnl": 1.8003, "credit_date": "2026-11-03",
 *           "holding_amount": 17800 }        // holding_amount/credit_date 可省略
 *       ]
 *     }
 *   ]
 * }
 *
 * 规则（与 lib/db.js applyIncomeScreenshot 一致）：
 * - 每个产品可带自己的 yield_date；缺省取截图 date。
 * - 同一 (product_code, yield_date) 已有值与新值差 > 0.005 视为冲突，整张截图不写入。
 * - 一张截图只能 apply 一次；多日期必须在同一次 products 中提交。
 * - 0 元必须有页面明确显示；页面不显示 0 时不要自行补 0。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_BASE = process.env.INCOME_BASE || 'http://127.0.0.1:8765';
const TOLERANCE = 0.005;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[A-Z0-9-]{4,32}$/;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const TEMPLATE = {
  screenshots: [
    {
      path: '<截图绝对路径，或改用 inbox_id>',
      filename: '<文件名>',
      date: 'YYYY-MM-DD',
      notes: '收益截图入账',
      confidence: 95,
      products: [
        {
          product_code: '<产品代码>',
          yield_date: 'YYYY-MM-DD',
          daily_pnl: 0,
          credit_date: 'YYYY-MM-DD',
          holding_amount: 0,
        },
      ],
    },
  ],
};

function parseArgs(argv) {
  const options = { spec: '', base: DEFAULT_BASE, apply: false, template: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--template') options.template = true;
    else if (arg === '--base') options.base = argv[++i] || DEFAULT_BASE;
    else if (arg.startsWith('--')) fail(`未知参数 ${arg}`);
    else if (!options.spec) options.spec = arg;
  }
  return options;
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function request(base, endpoint, init = {}) {
  const response = await fetch(`${base}${endpoint}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

function jsonBody(payload) {
  return {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function validateSpec(spec) {
  if (!spec || !Array.isArray(spec.screenshots) || spec.screenshots.length === 0) {
    fail('规格文件需要 screenshots 数组');
  }
  spec.screenshots.forEach((shot, index) => {
    const label = `screenshots[${index}]`;
    if (!shot.date || !DATE_RE.test(shot.date)) fail(`${label}.date 需要 YYYY-MM-DD`);
    if (!Array.isArray(shot.products) || shot.products.length === 0) {
      fail(`${label}.products 不能为空`);
    }
    if (!shot.inbox_id && !shot.path) fail(`${label} 需要 path 或 inbox_id`);
    if (shot.path && !fs.existsSync(shot.path)) fail(`${label}.path 不存在：${shot.path}`);
    shot.products.forEach((product, pIndex) => {
      const pLabel = `${label}.products[${pIndex}]`;
      const code = String(product.product_code || '').toUpperCase();
      if (!CODE_RE.test(code)) fail(`${pLabel}.product_code 不合法：${product.product_code}`);
      const pnl = Number(product.daily_pnl);
      if (!Number.isFinite(pnl)) fail(`${pLabel}.daily_pnl 需要数字`);
      if (product.yield_date && !DATE_RE.test(product.yield_date)) {
        fail(`${pLabel}.yield_date 需要 YYYY-MM-DD`);
      }
      if (product.credit_date && !DATE_RE.test(product.credit_date)) {
        fail(`${pLabel}.credit_date 需要 YYYY-MM-DD`);
      }
      if (product.holding_amount != null && Number(product.holding_amount) < 0) {
        fail(`${pLabel}.holding_amount 不能为负`);
      }
      product.product_code = code;
      product.daily_pnl = pnl;
      product.yield_date = product.yield_date || shot.date;
    });
  });
}

function loadExisting(valuations) {
  const map = new Map();
  for (const row of valuations || []) {
    const key = `${String(row.product_code).toUpperCase()}|${row.yield_date}`;
    map.set(key, row);
  }
  return map;
}

function preflight(shot, existing) {
  const results = [];
  for (const product of shot.products) {
    const key = `${product.product_code}|${product.yield_date}`;
    const current = existing.get(key);
    if (!current) {
      results.push({ product, status: 'new' });
      continue;
    }
    const diff = Math.abs(Number(current.daily_pnl) - product.daily_pnl);
    results.push({
      product,
      status: diff > TOLERANCE ? 'conflict' : 'unchanged',
      current: Number(current.daily_pnl),
      diff,
    });
  }
  return results;
}

function formatCheck(check) {
  const { product, status } = check;
  const base = `${product.yield_date}  ${product.product_code.padEnd(9)}  ${round2(product.daily_pnl).toFixed(2)}`;
  if (status === 'new') return `  + ${base}  新增`;
  if (status === 'unchanged') {
    return `  = ${base}  已在库 ${check.current.toFixed(2)}（差 ${check.diff.toFixed(4)}，幂等）`;
  }
  return `  ! ${base}  冲突：库中 ${check.current.toFixed(2)}（差 ${check.diff.toFixed(4)}）`;
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function todayLocal() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

// 覆盖检查：把「今日持仓」与「本次截图覆盖的产品」对照，提示可能漏行。
// T+N 未到披露日的产品不算缺口，只标注应披露日期。
function buildCoverage(spec, holdingsJson, settingsJson) {
  const current = holdingsJson?.current || holdingsJson || {};
  const held = (current.components || []).filter((item) => Number(item.principal) > 0);
  if (!held.length) return null;
  const lagByCode = new Map(
    (settingsJson?.settings || []).map((item) => [item.product_code, item.yield_lag_days]),
  );
  const dates = [
    ...new Set(spec.screenshots.flatMap((shot) => shot.products.map((item) => item.yield_date))),
  ].sort();
  const target = dates[dates.length - 1];
  const covered = new Set(
    spec.screenshots.flatMap((shot) =>
      shot.products.filter((item) => item.yield_date === target).map((item) => item.product_code),
    ),
  );
  const today = todayLocal();
  const missing = held
    .filter((item) => !covered.has(item.product_code))
    .map((item) => {
      const lag = Number(lagByCode.get(item.product_code) ?? 1);
      const dueDate = addDays(target, lag);
      return { code: item.product_code, lag, dueDate, due: dueDate <= today };
    });
  const coveredHeld = held.filter((item) => covered.has(item.product_code)).length;
  return { target, heldCount: held.length, coveredCount: coveredHeld, missing };
}

function printCoverage(coverage) {
  if (!coverage) return false;
  console.log(`\n覆盖检查（${coverage.target}）：持仓 ${coverage.heldCount} 只，本次覆盖 ${coverage.coveredCount} 只`);
  if (!coverage.missing.length) {
    console.log('  全部持仓已覆盖');
    return false;
  }
  let overdue = false;
  for (const item of coverage.missing) {
    const lagText = `T+${item.lag}`;
    if (item.due) {
      overdue = true;
      console.log(`  ⚠ ${item.code}  ${lagText}  应披露 ${item.dueDate}（已到期，本次无行）`);
    } else {
      console.log(`  - ${item.code}  ${lagText}  应披露 ${item.dueDate}（未到期，页面可能还没有）`);
    }
  }
  return overdue;
}

function summarizeApply(result) {
  const saved = result.saved_valuations || [];
  const conflicts = result.valuation_conflicts || [];
  const missing = result.missing_product_codes || [];
  const record = result.record || null;
  const reconciliation = result.reconciliation || null;
  const lines = [];
  lines.push(`  写入 ${saved.length} 条${conflicts.length ? `，冲突 ${conflicts.length} 条` : ''}`);
  if (missing.length) lines.push(`  待披露/未覆盖：${missing.join('、')}`);
  if (record) {
    lines.push(
      `  ${record.record_date} 账户：本金 ${Number(record.principal).toFixed(2)}，收益 ${Number(record.daily_pnl).toFixed(2)}`,
    );
  }
  if (reconciliation) {
    const status = reconciliation.status || 'unknown';
    const final = reconciliation.final_date || reconciliation.final_yield_date || '';
    lines.push(`  对账：${status}${final ? `，最终披露 ${final}` : ''}`);
  }
  return lines;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.template) {
    console.log(JSON.stringify(TEMPLATE, null, 2));
    return;
  }
  if (!options.spec) {
    fail('用法：node scripts/income-entry.mjs <spec.json> [--apply] [--base URL]');
  }
  const spec = JSON.parse(fs.readFileSync(options.spec, 'utf8'));
  validateSpec(spec);

  const [valuationsResponse, holdingsResponse, settingsResponse] = await Promise.all([
    request(options.base, '/api/product-valuations'),
    request(options.base, '/api/holding-valuations'),
    request(options.base, '/api/product-yield-settings'),
  ]);
  if (valuationsResponse.status !== 200) {
    fail(`读取产品估值失败：HTTP ${valuationsResponse.status}`);
  }
  const existing = loadExisting(valuationsResponse.json?.valuations);
  const coverage = buildCoverage(
    spec,
    holdingsResponse.status === 200 ? holdingsResponse.json : null,
    settingsResponse.status === 200 ? settingsResponse.json : null,
  );

  console.log(
    `预检：${spec.screenshots.length} 张截图，${options.apply ? '写库模式' : 'dry-run（加 --apply 才会写）'}`,
  );

  let hasConflict = false;
  const checks = spec.screenshots.map((shot) => preflight(shot, existing));
  spec.screenshots.forEach((shot, index) => {
    console.log(`\n[${index + 1}] ${shot.filename || shot.path || `inbox#${shot.inbox_id}`}  日期 ${shot.date}`);
    for (const check of checks[index]) {
      console.log(formatCheck(check));
      if (check.status === 'conflict') hasConflict = true;
    }
  });

  const overdueCoverage = printCoverage(coverage);

  if (hasConflict) {
    console.error('\n✗ 存在冲突，未写入。请先核对数值或已入账记录。');
    process.exit(1);
  }
  if (!options.apply) {
    console.log('\n预检通过。确认无误后加 --apply 执行。');
    return;
  }

  for (let index = 0; index < spec.screenshots.length; index += 1) {
    const shot = spec.screenshots[index];
    let inboxId = shot.inbox_id;

    if (inboxId) console.log(`\n[${index + 1}] 复用 inbox #${inboxId}`);

    if (!inboxId) {
      const buffer = fs.readFileSync(shot.path);
      const upload = await request(
        options.base,
        '/api/income/inbox',
        {
          method: 'POST',
          ...jsonBody({
            data: buffer.toString('base64'),
            mime: shot.mime || mimeFor(shot.path),
            filename: shot.filename || path.basename(shot.path),
          }),
        },
      );
      if (upload.status !== 200 && upload.status !== 201) {
        fail(`上传失败：HTTP ${upload.status} ${JSON.stringify(upload.json)}`);
      }
      inboxId = upload.json?.inbox?.id;
      console.log(`\n[${index + 1}] 上传 → inbox #${inboxId}${upload.json?.duplicate ? '（重复截图，复用原记录）' : ''}`);
      if (upload.json?.inbox?.status === 'applied') {
        console.log('  该截图此前已入账，跳过 apply。');
        continue;
      }
    }

    const apply = await request(
      options.base,
      `/api/income/inbox/${inboxId}/apply`,
      {
        method: 'POST',
        ...jsonBody({
          date: shot.date,
          notes: shot.notes || '收益截图入账',
          ...(shot.confidence != null ? { confidence: shot.confidence } : {}),
          products: shot.products.map((product) => ({
            product_code: product.product_code,
            daily_pnl: product.daily_pnl,
            yield_date: product.yield_date,
            ...(product.credit_date ? { credit_date: product.credit_date } : {}),
            ...(product.holding_amount != null ? { holding_amount: product.holding_amount } : {}),
          })),
        }),
      },
    );
    if (apply.status !== 200) {
      fail(`入账失败：HTTP ${apply.status} ${JSON.stringify(apply.json)}`);
    }
    if (apply.json?.duplicate) {
      console.log(`  inbox #${inboxId} 已入账过，跳过。`);
      continue;
    }
    console.log(`  inbox #${inboxId} apply 完成`);
    for (const line of summarizeApply(apply.json || {})) console.log(line);
  }

  if (overdueCoverage) {
    console.log('\n注意：仍有已到期产品没有当日行，对账会保留该缺口。');
  }

  const dashboard = await request(options.base, '/api/dashboard/summary');
  if (dashboard.status === 200 && dashboard.json) {
    const summary = dashboard.json.summary || dashboard.json;
    const annualized = Number(summary.annualized_pct || 0);
    console.log(
      `\n账户汇总：最新 ${summary.last_date || '?'} 收益 ${Number(
        summary.latest_daily_pnl || 0,
      ).toFixed(2)}，累计 ${Number(summary.total_pnl || 0).toFixed(2)}，本金 ${Number(
        summary.latest_principal || 0,
      ).toFixed(2)}，年化 ${annualized.toFixed(2)}%`,
    );
  }
}

main().catch((error) => fail(error.stack || error.message));
