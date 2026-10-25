#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadProductsFromCsv } = require('../lib/products');
const { buildYieldShadowReport } = require('../lib/yield-shadow');
const {
  DIAGNOSTIC_THRESHOLDS,
  buildShadowBacktestReport,
} = require('../lib/yield-shadow-analysis');

const root = path.resolve(__dirname, '..');

function usage() {
  return [
    '用法：node scripts/yield-shadow-backtest.cjs [选项]',
    '',
    '选项：',
    '  --files <a.csv,b.csv> 指定至少两个产品 CSV，默认读取 data 下全部 universe',
    '  --out-dir <dir>       输出目录，默认 docs/analysis',
    '  --generated-at <time> 固定生成时间',
    '  --no-api              不读取生产 Dashboard 做跨模块投影',
    '  --dry-run             只输出摘要，不写文件',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    files: null,
    outDir: path.join(root, 'docs', 'analysis'),
    generatedAt: null,
    noApi: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--files') {
      options.files = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--files=')) {
      options.files = arg.slice('--files='.length);
    } else if (arg === '--out-dir') {
      options.outDir = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--out-dir=')) {
      options.outDir = arg.slice('--out-dir='.length);
    } else if (arg === '--generated-at') {
      options.generatedAt = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--generated-at=')) {
      options.generatedAt = arg.slice('--generated-at='.length);
    } else if (arg === '--no-api') {
      options.noApi = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg !== '--help') {
      throw new Error(`未知参数：${arg}\n${usage()}`);
    }
  }
  return options;
}

function resolveInputFiles(requested) {
  if (requested) {
    return requested
      .split(',')
      .map((item) => path.resolve(item.trim()))
      .filter(Boolean);
  }
  return fs
    .readdirSync(path.join(root, 'data'))
    .filter((name) => /^cmb_r2_universe.*\.csv$/i.test(name))
    .sort()
    .map((name) => path.join(root, 'data', name));
}

function relativeDisplayPath(filePath) {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith('..')
    ? relative.replaceAll('\\', '/')
    : path.basename(filePath);
}

function csvCell(value) {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replaceAll('"', '""')}"`;
}

function formatNumber(value, digits = 4) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function renderAnomalyCsv(report) {
  const columns = [
    ['severity', (item) => item.severity],
    ['kind', (item) => item.kind],
    ['snapshot', (item) => item.snapshot || ''],
    ['bucket', (item) => item.bucket || ''],
    ['code', (item) => item.code || ''],
    ['summary', (item) => item.summary],
    ['attribution', (item) => item.attribution || ''],
  ];
  const lines = [
    columns.map(([name]) => csvCell(name)).join(','),
    ...report.anomalies.items.map((item) =>
      columns.map(([, getter]) => csvCell(getter(item))).join(','),
    ),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function renderMarkdown(report, files) {
  const severityRank = { high: 0, medium: 1, info: 2 };
  const prioritized = [...report.anomalies.items].sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      a.kind.localeCompare(b.kind) ||
      (a.snapshot || '').localeCompare(b.snapshot || '') ||
      (a.bucket || '').localeCompare(b.bucket || '') ||
      (a.code || '').localeCompare(b.code || ''),
  );
  const lines = [
    '# TD-YIELD-001 阶段 3 影子回测与异常归因',
    '',
    `> 生成时间：${report.generated_at}`,
    `> 分析版本：${report.analysis_version}`,
    `> 总体状态：${report.overall_status}`,
    '',
    '本报告只审查影子计算结果，不选择 A/B/C 最终方案，不修改正式评分、预算、提案或数据库。',
    '',
    '## 诊断阈值',
    '',
    `- 评分异常：高于同桶 Q3 + ${DIAGNOSTIC_THRESHOLDS.score_outlier_iqr_multiplier} × IQR。`,
    `- 大额评分变化：任一方案相对旧口径至少 ${DIAGNOSTIC_THRESHOLDS.large_score_shift_points} 个评分点。`,
    `- 高分集中：前 5% 候选贡献超过 ${DIAGNOSTIC_THRESHOLDS.high_top5_excess_share * 100}% 的中位数以上正超额。`,
    `- 边界样本：每侧至少 ${DIAGNOSTIC_THRESHOLDS.boundary_min_sample_per_side} 个排名候选，才做经验分布判断。`,
    `- 跨快照参考年化变化：达到 ${DIAGNOSTIC_THRESHOLDS.cross_snapshot_reference_materiality_pp}pp 记为实质变化。`,
    '',
    '## 快照',
    '',
    '| 文件 | 产品数据日 | 产品数 | 旧观察可评分 | 新排名候选 | 参考不可用 |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
  ];
  for (const item of report.snapshots) {
    lines.push(
      `| \`${item.source?.file_name}\` | ${item.snapshot_date} | ` +
        `${item.counts.products} | ${item.counts.old_observation_ready} | ` +
        `${item.counts.new_ranking_candidates} | ` +
        `${item.missing_windows.status_counts.unavailable} |`,
    );
  }
  lines.push(
    '',
    '## 完整性检查',
    '',
    '| 快照 | 内部不变量 | 权重别名差异 | 缺窗数值违规 | 权重和差异 | cash 泄漏 | 排名不连续 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const item of report.snapshots) {
    const invariant = item.invariants;
    lines.push(
      `| ${item.label} | ${invariant.passed ? '通过' : '失败'} | ` +
        `${invariant.counts.weighted_alias_mismatch} | ` +
        `${invariant.counts.available_without_numeric_value + invariant.counts.unavailable_with_numeric_value} | ` +
        `${invariant.counts.normalized_weight_sum_mismatch} | ` +
        `${invariant.counts.cash_score_leak + invariant.counts.cash_ranking_leak} | ` +
        `${invariant.counts.rank_sequence_mismatch} |`,
    );
  }
  lines.push(
    '',
    '## 分数分布与排名',
    '',
    '| 快照 | 桶 | 旧中位 | A 中位 | B 中位 | C 中位 | A Spearman | 前5%超额占比 | 异常值 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const snapshot of report.snapshots) {
    for (const bucket of ['short', 'medium', 'long']) {
      const scores = snapshot.buckets[bucket].scores;
      lines.push(
        `| ${snapshot.label} | ${bucket} | ` +
          `${formatNumber(scores.distributions.old.median)} | ` +
          `${formatNumber(scores.distributions.A.median)} | ` +
          `${formatNumber(scores.distributions.B.median)} | ` +
          `${formatNumber(scores.distributions.C.median)} | ` +
          `${formatNumber(scores.spearman_vs_old.A, 3)} | ` +
          `${formatNumber(scores.top5_excess_share * 100, 1)}% | ` +
          `${scores.outliers.length} |`,
      );
    }
  }
  lines.push('', '## 快照间变化', '');
  for (const transition of report.transitions) {
    lines.push(
      `- ${transition.from} → ${transition.to}：共同产品 ${transition.common_codes}，` +
        `新增 ${transition.added_codes}，移除 ${transition.removed_codes}，` +
        `新增排名候选 ${transition.added_ranking_candidates}；共同产品参考年化最大变化 ` +
        `${formatNumber(transition.common_reference_max_abs_delta)}pp。` +
        `归因：${transition.interpretation}。`,
    );
  }
  lines.push('', '## 边界与缺窗', '');
  for (const snapshot of report.snapshots) {
    const boundary = snapshot.boundary;
    lines.push(
      `- ${snapshot.label}：30 天候选 ${boundary.exact_term_counts['30'].ranking_candidates}，` +
        `31 天 ${boundary.exact_term_counts['31'].ranking_candidates}；` +
        `100 天 ${boundary.exact_term_counts['100'].ranking_candidates}，` +
        `101 天 ${boundary.exact_term_counts['101'].ranking_candidates}；` +
        `期限桶变化 ${boundary.bucket_transition_count}。`,
    );
    const candidatePatterns = Object.entries(
      snapshot.missing_windows.candidate_patterns,
    );
    const partial = candidatePatterns
      .filter(([key]) => key.includes('|partial_history|'))
      .reduce((sum, [, count]) => sum + count, 0);
    lines.push(
      `- ${snapshot.label}：排名候选中部分历史 ${partial} 个；` +
        `参考不可用 ${snapshot.missing_windows.status_counts.unavailable} 个。`,
    );
  }
  if (report.production_projection?.status === 'projection_only_not_integrated') {
    const production = report.production_projection;
    lines.push('', '## 跨模块投影', '');
    lines.push(
      `- 当前持仓参考年化变化：${production.current_yield_changed_count}/${production.current_holdings.length}。`,
      `- 当前候选参考年化变化：${production.candidate_yield_changed_count}/${production.candidate_count}。`,
      `- 候选结论变化：${production.verdict_changed_count}。`,
      `- 正式收益归因：${production.formal_attribution?.status || '未获取到'}，` +
        `参考年化覆盖 ${formatNumber(production.formal_attribution?.reference_yield_coverage_pct, 2)}%。`,
      `- 正式提案：待采纳 ${production.formal_proposals?.pending_count ?? '未获取到'}，` +
        `已采纳 ${production.formal_proposals?.accepted_count ?? '未获取到'}，` +
        `已执行 ${production.formal_proposals?.executed_count ?? '未获取到'}。`,
      '- 结论：正式持仓复核尚未接入影子口径；这是阶段 5 前的预期差异，不能把影子结论直接用于交易。',
    );
    if (production.verdict_changes.length) {
      lines.push('', '| 持仓 | 候选 | 旧结论 | 影子投影 | 旧差 | 新差 |', '| --- | --- | --- | --- | ---: | ---: |');
      for (const change of production.verdict_changes) {
        lines.push(
          `| ${change.holding_code} | ${change.candidate_code} | ${change.old_verdict} | ` +
            `${change.shadow_verdict} | ${formatNumber(change.old_yield_gap_pp, 2)}pp | ` +
            `${formatNumber(change.shadow_yield_gap_pp, 2)}pp |`,
        );
      }
    }
  }
  lines.push('', '## 异常登记', '');
  lines.push(
    `- 高：${report.anomalies.counts_by_severity.high}`,
    `- 中：${report.anomalies.counts_by_severity.medium}`,
    `- 信息：${report.anomalies.counts_by_severity.info}`,
    '',
  );
  for (const item of prioritized.slice(0, 30)) {
    lines.push(
      `- [${item.severity}] ${item.summary}`,
      `  - 归因：${item.attribution || '见 JSON 明细。'}`,
    );
  }
  if (prioritized.length > 30) {
    lines.push(`- 其余 ${prioritized.length - 30} 项见完整 JSON/CSV 异常登记。`);
  }
  lines.push(
    '',
    '## 输出文件',
    '',
    `- \`${files.json}\``,
    `- \`${files.markdown}\``,
    `- \`${files.csv}\``,
    '',
    report.conclusion,
    '',
  );
  return lines.join('\n');
}

async function fetchProductionDashboard() {
  const response = await fetch(
    process.env.R2_DASHBOARD_URL ||
      'http://127.0.0.1:8765/api/dashboard',
    { signal: AbortSignal.timeout(3000) },
  );
  if (!response.ok) {
    throw new Error(`Dashboard 返回 HTTP ${response.status}`);
  }
  return response.json();
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (process.argv.includes('--help')) {
    console.log(usage());
    return;
  }
  const inputFiles = resolveInputFiles(options.files);
  if (inputFiles.length < 2) {
    throw new Error('至少需要两个产品快照');
  }
  const generatedAt = options.generatedAt || new Date().toISOString();
  const snapshots = inputFiles.map((filePath) => {
    const buffer = fs.readFileSync(filePath);
    const products = loadProductsFromCsv(filePath);
    const report = buildYieldShadowReport({
      products,
      generatedAt,
      source: {
        kind: 'product_csv',
        path: relativeDisplayPath(filePath),
        file_name: path.basename(filePath),
        file_date:
          /(\d{4}-\d{2}-\d{2})/.exec(path.basename(filePath))?.[1] || null,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        row_count: products.length,
      },
    });
    return {
      label: path.basename(filePath),
      report,
    };
  });
  let productionDashboard = null;
  if (!options.noApi) {
    try {
      productionDashboard = await fetchProductionDashboard();
    } catch (error) {
      console.error(`跨模块投影跳过：${error.message}`);
    }
  }
  const analysis = buildShadowBacktestReport({
    snapshots,
    productionDashboard,
    generatedAt,
  });
  const stamp = generatedAt.slice(0, 10);
  const stem = `td-yield-001-backtest-${stamp}`;
  const outDir = path.resolve(options.outDir);
  const jsonPath = path.join(outDir, `${stem}.json`);
  const markdownPath = path.join(outDir, `${stem}.md`);
  const csvPath = path.join(outDir, `${stem}-anomalies.csv`);
  const files = {
    json: relativeDisplayPath(jsonPath),
    markdown: relativeDisplayPath(markdownPath),
    csv: relativeDisplayPath(csvPath),
  };
  if (!options.dryRun) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(jsonPath, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
    fs.writeFileSync(markdownPath, renderMarkdown(analysis, files), 'utf8');
    fs.writeFileSync(csvPath, renderAnomalyCsv(analysis), 'utf8');
  }
  console.log(
    JSON.stringify(
      {
        mode: options.dryRun ? 'dry-run' : 'written',
        generated_at: generatedAt,
        snapshots: analysis.snapshots.map((item) => ({
          file: item.source?.file_name,
          data_date: item.snapshot_date,
          products: item.counts.products,
          invariants_passed: item.invariants.passed,
        })),
        transitions: analysis.transitions,
        production_projection: {
          status: analysis.production_projection.status,
          current_yield_changed_count:
            analysis.production_projection.current_yield_changed_count ?? null,
          candidate_yield_changed_count:
            analysis.production_projection.candidate_yield_changed_count ?? null,
          verdict_changed_count:
            analysis.production_projection.verdict_changed_count ?? null,
        },
        anomalies: {
          overall_status: analysis.overall_status,
          counts_by_severity: analysis.anomalies.counts_by_severity,
          counts_by_kind: analysis.anomalies.counts_by_kind,
        },
        write_policy: analysis.write_policy,
        files,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
