'use strict';

const path = require('node:path');
const { listBackups } = require('../../../lib/backup');
const {
  TARGET_ANNUALIZED,
  buildHoldingAmountsByDate,
  buildReview,
  buildWindows,
  enrichRecords,
  shiftDate,
  summarize,
  todayShanghai,
} = require('../../../lib/metrics');
const { buildProductView } = require('../../../lib/products');
const { buildHoldingReviews } = require('../../../lib/holdings-review');

const DASHBOARD_SECTIONS = Object.freeze([
  'summary',
  'overview',
  'ledger',
  'trades',
  'products',
  'evaluation',
  'inbox',
]);
const DASHBOARD_SECTION_SET = new Set(DASHBOARD_SECTIONS);

function mergeSectionData(target, source) {
  const output =
    target && typeof target === 'object' && !Array.isArray(target)
      ? { ...target }
      : {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return output;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      output[key] &&
      typeof output[key] === 'object' &&
      !Array.isArray(output[key])
    ) {
      output[key] = mergeSectionData(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function selectDashboardSection(payload, section) {
  const workspace = payload.workspace || {};
  switch (section) {
    case 'summary':
      return {
        meta: payload.meta,
        summary: payload.summary,
        windows: payload.windows,
        capital: payload.capital,
        inbox_center: {
          summary: payload.inbox_center.summary,
        },
      };
    case 'overview':
      return {
        meta: payload.meta,
        records: payload.records,
        summary: payload.summary,
        windows: payload.windows,
        capital: payload.capital,
        workspace: {
          current_holdings_valuation: workspace.current_holdings_valuation,
          trades: workspace.trades
            ? {
                summary: workspace.trades.summary,
              }
            : null,
          events: workspace.events,
        },
        automation: {
          pending_evaluations: payload.automation.pending_evaluations,
        },
        decision_proposals: {
          summary: payload.decision_proposals.summary,
        },
        inbox_center: {
          summary: payload.inbox_center.summary,
        },
      };
    case 'ledger':
      return {
        meta: payload.meta,
        records: payload.records,
        summary: payload.summary,
        windows: payload.windows,
        review: payload.review,
        capital: payload.capital,
      };
    case 'trades':
      return {
        meta: payload.meta,
        workspace: {
          current_holdings_valuation: workspace.current_holdings_valuation,
          holdings: workspace.holdings,
          holdings_summary: workspace.holdings_summary,
          trades: workspace.trades,
          timeline: workspace.timeline,
          product_valuation_summary: workspace.product_valuation_summary,
          product_valuation_summaries: workspace.product_valuation_summaries,
          product_valuation_reconciliation:
            workspace.product_valuation_reconciliation,
          product_valuation_disclosure_policy:
            workspace.product_valuation_disclosure_policy,
        },
      };
    case 'products':
      return {
        meta: payload.meta,
        products: payload.products,
        workspace: {
          holding_reviews: workspace.holding_reviews,
          holding_reviews_summary: workspace.holding_reviews_summary,
          events: workspace.events,
          timeline: workspace.timeline,
        },
        inbox_center: {
          summary: payload.inbox_center.summary,
        },
      };
    case 'evaluation':
      return {
        meta: payload.meta,
        workspace: {
          decisions: workspace.decisions,
          notes: workspace.notes,
          quarterly: workspace.quarterly,
          events: workspace.events,
          timeline: workspace.timeline,
          trades: workspace.trades,
        },
        automation: payload.automation,
        decision_proposals: payload.decision_proposals,
      };
    case 'inbox':
      return {
        meta: payload.meta,
        workspace: {
          income_inbox: workspace.income_inbox,
          income_summary: workspace.income_summary,
        },
        inbox_center: payload.inbox_center,
      };
    default:
      throw new Error(`未知 Dashboard 分区：${section}`);
  }
}

function createDashboardQueryService(repository, options = {}) {
  if (!repository) throw new Error('dashboard 查询服务需要 repository');
  const todayProvider = options.todayProvider || todayShanghai;
  const automationRunner = options.automationRunner || null;

  function readDashboard(today = todayProvider()) {
    const rawRecords = repository.listRecords();
    const tradeOverview = repository.tradeStore.getOverview(today);
    const holdingAmountsByDate = buildHoldingAmountsByDate(
      rawRecords,
      tradeOverview.trades,
    );
    const records = enrichRecords(rawRecords, { holdingAmountsByDate });
    const currentHoldingsValuation =
      repository.holdingValuationStore.getCurrent(
        today,
        tradeOverview.holdings,
      );
    const incomeDisclosurePolicy =
      repository.productValuationStore.getDisclosurePolicy(
        today,
        tradeOverview.holdings,
      );
    const reportingDate = shiftDate(today, -1);
    const todayRecord =
      rawRecords.find((record) => record.date === today) || null;
    const reportingRecord =
      rawRecords.find((record) => record.date === reportingDate) || null;
    const capital = repository.getCapitalState(today);
    const allocationSettings = repository.getAllocationSettings();
    const principal =
      allocationSettings.principal_override ??
      (Number.isFinite(capital.current_principal)
        ? capital.current_principal
        : 0);
    const decisions = repository.listDecisions();
    const productView = buildProductView(repository.listProducts(), {
      principal,
      settings: allocationSettings,
      decisions,
      holdings: tradeOverview.holdings,
      pending_trades: tradeOverview.trades.filter(
        (item) => item.status === 'pending',
      ),
    });
    const snapshotDate =
      productView.all
        .map((product) => product.data_date)
        .filter(Boolean)
        .sort()
        .at(-1) || null;
    const historyDate =
      productView.all
        .filter((product) => product.return_1y !== null)
        .map((product) => product.data_date)
        .filter(Boolean)
        .sort()
        .at(-1) || snapshotDate;
    const backups = repository.backupDir
      ? listBackups(repository.backupDir)
      : [];
    const review = buildReview(records, today, {
      initialDate: capital.initial_date,
      reportingDate,
      reportingLagDays: 1,
    });
    const holdingReviewSettings = Object.fromEntries(
      repository
        .listHoldingReviewSettings()
        .map((setting) => [setting.product_code, setting]),
    );
    const holdingReviews = buildHoldingReviews({
      holdings: tradeOverview.holdings,
      products: productView.all,
      universe: repository.listProducts(),
      principal,
      settingsByCode: holdingReviewSettings,
      quotaByCode: allocationSettings.quota_by_code || {},
      today,
      snapshotDate: snapshotDate || '',
      decisions,
    });
    const workspace = repository.getReviewWorkspace({
      today,
      reportingDate,
      records,
      review,
      trades: tradeOverview,
    });
    workspace.current_holdings_valuation = currentHoldingsValuation;
    workspace.holding_reviews = holdingReviews;
    workspace.holding_reviews_summary = {
      total: holdingReviews.length,
      replace: holdingReviews.filter((item) => item.verdict === 'replace')
        .length,
      watch: holdingReviews.filter((item) => item.verdict === 'watch').length,
      hold: holdingReviews.filter((item) => item.verdict === 'hold').length,
      window: holdingReviews.filter(
        (item) => item.reminder.level !== 'none',
      ).length,
    };
    workspace.income_inbox = repository.listIncomeScreenshots();
    workspace.income_summary = {
      pending: workspace.income_inbox.filter(
        (item) => item.status === 'pending',
      ).length,
      applied: workspace.income_inbox.filter(
        (item) => item.status === 'applied',
      ).length,
      latest_date:
        workspace.income_inbox
          .filter(
            (item) => item.status === 'applied' && item.record_date,
          )
          .map((item) => item.record_date)
          .sort()
          .at(-1) || null,
    };
    Object.assign(
      workspace,
      repository.productValuationStore.getWorkspace(
        today,
        tradeOverview.holdings,
      ),
    );
    for (const item of holdingReviews) {
      if (item.reminder.level === 'none') continue;
      workspace.holdings_summary.alerts.push({
        level: item.reminder.level === 'urgent' ? 'warn' : 'info',
        code: `review-${item.product_code}`,
        text: `${item.product_name}：${item.reminder.text}`,
      });
    }

    const automation = {
      ...repository.automationStore.getWorkspace(today),
      ...(automationRunner
        ? { runner: automationRunner.getStatus() }
        : {}),
    };
    const payload = {
      meta: {
        today,
        reporting_date: reportingDate,
        reporting_lag_days: 1,
        recording_date_source: 'user-provided',
        income_disclosure_policy: incomeDisclosurePolicy,
        target_annualized: TARGET_ANNUALIZED,
        has_today_record: Boolean(todayRecord),
        today_record: todayRecord,
        has_reporting_record: Boolean(reportingRecord),
        reporting_record: reportingRecord,
        product_snapshot_date: snapshotDate,
        product_history_date: historyDate,
        product_csv: repository.productCsvPath
          ? path.basename(repository.productCsvPath)
          : null,
        latest_backup: backups[0]
          ? { date: backups[0].date, bytes: backups[0].bytes }
          : null,
        storage: 'SQLite · 本地',
      },
      records,
      summary: summarize(records),
      windows: buildWindows(records),
      review,
      workspace,
      automation,
      capital,
      products: productView,
    };
    payload.decision_proposals =
      repository.decisionProposalStore.getWorkspace(today);
    payload.inbox_center = repository.inboxCenter.getWorkspace(today);
    return payload;
  }

  function projectDashboard(today = todayProvider()) {
    return repository.transactionManager.run(() => {
      let payload = readDashboard(today);
      repository.decisionProposalStore.sync(payload);
      payload = readDashboard(today);
      repository.inboxCenter.sync(payload);
      payload = readDashboard(today);
      repository.automationStore.resolveCapitalBridgeNotifications(payload);
      repository.automationStore.resolveProductIncomeNotifications();
      payload = readDashboard(today);
      payload.inbox_center = repository.inboxCenter.sync(payload);
      return payload;
    });
  }

  function getWorkspace(today = todayProvider()) {
    return getSections(['trades', 'products', 'evaluation', 'inbox'], today)
      .workspace;
  }

  function normalizeSections(sections) {
    const requested = Array.isArray(sections)
      ? sections
      : String(sections || '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
    const normalized = [...new Set(requested)];
    const invalid = normalized.filter(
      (section) => !DASHBOARD_SECTION_SET.has(section),
    );
    if (invalid.length) {
      const error = new Error(
        `未知 Dashboard 分区：${invalid.join(', ')}`,
      );
      error.statusCode = 400;
      throw error;
    }
    if (!normalized.length) {
      const error = new Error('至少选择一个 Dashboard 分区');
      error.statusCode = 400;
      throw error;
    }
    return normalized;
  }

  function getSection(section, today = todayProvider()) {
    const [normalized] = normalizeSections([section]);
    return selectDashboardSection(readDashboard(today), normalized);
  }

  function getSections(sections, today = todayProvider()) {
    const normalized = normalizeSections(sections);
    const dashboard = readDashboard(today);
    return normalized.reduce(
      (result, section) =>
        mergeSectionData(
          result,
          selectDashboardSection(dashboard, section),
        ),
      {},
    );
  }

  return {
    DASHBOARD_SECTIONS,
    getDashboard: readDashboard,
    getSection,
    getSections,
    getWorkspace,
    projectDashboard,
  };
}

module.exports = {
  DASHBOARD_SECTIONS,
  createDashboardQueryService,
  mergeSectionData,
  selectDashboardSection,
};
