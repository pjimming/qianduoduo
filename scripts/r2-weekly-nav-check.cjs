#!/usr/bin/env node
'use strict';

const { checkWeek, pendingShares, collectWeeklyNav } = require('../server/modules/r2-strategy/weekly-nav');
const { todayShanghai } = require('../lib/metrics');

async function run() {
  const response = await fetch('http://127.0.0.1:8765/api/r2-strategy/workspace', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('持仓工作区读取失败（HTTP ' + response.status + '）');
  const workspace = await response.json();
  const date = todayShanghai();
  const contract = workspace.effective_contract ?? workspace.contract;
  const threshold = Number(contract?.exit_policy?.recent_return_threshold_pct);
  const targets = Number.isFinite(threshold) ? pendingShares(workspace, date) : null;
  return collectWeeklyNav(targets, date, threshold, { maxDataAgeDays: contract?.max_data_age_days });
}

if (require.main === module) {
  run().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { checkWeek };
