#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadProductsFromCsv } = require('../lib/products');
const {
  SELECTED_LONG_SCHEME,
  SELECTED_SHORT_VARIANT,
  buildParameterReviewReport,
} = require('../lib/yield-parameter-review');
const {
  validateSpecAndCohort,
} = require('../lib/yield-observation');

const root = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const options = {
    files: null,
    outDir: path.join(root, 'docs', 'analysis'),
    generatedAt: null,
    noApi: false,
    dryRun: false,
    context: 'stage4',
    spec: null,
    cohort: null,
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
    } else if (arg === '--context') {
      options.context = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--context=')) {
      options.context = arg.slice('--context='.length);
    } else if (arg === '--spec') {
      options.spec = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--spec=')) {
      options.spec = arg.slice('--spec='.length);
    } else if (arg === '--cohort') {
      options.cohort = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--cohort=')) {
      options.cohort = arg.slice('--cohort='.length);
    } else if (arg === '--help') {
      console.log(
        '用法：node scripts/yield-parameter-review.cjs [--files a,b] [--context stage4|stage6] [--spec file] [--cohort file] [--out-dir dir] [--generated-at time] [--no-api] [--dry-run]',
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!['stage4', 'stage6'].includes(options.context)) {
    throw new Error(`不支持的复核上下文：${options.context}`);
  }
  if (options.context === 'stage6') {
    options.spec ||= path.join(
      root,
      'data',
      'yield-observations',
      'td-yield-002-observation-spec.json',
    );
    options.cohort ||= path.join(
      root,
      'data',
      'yield-observations',
      'td-yield-002-cohort-v1.json',
    );
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

function formatNumber(value, digits = 4) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function percent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
}

function csvCell(value) {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replaceAll('"', '""')}"`;
}

function renderSensitivityCsv(report) {
  const columns = [
    ['variant', (id) => id],
    ['return_1m', (_, item) => item.weights.return_1m],
    ['return_3m', (_, item) => item.weights.return_3m],
    ['return_6m', (_, item) => item.weights.return_6m],
    ['max_score', (_, item) => item.aggregate.max_score_across_snapshots],
    ['average_top5_excess_share', (_, item) => item.aggregate.average_top5_excess_share],
    ['average_spearman_vs_old', (_, item) => item.aggregate.average_spearman_vs_old],
    ['average_mean_absolute_score_delta', (_, item) => item.aggregate.average_mean_absolute_score_delta],
    ['top3_preserved_snapshot_count', (_, item) => item.aggregate.top3_preserved_snapshot_count],
  ];
  const lines = [
    columns.map(([name]) => csvCell(name)).join(','),
    ...Object.entries(report.short_weight_options).map(([id, item]) =>
      columns.map(([, getter]) => csvCell(getter(id, item))).join(','),
    ),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function renderMarkdown(report, files) {
  const isStage6 = report.review_context.id === 'stage6';
  const snapshotCount = report.review_context.snapshot_count;
  const original =
    report.short_weight_options.original_50_30_20;
  const selected =
    report.short_weight_options[SELECTED_SHORT_VARIANT];
  const b = report.long_frontload_options.B;
  const projection = report.production_projection.selected;
  const originalProjection = report.production_projection.original_candidate;
  const lines = [
    isStage6
      ? '# TD-YIELD-002 阶段 6 样本外参数复核'
      : '# TD-YIELD-001 阶段 4 参数审核与决策',
    '',
    `> 生成时间：${report.generated_at}`,
    `> 审查版本：${report.review_version}`,
    `> 快照数：${snapshotCount}`,
    ...(isStage6
      ? [
          `> 观察规格：${report.review_context.cohort.observation_version} · 冻结于 ${report.review_context.cohort.spec_frozen_at} · ${report.review_context.cohort.spec_sha256}`,
          `> 固定 cohort：${report.review_context.cohort.cohort_version} · ${report.review_context.cohort.code_count} 只 · ${report.review_context.cohort.code_hash}`,
        ]
      : []),
    '',
    `结论：基于 ${snapshotCount} 份快照复核 short 权重与 long 前视扣分；正式路径尚未修改。`,
    '',
    isStage6 ? '## 当前正式参数（待样本外复核）' : '## 最终选定参数',
    '',
    '| 桶 | 1M | 3M | 6M | 1Y | 用途 |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    '| cash | 70% | 30% | — | — | 仅展示 |',
    '| short | 20% | 50% | 30% | — | 排序及评分 |',
    '| medium | — | 50% | 30% | 20% | 排序及评分 |',
    '| long | — | 20% | 40% | 40% | 排序及评分 |',
    '',
    '- long 前视扣分：`gap = 1Y − 6M > 1.5pp` 时，扣 `min(0.25, (gap−1.5) × 0.15)`。',
    '- short、medium 前视扣分仍为 `gap > 1.0pp` 时，扣 `min(0.25, (gap−1.0) × 0.15)`。',
    '- `1M/3M` 发散扣分、历史加成、cash 排除和 `weighted_yield_pct` 别名规则不变。',
    '',
    '## short 权重敏感性',
    '',
    '| 方案 | 1M/3M/6M | 最高分 | 平均前5%超额 | A 平均Spearman | 平均绝对分差 | 前三保持快照数 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const [id, item] of Object.entries(report.short_weight_options)) {
    lines.push(
      `| ${id} | ${percent(item.weights.return_1m)} / ` +
        `${percent(item.weights.return_3m)} / ${percent(item.weights.return_6m)} | ` +
        `${formatNumber(item.aggregate.max_score_across_snapshots)} | ` +
        `${percent(item.aggregate.average_top5_excess_share)} | ` +
        `${formatNumber(item.aggregate.average_spearman_vs_old, 3)} | ` +
        `${formatNumber(item.aggregate.average_mean_absolute_score_delta, 3)} | ` +
        `${item.aggregate.top3_preserved_snapshot_count}/${item.aggregate.snapshot_count} |`,
    );
  }
  lines.push(
    '',
    `相对初始 50/30/20，选定 20/50/30 将跨快照最高 short 分数从 ` +
      `${formatNumber(original.aggregate.max_score_across_snapshots)} 降到 ` +
      `${formatNumber(selected.aggregate.max_score_across_snapshots)}；` +
      `平均评分绝对变化从 ${formatNumber(original.aggregate.average_mean_absolute_score_delta, 3)} ` +
      `降到 ${formatNumber(selected.aggregate.average_mean_absolute_score_delta, 3)}；` +
      `旧口径 Spearman 从 ${formatNumber(original.aggregate.average_spearman_vs_old, 3)} ` +
      `升至 ${formatNumber(selected.aggregate.average_spearman_vs_old, 3)}。`,
    '',
    isStage6 ? '本轮复核边界：' : '选择理由：',
    '',
  );
  if (isStage6) {
    lines.push(
      '- 上表同时列出历史初始方案、当前正式方案和备选方案，不预选本轮结论。',
      '- 是否继续 20/50/30、调参或回退，必须结合预注册异常触发和独立经济结果证据。',
    );
  } else {
    lines.push(
      '- 1M 仍保留 20% 的真实短期信号，但 3M 以 50% 成为 short 桶主锚点，6M 提供 30% 稳定约束。',
      '- 50% 的 1M 权重会把 `134022A` 的 11.52% 单月值放大到 7.759 分，属于不可接受的短期噪声主导。',
      '- 10% 或 0% 能进一步贴近旧排序，但会让最新 1M 信息失去足够权重，因此不采纳；不能把“更像旧口径”当作唯一目标。',
    );
  }
  lines.push(
    '',
    '## long 扣分方案',
    '',
    '| 方案 | 平均排名变化 | 前三与 A 一致快照 | long 异常值 | 相对 A 变化分数 | 相对 A 最大变化 | 相对 B 变化分数 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const scheme of ['A', 'B', 'C']) {
    const item = report.long_frontload_options[scheme];
    lines.push(
      `| ${scheme} | ${formatNumber(item.aggregate.average_rank_changed, 2)} | ` +
        `${item.aggregate.top3_same_as_A_snapshot_count}/${snapshotCount} | ` +
        `${item.aggregate.outlier_count} | ` +
        `${item.pairwise_to_A?.changed_score_count ?? 0} | ` +
        `${formatNumber(item.pairwise_to_A?.max_positive_score_delta ?? 0)} | ` +
        `${item.pairwise_to_B?.changed_score_count ?? '—'} |`,
    );
  }
  lines.push(
    '',
    `- A/B/C 的 long 前三名在 ${snapshotCount} 份快照中有 ` +
      `${b.aggregate.top3_same_as_A_snapshot_count} 份与 A 一致。`,
    `- B 相对 A 只放宽 long 阈值：累计 ${b.pairwise_to_A?.changed_score_count ?? 0} 个分数变化，最大 ` +
      `${formatNumber(b.pairwise_to_A?.max_positive_score_delta ?? 0)}；` +
      `平均排名变化 ${formatNumber(b.aggregate.average_rank_changed, 2)}，` +
      `A 为 ${formatNumber(report.long_frontload_options.A.aggregate.average_rank_changed, 2)}。`,
    `- C 相对 B 再影响 ${report.long_frontload_options.C.pairwise_to_B?.changed_score_count ?? 0} 个分数，` +
      `最大再提高 ${formatNumber(report.long_frontload_options.C.pairwise_to_B?.max_positive_score_delta ?? 0)}；` +
      `平均排名变化 ${formatNumber(report.long_frontload_options.C.aggregate.average_rank_changed, 2)}。`,
    isStage6
      ? '- 本报告不自动决定继续、调参或回退；需要结合预注册异常触发和用户确认。'
      : '- 因此选择 B：保留前视惩罚，同时避免 long 桶对 1Y 较高产品过度惩罚。',
    '',
    '## 其他桶',
    '',
    isStage6
      ? '- medium 权重维持 `50/30/20`；本节复核只记录样本变化，不把跨桶结果合成单一总分。'
      : '- medium 权重保留 `50/30/20`：三份快照中与旧排序 Spearman 为 `0.997–0.999`，未出现异常集中。',
    '- long 权重保留 `20/40/40`：整体与旧排序保持高相关；单一 3M 高收益产品的风险继续通过 `three_month` 10% 单只、20% 合计上限和人工观察处理。',
    '- cash 继续仅展示，不评分、不排名、不分配、不进入候选或提案。',
    '',
    '## 跨模块影响投影',
    '',
    `- 初始 50/30/20 口径预计改变 ${originalProjection?.verdict_changed_count ?? '未获取到'} 个持仓候选结论。`,
    `- 选定 20/50/30 + B 预计改变 ${projection.verdict_changed_count ?? '未获取到'} 个候选结论。`,
    `- 当前持仓参考年化变化：${projection.current_yield_changed_count ?? '未获取到'}/${projection.current_holdings?.length ?? '未获取到'}。`,
    `- 当前候选参考年化变化：${projection.candidate_yield_changed_count ?? '未获取到'}/${projection.candidate_count ?? '未获取到'}。`,
    '',
    isStage6
      ? '这些只用于样本外参数复核，不是当前可执行交易建议。'
      : '这些是阶段 5 的兼容改造输入，不是当前可执行交易建议。',
    '',
    isStage6 ? '## 样本外复核边界' : '## 留待阶段 5 的风险',
    '',
  );
  for (const risk of report.residual_risks) {
    lines.push(`- ${risk}`);
  }
  lines.push(
    '',
    '## 输出',
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

async function fetchDashboard() {
  const response = await fetch(
    process.env.R2_DASHBOARD_URL || 'http://127.0.0.1:8765/api/dashboard',
    { signal: AbortSignal.timeout(3000) },
  );
  if (!response.ok) throw new Error(`Dashboard HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let observationSpec = null;
  let cohort = null;
  if (options.context === 'stage6') {
    observationSpec = JSON.parse(
      fs.readFileSync(path.resolve(options.spec), 'utf8'),
    );
    cohort = JSON.parse(
      fs.readFileSync(path.resolve(options.cohort), 'utf8'),
    );
    validateSpecAndCohort(observationSpec, cohort);
  }
  const inputFiles = resolveInputFiles(options.files);
  if (inputFiles.length < 2) throw new Error('至少需要两个产品快照');
  const generatedAt = options.generatedAt || new Date().toISOString();
  const snapshots = inputFiles.map((filePath) => {
    const buffer = fs.readFileSync(filePath);
    const products = loadProductsFromCsv(filePath);
    const reportDate =
      products
        .map((product) => product.data_date)
        .filter(Boolean)
        .sort()
        .at(-1) || null;
    return {
      label: path.basename(filePath),
      products,
      report_date: reportDate,
      source: {
        kind: 'product_csv',
        path: relativeDisplayPath(filePath),
        file_name: path.basename(filePath),
        file_date:
          /(\d{4}-\d{2}-\d{2})/.exec(path.basename(filePath))?.[1] || null,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        row_count: products.length,
      },
    };
  });
  let dashboard = null;
  if (!options.noApi) {
    try {
      dashboard = await fetchDashboard();
    } catch (error) {
      console.error(`跨模块投影跳过：${error.message}`);
    }
  }
  const report = buildParameterReviewReport({
    snapshots,
    productionDashboard: dashboard,
    generatedAt,
    reviewContext: options.context,
    cohort,
    observationSpec,
  });
  const stem =
    options.context === 'stage6'
      ? `td-yield-002-out-of-sample-parameter-review-${generatedAt.slice(0, 10)}`
      : `td-yield-001-parameter-decision-${generatedAt.slice(0, 10)}`;
  const outDir = path.resolve(options.outDir);
  const jsonPath = path.join(outDir, `${stem}.json`);
  const markdownPath = path.join(outDir, `${stem}.md`);
  const csvPath = path.join(outDir, `${stem}-short-sensitivity.csv`);
  const files = {
    json: relativeDisplayPath(jsonPath),
    markdown: relativeDisplayPath(markdownPath),
    csv: relativeDisplayPath(csvPath),
  };
  if (!options.dryRun) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.writeFileSync(markdownPath, renderMarkdown(report, files), 'utf8');
    fs.writeFileSync(csvPath, renderSensitivityCsv(report), 'utf8');
  }
  console.log(
    JSON.stringify(
      {
        mode: options.dryRun ? 'dry-run' : 'written',
        review_context: report.review_context,
        selected_short_variant: SELECTED_SHORT_VARIANT,
        selected_long_scheme: SELECTED_LONG_SCHEME,
        selected_buckets: report.selected_parameters.buckets,
        short_options: Object.fromEntries(
          Object.entries(report.short_weight_options).map(([key, value]) => [
            key,
            value.aggregate,
          ]),
        ),
        long_options: Object.fromEntries(
          Object.entries(report.long_frontload_options).map(([key, value]) => [
            key,
            value.aggregate,
          ]),
        ),
        production_projection: {
          selected_verdict_changes:
            report.production_projection.selected.verdict_changed_count ?? null,
          original_verdict_changes:
            report.production_projection.original_candidate
              ?.verdict_changed_count ?? null,
        },
        conclusion: report.conclusion,
        write_policy: report.write_policy,
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
