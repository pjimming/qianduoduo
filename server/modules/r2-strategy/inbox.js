'use strict';

const REVIEW_SPECS = Object.freeze({
  exit_required: {
    severity: 'urgent',
    title: '续持不达标',
    action_label: '确认退出',
    summary: (row) =>
      `有效近1月年化 ${formatYield(row.yield_1m)}，低于2.15%续持门槛；当前赎回窗口已核验，请确认退出提案。`,
  },
  exit_at_open: {
    severity: 'warn',
    title: '退出计划待确认',
    action_label: '查看到期计划',
    summary: (row) =>
      `续持不达标，当前锁定至 ${row.next_verify_date || '待核'}；到期后重新核验赎回窗口，不提前赎回。`,
  },
  exit_rules_pending: {
    severity: 'warn',
    title: '退出证据待核',
    action_label: '补齐赎回规则',
    summary: () =>
      '续持不达标，但赎回规则或当前窗口尚未核验；补齐证据后准备退出，不自动续作。',
  },
  risk_review: {
    severity: 'warn',
    title: '持仓风险待复核',
    action_label: '复核持仓',
    summary: () =>
      '近期收益达到续持门槛，但回撤、期限或资产条件需单独复核；未形成已成交赎回事实。',
  },
  evidence_pending: {
    severity: 'info',
    title: '持仓证据待补',
    action_label: '补齐持仓证据',
    summary: () =>
      '当前同份额近期收益缺失、过期或身份待核；补齐前不将缺失当作收益不达标，也不新买或加仓。',
  },
});

function formatYield(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)}%` : '未获取';
}

function actionUrl(lotId) {
  return `/ledger/products?section=holdings&lot=${encodeURIComponent(String(lotId))}`;
}

// Shadow results are comparison-only and must never create user todos. Only a
// v9 result whose activation sequence still matches the active strategy can
// project actionable holdings into the message center.
function buildStrategyInboxItems({ result, mode, today } = {}) {
  if (mode !== 'v9' || !result?.monitoring?.rows) return [];
  const activationSeq = result.input?.activation_seq ?? null;
  const seen = new Set();
  const items = [];
  for (const row of result.monitoring.rows) {
    const spec = REVIEW_SPECS[row?.state];
    if (!spec || row.requires_user_action !== true || !row.message_key) continue;
    const dedupeKey = `r2-strategy:${row.message_key}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const dueAt =
      row.state === 'exit_at_open' &&
      row.next_verify_date &&
      row.next_verify_date > today
        ? row.next_verify_date
        : null;
    items.push({
      dedupe_key: dedupeKey,
      source_type: 'r2_strategy_holding',
      source_id: String(row.lot_id),
      category: 'action',
      severity: spec.severity,
      title: `${spec.title}：${row.product_code}`,
      summary: spec.summary(row),
      action_label: spec.action_label,
      action_url: actionUrl(row.lot_id),
      due_at: dueAt,
      metadata: {
        lot_id: row.lot_id,
        product_code: row.product_code,
        state: row.state,
        yield_1m: row.yield_1m ?? null,
        performance_date: row.performance_date ?? null,
        next_verify_date: row.next_verify_date ?? null,
        message_key: row.message_key,
        fingerprint: row.fingerprint ?? null,
        strategy_activation_seq: activationSeq,
      },
    });
  }
  return items;
}

module.exports = { buildStrategyInboxItems };
