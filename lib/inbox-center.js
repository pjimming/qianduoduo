'use strict';

const SOURCE_LABELS = {
  income_screenshot: '收益截图',
  product_valuation_reconciliation: '产品收益对账',
  missing_income: '收益追踪',
  trade_screenshot: '交易截图',
  pending_trade: '交易流水',
  trade_reconciliation: '交易对账',
  decision_proposal: '决策提案',
  evaluation: '自动评估',
  product_event: '产品事件',
  holding_review: '持仓复核',
  review_draft: '自动复盘',
  system_notification: '平台提醒',
};

const SOURCE_ORDER = Object.keys(SOURCE_LABELS);
const SEVERITY_ORDER = { urgent: 0, warn: 1, info: 2 };

const INBOX_SCHEMA = `
  CREATE TABLE IF NOT EXISTS inbox_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'action' CHECK (
      category IN ('action', 'reminder', 'system')
    ),
    severity TEXT NOT NULL DEFAULT 'info' CHECK (
      severity IN ('urgent', 'warn', 'info')
    ),
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    action_label TEXT NOT NULL DEFAULT '查看',
    action_url TEXT NOT NULL DEFAULT '',
    due_at TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (
      status IN ('active', 'snoozed', 'resolved')
    ),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    read_at TEXT,
    snoozed_until TEXT,
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_inbox_items_status
    ON inbox_items(status, severity, due_at, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_inbox_items_source
    ON inbox_items(source_type, source_id);
`;

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || '') ?? fallback;
  } catch {
    return fallback;
  }
}

function severityRank(value) {
  return SEVERITY_ORDER[value] ?? 9;
}

function mapItem(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    dedupe_key: row.dedupe_key,
    source_type: row.source_type,
    source_id: row.source_id || '',
    source_label: SOURCE_LABELS[row.source_type] || row.source_type,
    category: row.category,
    severity: row.severity,
    title: row.title,
    summary: row.summary,
    action_label: row.action_label || '查看',
    action_url: row.action_url || '',
    due_at: row.due_at || null,
    status: row.status,
    metadata: parseJson(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    read_at: row.read_at || null,
    snoozed_until: row.snoozed_until || null,
    resolved_at: row.resolved_at || null,
  };
}

function daysBetween(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.round((end - start) / 86400000);
}

function holdingReviewMessage(review) {
  const candidate =
    (review.candidates || []).find(
      (item) => item.code === review.top_candidate_code,
    ) ||
    (review.candidates || [])[0] ||
    null;
  if (review.verdict !== 'replace' || !candidate) {
    return {
      summary: `${review.product_name}：${
        review.reminder?.text || `复核结论为 ${review.verdict_label || review.verdict}`
      }。`,
      actionLabel: '查看持仓复核',
      metadata: {},
    };
  }

  const comparisonDays = Number(
    candidate.comparison_days ?? review.horizon_days ?? 0,
  );
  const switchWaitDays =
    candidate.switch_wait_days === null || candidate.switch_wait_days === undefined
      ? null
      : Number(candidate.switch_wait_days);
  const effectiveDays =
    candidate.effective_days === null || candidate.effective_days === undefined
      ? null
      : Number(candidate.effective_days);
  const switchWaitStatus =
    candidate.switch_wait_status === 'verified' ? 'verified' : 'estimated';
  const difference = Number(candidate.switch?.difference ?? 0);
  const threshold = Number(
    candidate.min_gain_amount ?? review.thresholds?.min_gain_amount ?? 0,
  );
  const redemption = review.redemption || {};
  const execution =
    redemption.redeemable_now && switchWaitStatus === 'verified'
      ? '当前可赎回，执行前核对额度与费用。'
      : redemption.redeemable_now
        ? '当前可赎回，但 T+N 仍为估算值，执行前必须核验。'
      : `当前不可赎回，先记录到期后计划${
          redemption.available_date ? `（最早 ${redemption.available_date}）` : ''
        }。`;
  return {
    summary:
      `${review.product_name} → ${candidate.name}：比较 ${comparisonDays} 天，` +
      `切换等待 ${
        Number.isFinite(switchWaitDays)
          ? `${switchWaitDays} 天（${switchWaitStatus === 'verified' ? '已核验' : '估算'}）`
          : '待核'
      }、` +
      `有效计息 ${Number.isFinite(effectiveDays) ? effectiveDays : '待核'} 天，` +
      `扣除费用后预计多赚 ¥${difference.toFixed(2)}` +
      `（门槛 ¥${threshold.toFixed(2)}）。${execution}`,
    actionLabel: '查看替换测算',
    metadata: {
      candidate_code: candidate.code,
      comparison_days: comparisonDays,
      switch_wait_days: Number.isFinite(switchWaitDays) ? switchWaitDays : null,
      switch_wait_status: switchWaitStatus,
      effective_days: Number.isFinite(effectiveDays) ? effectiveDays : null,
      expected_difference: difference,
      min_gain_amount: threshold,
      redeemable_now: Boolean(redemption.redeemable_now),
    },
  };
}

function makeSourceItems(dashboard) {
  const items = new Map();
  const today = dashboard.meta.today;
  const workspace = dashboard.workspace || {};
  const automation = dashboard.automation || {};

  function add(item) {
    const key = item.dedupe_key;
    const previous = items.get(key);
    if (!previous) {
      items.set(key, {
        category: 'action',
        severity: 'info',
        action_label: '去处理',
        action_url: '',
        summary: '',
        metadata: {},
        ...item,
      });
      return;
    }
    if (severityRank(item.severity) < severityRank(previous.severity)) {
      previous.severity = item.severity;
    }
    if (item.summary && !previous.summary.includes(item.summary)) {
      previous.summary = [previous.summary, item.summary].filter(Boolean).join('；');
    }
    previous.metadata = { ...previous.metadata, ...(item.metadata || {}) };
  }

  const tradeInbox = workspace.trades?.inbox || [];
  for (const screenshot of tradeInbox.filter((item) => item.status === 'pending')) {
    const warnings = screenshot.parsed?.warnings || [];
    add({
      dedupe_key: `trade-screenshot:${screenshot.id}`,
      source_type: 'trade_screenshot',
      source_id: String(screenshot.id),
      severity:
        screenshot.parse_confidence < 50 || warnings.length ? 'warn' : 'info',
      title: '交易截图等待平台入账',
      summary: `${screenshot.original_name || `截图 #${screenshot.id}`}：识别置信度 ${
        screenshot.parse_confidence
      }%${warnings.length ? `，${warnings.join('、')}` : ''}。`,
      action_label: '查看识别结果',
      action_url: '/ledger/trades#inbox',
      metadata: { screenshot_id: screenshot.id },
    });
  }

  const incomeInbox = workspace.income_inbox || [];
  for (const screenshot of incomeInbox.filter((item) => item.status === 'pending')) {
    const warnings = screenshot.parsed?.warnings || [];
    add({
      dedupe_key: `income-screenshot:${screenshot.id}`,
      source_type: 'income_screenshot',
      source_id: String(screenshot.id),
      severity:
        screenshot.parse_confidence < 75 || warnings.length ? 'warn' : 'info',
      title: '收益截图等待平台入账',
      summary: `${screenshot.original_name || `截图 #${screenshot.id}`}：${
        screenshot.parsed?.daily_pnl === null ||
        screenshot.parsed?.daily_pnl === undefined
          ? '未识别到收益数字'
          : `识别收益 ¥${Number(screenshot.parsed.daily_pnl).toFixed(2)}`
      }${warnings.length ? `；${warnings.join('、')}` : ''}。`,
      action_label: '核对收益截图',
      action_url: '/ledger/daily#capture-income',
      metadata: { income_inbox_id: screenshot.id },
    });
  }

  for (const reconciliation of workspace.product_valuation_reconciliation?.items ||
    []) {
    if (
      !['mismatch', 'missing-account-total'].includes(reconciliation.status)
    ) {
      continue;
    }
    add({
      dedupe_key: `product-valuation-reconciliation:${reconciliation.yield_date}:${reconciliation.status}`,
      source_type: 'product_valuation_reconciliation',
      source_id: reconciliation.yield_date,
      severity: reconciliation.status === 'mismatch' ? 'warn' : 'info',
      title: '逐产品收益需要对账',
      summary: `${reconciliation.yield_date}：产品合计 ¥${Number(
        reconciliation.product_pnl,
      ).toFixed(2)}${
        reconciliation.account_pnl === null
          ? '，尚无账户总收益'
          : `，账户总收益 ¥${Number(reconciliation.account_pnl).toFixed(2)}`
      }。${reconciliation.message}。`,
      action_label: '查看产品收益档案',
      action_url: '/ledger/trades#holdings',
      metadata: {
        yield_date: reconciliation.yield_date,
        difference: reconciliation.difference,
      },
    });
  }

  const pendingTrades = (workspace.trades?.trades || []).filter(
    (trade) => trade.status === 'pending',
  );
  for (const trade of pendingTrades) {
    const age = daysBetween(trade.trade_date, today);
    add({
      dedupe_key: `pending-trade:${trade.id}`,
      source_type: 'pending_trade',
      source_id: String(trade.id),
      severity: age >= 7 ? 'urgent' : age >= 3 ? 'warn' : 'info',
      title: '交易等待确认',
      summary: `${trade.product_name}（${trade.product_code}）${trade.trade_type === 'buy' ? '买入' : trade.trade_type === 'redeem' ? '赎回' : '切换'} ¥${Number(
        trade.amount,
      ).toFixed(2)}，已等待 ${age} 天。`,
      action_label: '确认交易',
      action_url: '/ledger/trades#trades',
      metadata: { trade_id: trade.id },
    });
  }

  const reconciliation = workspace.trades?.reconciliation?.items || [];
  for (const issue of reconciliation) {
    if (
      ![
        'missing-screenshot',
        'amount-mismatch',
        'code-mismatch',
        'missing-settlement',
        'no-allocation',
      ].includes(issue.code)
    ) {
      continue;
    }
    const tradeId = issue.trade_id || 'unknown';
    add({
      dedupe_key: `trade-reconciliation:${tradeId}:${issue.code}`,
      source_type: 'trade_reconciliation',
      source_id: String(tradeId),
      severity: issue.level === 'warn' ? 'warn' : 'info',
      title: '交易对账需要核对',
      summary: issue.text,
      action_label: '查看交易',
      action_url: '/ledger/trades#trades',
      metadata: { trade_id: issue.trade_id, code: issue.code },
    });
  }

  for (const event of (workspace.events || []).filter(
    (item) => item.status === '待复核',
  )) {
    add({
      dedupe_key: `product-event:${event.id}`,
      source_type: 'product_event',
      source_id: String(event.id),
      severity: event.impact === '高' ? 'warn' : 'info',
      title: '产品事件等待复核',
      summary: `${event.product_name} · ${event.event_type}：${event.description}`,
      action_label: '复核产品事件',
      action_url: '/ledger/products#events',
      metadata: { event_id: event.id },
    });
  }

  for (const review of workspace.holding_reviews || []) {
    // Executable replacements are communicated only through decision
    // proposals. Once no proposal is active, the holding-review reminder must
    // disappear instead of leaking a second, parallel replacement notice.
    if (review.verdict === 'replace') continue;
    const reminderLevel = review.reminder?.level || 'none';
    if (reminderLevel === 'none') continue;
    const message = holdingReviewMessage(review);
    add({
      dedupe_key: `holding-review:${review.lot_id}`,
      source_type: 'holding_review',
      source_id: String(review.lot_id),
      category: 'reminder',
      severity: reminderLevel === 'urgent' ? 'warn' : 'info',
      title: '持仓进入复核窗口',
      summary: message.summary,
      action_label: message.actionLabel,
      action_url: '/ledger/products#holding-reviews',
      due_at:
        review.verify_date ||
        review.next_review_date ||
        review.maturity_date ||
        review.next_redeem_open_date ||
        null,
      metadata: {
        lot_id: review.lot_id,
        verdict: review.verdict,
        ...message.metadata,
      },
    });
  }

  for (const proposal of dashboard.decision_proposals?.proposals || []) {
    if (!['pending', 'accepted'].includes(proposal.status)) continue;
    const pending = proposal.status === 'pending';
    const executionDeviation =
      !pending && proposal.decision_execution_status === 'deviation';
    const auditReview =
      !pending &&
      ['review', 'amount-adjustment'].includes(
        proposal.decision_audit_status,
      );
    add({
      dedupe_key: `decision-proposal:${proposal.id}`,
      source_type: 'decision_proposal',
      source_id: String(proposal.id),
      category: pending ? 'action' : 'reminder',
      severity: pending ? 'warn' : 'info',
      title: pending
        ? '决策提案待采纳'
        : executionDeviation
          ? '决策执行出现偏差'
          : auditReview
            ? '交易已执行，审计待补证据'
            : '决策已采纳，待执行',
      summary: pending
        ? `${proposal.title}。${proposal.summary} 有效期至 ${proposal.expires_at || '待定'}。`
        : executionDeviation
          ? `${proposal.title}。关联交易与已采纳方案的方向、产品或金额不一致，请核对交易或改绑决策。`
          : auditReview
            ? `${proposal.title}。交易已关联，但成交截图、金额或风险等级仍有一致性证据待补。`
        : `${proposal.title}。请在招行 App 自行执行，完成后再上传成交截图；平台会核对交易与决策是否一致。`,
      action_label: pending
        ? '查看并采纳'
        : executionDeviation
          ? '核对执行偏差'
          : '查看待执行决策',
      action_url: executionDeviation
        ? '/ledger/trades#trades'
        : '/ledger/evaluation#proposals',
      due_at: pending ? proposal.expires_at || null : proposal.verify_date || null,
      metadata: {
        proposal_id: proposal.id,
        proposal_status: proposal.status,
        decision_id: proposal.decision_id,
        proposal_type: proposal.proposal_type,
        action: proposal.action,
        product_code: proposal.product_code,
        target_product_code: proposal.target_product_code,
        amount: proposal.amount,
      },
    });
  }

  for (const evaluation of automation.pending_evaluations || []) {
    const missingDecisionFields = Array.isArray(
      evaluation.evidence?.decision_missing_fields,
    )
      ? evaluation.evidence.decision_missing_fields
      : [];
    const needsDecisionEvidence = missingDecisionFields.length > 0;
    const pendingTradeIds = Array.isArray(evaluation.evidence?.pending_trade_ids)
      ? evaluation.evidence.pending_trade_ids
      : [];
    const waitingForTrades = !needsDecisionEvidence && pendingTradeIds.length > 0;
    const waitingForSamples =
      !needsDecisionEvidence && !waitingForTrades && evaluation.outcome === 'unknown';
    add({
      dedupe_key: `evaluation:${evaluation.id}`,
      source_type: 'evaluation',
      source_id: String(evaluation.id),
      category: 'reminder',
      severity: needsDecisionEvidence ? 'warn' : 'info',
      title: needsDecisionEvidence
        ? '决策证据待补充'
        : waitingForTrades
          ? '等待交易确认后评估'
          : waitingForSamples
            ? '评估等待更多收益样本'
            : '自动评估等待确认',
      summary: needsDecisionEvidence
        ? `缺少${missingDecisionFields
            .map((field) =>
              ({
                reason: '决策理由',
                expectation: '收益/流动性预期',
                evidence_date: '证据日期',
                verify_date: '验证日期',
                invalidation_condition: '失效条件',
              })[field] || field,
            )
            .join('、')}。${evaluation.summary}`
        : waitingForTrades
          ? `${pendingTradeIds.length} 笔关联交易仍在进行中；确认后再判断流程与结果。`
        : `${evaluation.summary}（置信度 ${evaluation.confidence}%）`,
      action_label: needsDecisionEvidence
        ? '补充决策证据'
        : waitingForTrades
          ? '查看待确认交易'
          : '查看评估',
      action_url: needsDecisionEvidence
        ? '/ledger/evaluation#decisions'
        : waitingForTrades
          ? '/ledger/trades#trades'
          : '/ledger/evaluation#automation',
      metadata: {
        evaluation_id: evaluation.id,
        decision_id: evaluation.decision_id,
      },
    });
  }

  for (const draft of (automation.drafts || []).filter(
    (item) => item.status === 'draft',
  )) {
    add({
      dedupe_key: `review-draft:${draft.period_type}:${draft.period}`,
      source_type: 'review_draft',
      source_id: `${draft.period_type}:${draft.period}`,
      category: 'reminder',
      severity: 'info',
      title: `${draft.content?.title || `${draft.period} 复盘草稿`}待归档`,
      summary:
        draft.content?.next_action ||
        draft.content?.conclusion ||
        '平台已生成复盘草稿，等待归档。',
      action_label: '查看复盘',
      action_url:
        draft.period_type === 'monthly'
          ? '/ledger/review#monthly-notes'
          : '/ledger/review#quarterly-notes',
      metadata: {
        period_type: draft.period_type,
        period: draft.period,
      },
    });
  }

  const reportingDate = dashboard.meta.reporting_date;
  const capitalStart = dashboard.capital?.initial_date;
  const hasReportingRecord = dashboard.meta.has_reporting_record;
  if (
    dashboard.capital?.initialized &&
    reportingDate &&
    capitalStart &&
    reportingDate >= capitalStart &&
    !hasReportingRecord
  ) {
    add({
      dedupe_key: `missing-income:${reportingDate}`,
      source_type: 'missing_income',
      source_id: reportingDate,
      severity: 'warn',
      title: '最近披露日收益尚未上传',
      summary: `请上传 ${reportingDate} 的收益截图，平台会自动记录并继续追踪。`,
      action_label: '上传收益截图',
      action_url: '/ledger/daily#capture-income',
      due_at: reportingDate,
      metadata: { reporting_date: reportingDate },
    });
  }

  const representedNotificationKeys = new Set(
    [...items.values()]
      .flatMap((item) => [
        item.metadata.evaluation_id
          ? `evaluation-pending:${item.metadata.evaluation_id}`
          : '',
        item.metadata.income_inbox_id
          ? `screenshot-review:${item.metadata.income_inbox_id}`
          : '',
      ])
      .filter(Boolean),
  );
  const skipNotificationKinds = new Set([
    'evaluation',
    'inbox',
    'maturity',
    'pending',
    'reconciliation',
    'draft',
  ]);
  for (const notification of automation.notifications || []) {
    if (
      skipNotificationKinds.has(notification.kind) ||
      representedNotificationKeys.has(notification.dedupe_key)
    ) {
      continue;
    }
    const notificationData = notification.data || {};
    const category = ['action', 'reminder', 'system'].includes(
      notificationData.category,
    )
      ? notificationData.category
      : 'system';
    add({
      dedupe_key: `notification:${notification.dedupe_key}`,
      source_type: 'system_notification',
      source_id: String(notification.id),
      category,
      severity: ['urgent', 'warn', 'info'].includes(notificationData.severity)
        ? notificationData.severity
        : notification.level === 'warn'
          ? 'warn'
          : 'info',
      title: notification.title,
      summary: notification.message,
      action_label: notificationData.action_label || '查看详情',
      action_url:
        notificationData.action_url || '/ledger/evaluation#automation',
      due_at: notificationData.due_at || null,
      metadata: {
        notification_id: notification.id,
        category,
        ...(notificationData || {}),
      },
    });
  }

  return [...items.values()];
}

function createInboxCenter(db) {
  db.exec(INBOX_SCHEMA);

  const selectAll = db.prepare(`
    SELECT * FROM inbox_items
    ORDER BY
      CASE status WHEN 'active' THEN 0 WHEN 'snoozed' THEN 1 ELSE 2 END,
      CASE severity WHEN 'urgent' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
      COALESCE(due_at, '9999-12-31') ASC,
      updated_at DESC,
      id DESC
  `);
  const selectItem = db.prepare('SELECT * FROM inbox_items WHERE id = ?');
  const selectByKey = db.prepare(
    'SELECT * FROM inbox_items WHERE dedupe_key = ?',
  );
  const insertItem = db.prepare(`
    INSERT INTO inbox_items (
      dedupe_key, source_type, source_id, category, severity, title, summary,
      action_label, action_url, due_at, status, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  const updateItem = db.prepare(`
    UPDATE inbox_items
    SET source_type = ?, source_id = ?, category = ?, severity = ?, title = ?,
        summary = ?, action_label = ?, action_url = ?, due_at = ?,
        metadata_json = ?, updated_at = ?, read_at = ?
    WHERE id = ?
  `);
  const resolveItem = db.prepare(`
    UPDATE inbox_items
    SET status = 'resolved', resolved_at = ?, updated_at = ?
    WHERE id = ? AND status <> 'resolved'
  `);
  const updateState = db.prepare(`
    UPDATE inbox_items
    SET status = ?, read_at = ?, snoozed_until = ?, resolved_at = ?,
        updated_at = ?
    WHERE id = ?
  `);
  const promoteSnoozed = db.prepare(`
    UPDATE inbox_items
    SET status = 'active', snoozed_until = NULL, updated_at = ?
    WHERE status = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= ?
  `);
  const markAllReadStatement = db.prepare(`
    UPDATE inbox_items
    SET read_at = COALESCE(read_at, ?), updated_at = ?
    WHERE status IN ('active', 'snoozed')
  `);

  function sync(dashboard) {
    const stamp = new Date().toISOString();
    promoteSnoozed.run(stamp, dashboard.meta.today);
    const activeItems = makeSourceItems(dashboard);
    const activeKeys = new Set(activeItems.map((item) => item.dedupe_key));

    for (const item of activeItems) {
      const existing = selectByKey.get(item.dedupe_key);
      if (!existing) {
        insertItem.run(
          item.dedupe_key,
          item.source_type,
          item.source_id,
          item.category,
          item.severity,
          item.title,
          item.summary,
          item.action_label,
          item.action_url,
          item.due_at || null,
          JSON.stringify(item.metadata || {}),
          stamp,
          stamp,
        );
        continue;
      }
      const contentChanged =
        existing.title !== item.title ||
        existing.summary !== item.summary ||
        existing.action_url !== item.action_url;
      const nextReadAt = contentChanged ? null : existing.read_at || null;
      const nextStatus =
        existing.status === 'resolved' ? 'active' : existing.status;
      const nextResolvedAt =
        nextStatus === 'resolved' ? existing.resolved_at : null;
      updateItem.run(
        item.source_type,
        item.source_id,
        item.category,
        item.severity,
        item.title,
        item.summary,
        item.action_label,
        item.action_url,
        item.due_at || null,
        JSON.stringify(item.metadata || {}),
        stamp,
        nextReadAt,
        existing.id,
      );
      if (existing.status === 'resolved') {
        updateState.run(
          'active',
          nextReadAt,
          null,
          null,
          stamp,
          existing.id,
        );
      } else if (nextStatus === 'active' && existing.status === 'snoozed') {
        updateState.run(
          'active',
          nextReadAt,
          null,
          nextResolvedAt,
          stamp,
          existing.id,
        );
      }
    }

    for (const row of selectAll.all()) {
      if (row.status === 'resolved' || activeKeys.has(row.dedupe_key)) continue;
      resolveItem.run(stamp, stamp, row.id);
    }
    return getWorkspace(dashboard.meta.today);
  }

  function getWorkspace(today) {
    const stamp = new Date().toISOString();
    promoteSnoozed.run(stamp, today);
    const items = selectAll.all().map(mapItem);
    const visible = items.filter((item) => item.status !== 'resolved');
    const pending = visible.filter(
      (item) => item.status === 'active' && item.category === 'action',
    );
    const reminders = visible.filter(
      (item) =>
        item.status === 'snoozed' || item.category === 'reminder',
    );
    const handled = items.filter((item) => item.status === 'resolved');
    const bySource = Object.fromEntries(
      SOURCE_ORDER.map((sourceType) => [
        sourceType,
        {
          label: SOURCE_LABELS[sourceType],
          pending: visible.filter(
            (item) =>
              item.status === 'active' && item.source_type === sourceType,
          ).length,
          unread: visible.filter(
            (item) =>
              !item.read_at && item.source_type === sourceType,
          ).length,
        },
      ]),
    );
    return {
      generated_for: today,
      items,
      pending,
      reminders,
      handled,
      summary: {
        pending_count: pending.length,
        reminder_count: reminders.length,
        unread_count: visible.filter((item) => !item.read_at).length,
        urgent_count: pending.filter((item) => item.severity === 'urgent')
          .length,
        handled_count: handled.length,
        by_source: bySource,
      },
    };
  }

  function mark(id, action, input = {}) {
    const row = selectItem.get(id);
    if (!row) return null;
    const stamp = new Date().toISOString();
    if (action === 'read') {
      updateState.run(
        row.status,
        row.read_at || stamp,
        row.snoozed_until,
        row.resolved_at,
        stamp,
        id,
      );
    } else if (action === 'unread') {
      updateState.run(
        row.status,
        null,
        row.snoozed_until,
        row.resolved_at,
        stamp,
        id,
      );
    } else if (action === 'snooze') {
      const until = String(input.until || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
        throw new Error('稍后提醒日期格式应为 YYYY-MM-DD');
      }
      updateState.run(
        'snoozed',
        row.read_at || stamp,
        until,
        null,
        stamp,
        id,
      );
    } else if (action === 'unsnooze') {
      updateState.run(
        'active',
        row.read_at,
        null,
        null,
        stamp,
        id,
      );
    } else {
      throw new Error('消息操作不正确');
    }
    return mapItem(selectItem.get(id));
  }

  function markAllRead() {
    const stamp = new Date().toISOString();
    markAllReadStatement.run(stamp, stamp);
    return selectAll.all().map(mapItem);
  }

  return {
    sync,
    getWorkspace,
    mark,
    markAllRead,
  };
}

module.exports = {
  INBOX_SCHEMA,
  SOURCE_LABELS,
  createInboxCenter,
  makeSourceItems,
};
