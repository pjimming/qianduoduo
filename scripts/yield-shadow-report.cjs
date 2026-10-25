#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadProductsFromCsv } = require('../lib/products');
const { buildYieldShadowReport } = require('../lib/yield-shadow');
const {
  resolveProductCsv,
} = require('../server/modules/products/product-csv');

const root = path.resolve(__dirname, '..');

function usage() {
  return [
    '用法：node scripts/yield-shadow-report.cjs [选项]',
    '',
    '选项：',
    '  --input <csv>      指定产品 CSV，默认使用最新 cmb_r2_universe 文件',
    '  --out-dir <dir>    输出目录，默认 docs/analysis',
    '  --generated-at <t> 固定生成时间，便于复现测试',
    '  --dry-run          只输出摘要，不写文件',
    '  --help             显示帮助',
  ].join('\n');
}

function parseArgs(argv) {
  const result = {
    input: null,
    outDir: path.join(root, 'docs', 'analysis'),
    generatedAt: null,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') result.help = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--input') {
      result.input = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--input=')) {
      result.input = arg.slice('--input='.length);
    } else if (arg === '--out-dir') {
      result.outDir = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--out-dir=')) {
      result.outDir = arg.slice('--out-dir='.length);
    } else if (arg === '--generated-at') {
      result.generatedAt = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--generated-at=')) {
      result.generatedAt = arg.slice('--generated-at='.length);
    } else {
      throw new Error(`未知参数：${arg}\n${usage()}`);
    }
  }
  return result;
}

function relativeDisplayPath(filePath) {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith('..')
    ? relative.replaceAll('\\', '/')
    : path.basename(filePath);
}

function csvCell(value) {
  if (value === null || value === undefined) return '""';
  const text = Array.isArray(value)
    ? value.join('|')
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function renderCsv(report) {
  const columns = [
    ['code', (row) => row.code],
    ['name', (row) => row.name],
    ['issuer', (row) => row.issuer],
    ['term_days', (row) => row.term_days],
    ['old_bucket', (row) => row.old_bucket],
    ['new_bucket', (row) => row.new_bucket],
    ['bucket_changed', (row) => row.bucket_changed],
    ['evidence_tier', (row) => row.evidence_tier],
    ['return_1m', (row) => row.return_1m],
    ['return_3m', (row) => row.return_3m],
    ['return_6m', (row) => row.return_6m],
    ['return_1y', (row) => row.return_1y],
    ['old_reference_yield_pct', (row) => row.old_reference_yield_pct],
    ['new_reference_yield_pct', (row) => row.new_reference_yield_pct],
    ['reference_delta_pct', (row) => row.reference_delta_pct],
    ['new_reference_yield_status', (row) => row.new_reference_yield_status],
    ['new_reference_yield_reason', (row) => row.new_reference_yield_reason],
    ['new_available_horizons', (row) => row.new_available_horizons],
    ['new_missing_horizons', (row) => row.new_missing_horizons],
    ['new_normalized_weights', (row) => row.new_normalized_weights],
    ['old_observation_score', (row) => row.old_observation_score],
    ['new_observation_score', (row) => row.new_observation_score],
    ['old_selection_score', (row) => row.old_selection_score],
    ['selection_score_A', (row) => row.selection_score_A],
    ['selection_score_B', (row) => row.selection_score_B],
    ['selection_score_C', (row) => row.selection_score_C],
    ['selection_score_delta_A', (row) => row.selection_score_delta_A],
    ['selection_score_delta_B', (row) => row.selection_score_delta_B],
    ['selection_score_delta_C', (row) => row.selection_score_delta_C],
    ['divergence_penalty_points', (row) => row.divergence_penalty_points],
    ['frontload_penalty_A', (row) => row.frontload_penalty_A],
    ['frontload_penalty_B', (row) => row.frontload_penalty_B],
    ['frontload_penalty_C', (row) => row.frontload_penalty_C],
    ['history_bonus_points', (row) => row.history_bonus_points],
    ['old_ranking_candidate', (row) => row.old_ranking_candidate],
    ['new_ranking_candidate', (row) => row.new_ranking_candidate],
    ['scoring_candidate_changed', (row) => row.scoring_candidate_changed],
    ['old_rank', (row) => row.ranking.old.rank],
    ['rank_A', (row) => row.ranking.A.rank],
    ['rank_B', (row) => row.ranking.B.rank],
    ['rank_C', (row) => row.ranking.C.rank],
    ['old_top3', (row) => row.ranking.old.top3],
    ['top3_A', (row) => row.ranking.A.top3],
    ['top3_B', (row) => row.ranking.B.top3],
    ['top3_C', (row) => row.ranking.C.top3],
  ];
  const lines = [
    columns.map(([name]) => csvCell(name)).join(','),
    ...report.rows.map((row) =>
      columns.map(([, getter]) => csvCell(getter(row))).join(','),
    ),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function renderTopThree(rows) {
  if (!rows.length) return '—';
  return rows
    .map(
      (row) =>
        `${row.code}（${formatNumber(row.score, 4)}，` +
        `${formatNumber(row.reference_yield_pct, 4)}%）`,
    )
    .join('；');
}

function renderMarkdown(report, files) {
  const { summary } = report;
  const lines = [
    '# TD-YIELD-001 阶段 2 影子对照',
    '',
    `> 生成时间：${report.generated_at}`,
    `> 产品快照：${report.snapshot_date || '未获取到'}`,
    `> 输入文件：\`${report.source?.path || '未获取到'}\``,
    '',
    '本报告只读取产品快照并执行独立影子计算。未写入正式评分、预算、提案、数据库或 Dashboard。',
    '',
    '## 数据与候选集',
    '',
    `- 产品数：${summary.total_products}`,
    `- 旧观察可评分：${summary.old_observation_ready}`,
    `- 旧桶内排名候选：${summary.old_ranking_candidates}`,
    `- 新桶内排名候选：${summary.new_ranking_candidates}`,
    `- 候选集退出：${summary.candidate_changes.removed_count}`,
    `- 候选集进入：${summary.candidate_changes.entered_count}`,
    `- 期限桶变化：${summary.bucket_transition_count}`,
    `- 新参考年化可用：${summary.reference_status_counts.available}`,
    `- 新参考年化不可用：${summary.reference_status_counts.unavailable}`,
    '',
    '## 各桶评分中位数',
    '',
    '| 桶 | 产品数 | 参考年化中位数 | 旧选择评分 | A | B | C |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const bucket of ['short', 'medium', 'long']) {
    const item = summary.buckets[bucket];
    lines.push(
      `| ${bucket} | ${item.total} | ` +
        `${formatNumber(item.reference_distribution.median, 4)} | ` +
        `${formatNumber(item.score_distributions.old.median, 4)} | ` +
        `${formatNumber(item.score_distributions.A.median, 4)} | ` +
        `${formatNumber(item.score_distributions.B.median, 4)} | ` +
        `${formatNumber(item.score_distributions.C.median, 4)} |`,
    );
  }
  lines.push(
    '',
    '## 相对旧口径的变化',
    '',
    '| 方案 | 分数上升 | 分数下降 | 排名变化 | 改善 | 恶化 | 前三重合 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const scheme of ['A', 'B', 'C']) {
    const item = summary.schemes[scheme];
    lines.push(
      `| ${scheme} | ${item.score_delta_vs_old.positive} | ` +
        `${item.score_delta_vs_old.negative} | ${item.rank_changed} | ` +
        `${item.rank_improved} | ${item.rank_deteriorated} | ` +
        `${item.top3_overlap_with_old} |`,
    );
  }
  lines.push(
    '',
    '### A/B/C 方案间分数差',
    '',
    '| 对比 | 上升 | 下降 | 不变 | 最小 | 中位 | 最大 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const [name, item] of Object.entries(summary.scheme_pairwise)) {
    lines.push(
      `| ${name} | ${item.positive} | ${item.negative} | ` +
        `${item.unchanged} | ${formatNumber(item.min, 4)} | ` +
        `${formatNumber(item.median, 4)} | ${formatNumber(item.max, 4)} |`,
    );
  }
  lines.push('', '## 前三名', '');
  for (const bucket of ['short', 'medium', 'long']) {
    const item = summary.buckets[bucket].top3;
    lines.push(`### ${bucket}`, '');
    for (const scheme of ['old', 'A', 'B', 'C']) {
      lines.push(`- ${scheme}：${renderTopThree(item[scheme])}`);
    }
    lines.push('');
  }
  lines.push(
    '## 输出文件',
    '',
    `- \`${files.json}\``,
    `- \`${files.csv}\``,
    `- \`${files.markdown}\``,
    '',
    '阶段 2 只负责生成可比结果；方案审查、参数选择和正式切换属于后续阶段。',
    '',
  );
  return lines.join('\n');
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  const inputPath = path.resolve(
    options.input || resolveProductCsv(root),
  );
  if (!fs.existsSync(inputPath)) {
    throw new Error(`产品快照不存在：${inputPath}`);
  }
  const buffer = fs.readFileSync(inputPath);
  const products = loadProductsFromCsv(inputPath);
  if (!products.length) {
    throw new Error(`产品快照为空：${inputPath}`);
  }
  const sourceDate =
    products
      .map((product) => product.data_date)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
  const fileDate =
    /(\d{4}-\d{2}-\d{2})/.exec(path.basename(inputPath))?.[1] || null;
  const report = buildYieldShadowReport({
    products,
    generatedAt: options.generatedAt || new Date().toISOString(),
    source: {
      kind: 'product_csv',
      path: relativeDisplayPath(inputPath),
      file_name: path.basename(inputPath),
      file_date: fileDate,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      row_count: products.length,
    },
  });
  const stem = `td-yield-001-shadow-${report.snapshot_date || fileDate || 'undated'}`;
  const outDir = path.resolve(options.outDir);
  const jsonPath = path.join(outDir, `${stem}.json`);
  const csvPath = path.join(outDir, `${stem}.csv`);
  const markdownPath = path.join(outDir, `${stem}.md`);
  const files = {
    json: relativeDisplayPath(jsonPath),
    csv: relativeDisplayPath(csvPath),
    markdown: relativeDisplayPath(markdownPath),
  };
  if (!options.dryRun) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.writeFileSync(csvPath, renderCsv(report), 'utf8');
    fs.writeFileSync(
      markdownPath,
      renderMarkdown(report, files),
      'utf8',
    );
  }
  console.log(
    JSON.stringify(
      {
        mode: options.dryRun ? 'dry-run' : 'written',
        snapshot_date: report.snapshot_date,
        source: report.source,
        summary: {
          total_products: report.summary.total_products,
          old_observation_ready: report.summary.old_observation_ready,
          old_ranking_candidates: report.summary.old_ranking_candidates,
          new_ranking_candidates: report.summary.new_ranking_candidates,
          candidate_changes: report.summary.candidate_changes,
          bucket_transition_count: report.summary.bucket_transition_count,
          reference_status_counts: report.summary.reference_status_counts,
          schemes: report.summary.schemes,
          scheme_pairwise: report.summary.scheme_pairwise,
        },
        write_policy: report.write_policy,
        files,
      },
      null,
      2,
    ),
  );
}

main();
