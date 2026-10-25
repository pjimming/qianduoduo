#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { resolveProductCsv } = require('../server/modules/products/product-csv');
const {
  captureObservationFromFile,
  initializeObservationStore,
  observationPaths,
  readJson,
  readObservationLedger,
  reviewObservationLedger,
} = require('../lib/yield-observation');

const root = path.resolve(__dirname, '..');

function usage() {
  return [
    '用法：',
    '  node scripts/yield-observe.cjs init [--input <csv>] [--root <dir>]',
    '  node scripts/yield-observe.cjs capture [--input <csv>] [--root <dir>] [--dry-run] [--json]',
    '  node scripts/yield-observe.cjs review [--root <dir>] [--json]',
    '',
    '说明：',
    '  init     冻结观察规格、固定产品 cohort 并建立空台账；已有文件默认不覆盖。',
    '  capture  对新产品快照执行一次幂等周观察；同数据日不会重复计数。',
    '  review   检查 4/8 个独立样本和预注册异常阈值，不修改正式权重。',
  ].join('\n');
}

function parseArgs(argv) {
  const [command = 'capture', ...rest] = argv;
  const options = {
    command,
    input: null,
    root,
    dryRun: false,
    json: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--input') {
      options.input = rest[index + 1];
      index += 1;
    } else if (arg.startsWith('--input=')) {
      options.input = arg.slice('--input='.length);
    } else if (arg === '--root') {
      options.root = rest[index + 1];
      index += 1;
    } else if (arg.startsWith('--root=')) {
      options.root = arg.slice('--root='.length);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.command = 'help';
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  options.root = path.resolve(options.root);
  if (!['init', 'capture', 'review', 'help'].includes(options.command)) {
    throw new Error(`未知命令：${options.command}`);
  }
  if (options.command === 'init' || options.command === 'capture') {
    options.input = path.resolve(
      options.input || resolveProductCsv(options.root),
    );
  }
  return options;
}

function printCapture(result) {
  console.log(`采集状态：${result.status}${result.data_date ? ` · ${result.data_date}` : ''}`);
  if (result.message) console.log(result.message);
  if (result.record) {
    const metrics = result.record.metrics;
    console.log(
      `独立样本：${result.record.sample_index}；cohort 原始覆盖 ${(result.record.quality.cohort_presence_ratio * 100).toFixed(1)}%，` +
        `可评分覆盖 ${(result.record.quality.reportable_cohort_ratio * 100).toFixed(1)}%`,
    );
    console.log(
      `short 前5%超额占比：${metrics.buckets.short.top5_excess_share ?? '—'}；` +
        `不可计算比例：${(metrics.unavailable_ratio * 100).toFixed(1)}%`,
    );
    console.log(
      `667828A：rank B=${metrics.spotlight_667828A.rank_B ?? '—'}，单一窗口前5%=${metrics.spotlight_667828A.single_window_top5}`,
    );
  }
  if (result.review) {
    console.log(
      `观察进度：${result.review.sample_count}/${result.review.required_samples}（目标 ${result.review.preferred_samples}）· ${result.review.status}`,
    );
    for (const item of result.review.triggers) {
      console.log(`[${item.severity}] ${item.summary}`);
    }
  }
}

function printReview(review) {
  console.log(
    `样本外观察：${review.sample_count}/${review.required_samples}（目标 ${review.preferred_samples}）`,
  );
  console.log(`状态：${review.review_status || review.status}`);
  if (review.remaining_samples) {
    console.log(`仍缺 ${review.remaining_samples} 个独立周样本`);
  }
  if (review.remaining_preferred_samples) {
    console.log(
      `距离优先目标还缺 ${review.remaining_preferred_samples} 个样本`,
    );
  }
  for (const issue of review.ledger_issues || []) {
    console.log(`台账异常：${issue.code} · ${issue.message}`);
  }
  for (const item of review.triggers) {
    console.log(`[${item.severity}] ${item.summary}`);
  }
  console.log(`参数复核入口：${review.parameter_review_command}`);
  console.log(`正式权重已修改：${review.formal_weight_change ? '是' : '否'}`);
}

function reviewFromStore(options) {
  const paths = observationPaths(options.root);
  const spec = readJson(paths.spec);
  const cohort = readJson(paths.cohort);
  const records = readObservationLedger(paths.ledger);
  return {
    ...reviewObservationLedger(records, spec, cohort),
    paths,
  };
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
  if (options.command === 'help') {
    console.log(usage());
    return;
  }
  if (options.command === 'init') {
    const result = initializeObservationStore({
      root: options.root,
      inputPath: options.input,
    });
    if (options.json) {
      console.log(JSON.stringify({
        status: 'initialized',
        baseline_data_date: result.cohort.baseline_data_date,
        cohort_count: result.cohort.code_count,
        cohort_hash: result.cohort.code_hash,
        paths: result.paths,
      }, null, 2));
    } else {
      console.log(
        `观察规格已冻结：${result.cohort.baseline_data_date}，cohort ${result.cohort.code_count} 只`,
      );
      console.log(`规格：${result.paths.spec}`);
      console.log(`cohort：${result.paths.cohort}`);
      console.log(`台账：${result.paths.ledger}`);
    }
    return;
  }
  if (options.command === 'capture') {
    const result = captureObservationFromFile({
      root: options.root,
      inputPath: options.input,
      dryRun: options.dryRun,
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printCapture(result);
    if (
      ['disqualified', 'ledger_invalid', 'cadence_broken'].includes(
        result.status,
      )
    ) {
      process.exitCode = 1;
    }
    return;
  }
  const result = reviewFromStore(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printReview(result);
  if (result.status === 'ledger_invalid') process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  reviewFromStore,
};
