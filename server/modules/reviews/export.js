'use strict';

function markdownCell(value) {
  const text = String(value ?? '')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
  return text || '—';
}

function moneyText(value) {
  const number = Number(value || 0);
  const prefix = number < 0 ? '−' : '';
  return `${prefix}¥${Math.abs(number).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pctText(value, digits = 3, signed = false) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return '—';
  }
  const number = Number(value);
  const prefix = signed && number > 0 ? '+' : number < 0 ? '−' : '';
  return `${prefix}${Math.abs(number).toFixed(digits)}%`;
}

function ppText(value, digits = 2, signed = false) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return '—';
  }
  const number = Number(value);
  const prefix = signed && number > 0 ? '+' : number < 0 ? '−' : '';
  return `${prefix}${Math.abs(number).toFixed(digits)}pp`;
}

function buildMonthlyReviewMarkdown({
  month,
  review,
  decisions,
  events,
  note,
  holdings,
  holdingsSummary,
  generatedAt,
}) {
  const row = review.monthly.find((item) => item.month === month) || null;
  const lines = [];
  lines.push(`# R2 月度复盘 ${month}`);
  lines.push('');
  lines.push(
    `> 生成时间：${generatedAt}；数据来源：钱多多 R2 收益账本；币种：人民币。`,
  );
  lines.push('> R2 不保本，以下为个人复盘记录，不构成投资建议。');
  lines.push('');
  lines.push('## 一、月度指标');
  lines.push('');
  if (!row) {
    lines.push('该月没有收益记录。');
  } else {
    lines.push('| 指标 | 数值 |');
    lines.push('| --- | ---: |');
    lines.push(`| 月收益 | ${moneyText(row.pnl)} |`);
    lines.push(`| 月均本金 | ${moneyText(row.avg_principal)} |`);
    lines.push(`| 月收益率 | ${pctText(row.return_pct, 3, true)} |`);
    lines.push(`| 年化参考 | ${pctText(row.annualized_pct, 2, true)} |`);
    lines.push(`| 最大回撤 | ${pctText(row.max_drawdown_pct, 3)} |`);
    lines.push(`| 负收益天数占比 | ${pctText(row.negative_day_ratio_pct, 1)} |`);
    lines.push(`| 最好单日 | ${moneyText(row.best_day)} |`);
    lines.push(`| 最差单日 | ${moneyText(row.worst_day)} |`);
    lines.push(`| 目标缺口 | ${ppText(row.target_gap_pct, 2, true)} |`);
    lines.push(
      `| 记录完整度 | ${row.record_days}/${row.elapsed_days} 天，缺记 ${row.missing_days} 天 |`,
    );
    lines.push(`| 评级 | ${row.grade_display} |`);
  }
  lines.push('');
  lines.push('## 二、目标进度');
  lines.push('');
  if (!row) {
    lines.push('该月没有收益记录。');
  } else {
    lines.push(`- 按天折算目标：${pctText(row.target_mtd_pct, 3)}`);
    lines.push(`- 当前月收益率：${pctText(row.return_pct, 3, true)}`);
    lines.push(`- 完成进度：${pctText(row.target_progress_pct, 1)}`);
    lines.push(
      `- 按当前速度月底预估：${pctText(row.projected_pct, 3, true)}（短样本仅参考）`,
    );
  }
  lines.push('');
  lines.push('## 三、环比');
  lines.push('');
  if (!row) {
    lines.push('该月没有收益记录。');
  } else if (row.compare) {
    lines.push(`对比 ${row.compare.prev_month_label}：`);
    lines.push('');
    lines.push(`- 收益变化：${moneyText(row.compare.pnl_delta)}`);
    lines.push(`- 收益率变化：${ppText(row.compare.return_delta_pp, 3, true)}`);
    lines.push(`- 回撤变化：${ppText(row.compare.drawdown_delta_pp, 3, true)}`);
    lines.push(
      `- 负收益天数占比变化：${ppText(
        row.compare.negative_ratio_delta_pp,
        1,
        true,
      )}`,
    );
    lines.push(
      `- 操作次数变化：${row.compare.action_delta > 0 ? '+' : ''}${row.compare.action_delta}`,
    );
  } else {
    lines.push('首月记录，暂无环比。');
  }
  lines.push('');
  lines.push('## 四、决策日志');
  lines.push('');
  if (!decisions.length) {
    lines.push('本月没有决策记录。');
  } else {
    lines.push('| 日期 | 产品 | 动作 | 理由 | 预期 | 实际结果 | 事后评价 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const item of decisions) {
      lines.push(
        `| ${markdownCell(item.date)} | ${markdownCell(item.product_name)} | ${markdownCell(
          item.action,
        )} | ${markdownCell(item.reason)} | ${markdownCell(
          item.expectation,
        )} | ${markdownCell(item.actual_result)} | ${markdownCell(item.rating)} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 五、产品事件');
  lines.push('');
  if (!events.length) {
    lines.push('本月没有产品事件记录。');
  } else {
    lines.push('| 日期 | 产品 | 类型 | 影响 | 状态 | 说明 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const item of events) {
      lines.push(
        `| ${markdownCell(item.date)} | ${markdownCell(item.product_name)} | ${markdownCell(
          item.event_type,
        )} | ${markdownCell(item.impact)} | ${markdownCell(
          item.status,
        )} | ${markdownCell(item.description)} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 六、月度五问');
  lines.push('');
  if (!note) {
    lines.push('本月五问尚未填写。');
  } else {
    const questions = [
      '这个月有没有按计划执行？哪一次偏离了，为什么？',
      '哪笔操作真正增加了收益，哪笔只是增加了忙碌？',
      '闲置资金拖累是否接近 0？近 3M/6M/1Y 年化离 3% 差多少？',
      '有没有产品触发风险、流动性或费率红线？',
      '下个月只改一件事，改什么？',
    ];
    questions.forEach((question, index) => {
      lines.push(`${index + 1}. ${question}`);
      lines.push(`   答：${markdownCell(note.answers[index])}`);
    });
  }
  lines.push('');
  lines.push('## 七、当月结论与下月只改一件事');
  lines.push('');
  lines.push(`- 当月结论：${markdownCell(note?.conclusion)}`);
  lines.push(`- 下月只改一件事：${markdownCell(note?.answers?.[4])}`);
  lines.push('');
  lines.push('## 八、当前持仓快照');
  lines.push('');
  lines.push('> 这是导出时的当前持仓，不是月末持仓快照。');
  lines.push('');
  lines.push(`- 未赎回成本本金：${moneyText(holdingsSummary.total_amount)}`);
  lines.push(
    `- 最大单只成本占比：${
      holdingsSummary.max_product
        ? `${holdingsSummary.max_product.name} ${pctText(holdingsSummary.max_product.pct, 1)}`
        : '—'
    }`,
  );
  lines.push(
    `- 最大发行方成本占比（仅展示）：${
      holdingsSummary.max_issuer
        ? `${holdingsSummary.max_issuer.name} ${pctText(
            holdingsSummary.max_issuer.pct,
            1,
          )}`
        : '—'
    }`,
  );
  lines.push(
    `- 短期 7–30 天成本占比：${pctText(holdingsSummary.short_ratio_pct, 1)}`,
  );
  lines.push(
    `- 现有日开金额与占比：${moneyText(holdingsSummary.buckets.liquid)}，${pctText(
      holdingsSummary.daily_open_ratio_pct,
      1,
    )}（新增目标固定 0%）`,
  );
  lines.push(
    `- 已到期持仓：${holdingsSummary.overdue_count} 笔，${moneyText(
      holdingsSummary.overdue_amount,
    )}`,
  );
  lines.push('');
  if (!holdings.length) {
    lines.push('尚未录入持仓。');
  } else {
    lines.push('| 产品 | 金额 | 确认起持日 | 期限 | 到期日 | 发行方 | 风险 |');
    lines.push('| --- | ---: | --- | ---: | --- | --- | --- |');
    for (const item of holdings) {
      lines.push(
        `| ${markdownCell(item.product_name)} | ${moneyText(item.amount)} | ${markdownCell(
          item.purchase_date,
        )} | ${item.term_days === 0 ? '日开' : item.term_days ? `${item.term_days} 天` : '未填'} | ${markdownCell(
          item.maturity_date,
        )} | ${markdownCell(item.issuer)} | ${markdownCell(item.risk_level)} |`,
      );
    }
  }
  lines.push('');
  lines.push('## 九、复盘口径');
  lines.push('');
  lines.push(
    '- 月收益率 = 月收益 ÷ 月均本金；评级：0.16% 及格、0.20% 良好、0.25% 优秀、0.30% 卓越。',
  );
  lines.push(
    '- 当前月份只显示进度和参考区间；月末且满 28 天、20 条记录后才落最终评级。',
  );
  lines.push('- 年化、回撤和环比只用于个人复盘，不代表未来收益。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

module.exports = { buildMonthlyReviewMarkdown };
