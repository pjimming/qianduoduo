'use strict';

const path = require('node:path');
const { listBackups } = require('../../../lib/backup');
const {
  TARGET_ANNUALIZED,
  buildReview,
  buildWindows,
  enrichRecords,
  shiftDate,
  summarize,
  todayShanghai,
} = require('../../../lib/metrics');
const { buildProductView } = require('../../../lib/products');
const { buildHoldingReviews } = require('../../../lib/holdings-review');

function createDashboardQueryService(repository, options = {}) {
  if (!repository) throw new Error('dashboard 查询服务需要 repository');
  const todayProvider = options.todayProvider || todayShanghai;
  const automationRunner = options.automationRunner || null;

  function readDashboard(today = todayProvider()) {
    const rawRecords = repository.listRecords();
    const records = enrichRecords(rawRecords);
    const tradeOverview = repository.tradeStore.getOverview(today);
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
    return readDashboard(today).workspace;
  }

  return {
    getDashboard: readDashboard,
    getWorkspace,
    projectDashboard,
  };
}

module.exports = {
  createDashboardQueryService,
};
