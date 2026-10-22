'use strict';

const { todayShanghai } = require('../../../lib/metrics');
const { shiftMonth } = require('../../../lib/review-store');
const { buildMonthlyReviewMarkdown } = require('./export');
const {
  validateProductEventPayload,
  validateReviewNotePayload,
} = require('./validation');

function reviewError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createReviewsService({
  reviewsRepository,
  dashboardQuery,
  transactionManager,
  todayProvider = todayShanghai,
  now = () => new Date(),
}) {
  function eventValue(body) {
    const result = validateProductEventPayload(body);
    if (result.error) throw reviewError(400, result.error);
    return result.value;
  }

  function createEvent(body) {
    return {
      event: reviewsRepository.createProductEvent(eventValue(body)),
      dashboard: dashboardQuery.getDashboard(),
    };
  }

  function updateEvent(id, body) {
    const event = reviewsRepository.updateProductEvent(
      id,
      eventValue(body),
    );
    if (!event) throw reviewError(404, '没有找到这条产品事件');
    return {
      event,
      dashboard: dashboardQuery.getDashboard(),
    };
  }

  function deleteEvent(id) {
    if (!reviewsRepository.deleteProductEvent(id)) {
      throw reviewError(404, '没有找到这条产品事件');
    }
    return {
      deleted: true,
      dashboard: dashboardQuery.getDashboard(),
    };
  }

  function saveNote(period, body, count, label) {
    const result = validateReviewNotePayload(
      body,
      period,
      count,
      label,
    );
    if (result.error) throw reviewError(400, result.error);
    return result.value;
  }

  function saveMonthlyNote(month, body) {
    return {
      note: reviewsRepository.saveReviewNote(
        month,
        saveNote(month, body, 5, '月度五问'),
      ),
      dashboard: dashboardQuery.getDashboard(),
    };
  }

  function saveQuarterlyNote(quarter, body) {
    return {
      note: reviewsRepository.saveQuarterlyNote(
        quarter,
        saveNote(quarter, body, 6, '季度清单'),
      ),
      dashboard: dashboardQuery.getDashboard(),
    };
  }

  function exportReview(month) {
    const selectedMonth = month || shiftMonth(todayProvider(), -1);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(selectedMonth)) {
      throw reviewError(400, '月份格式应为 YYYY-MM');
    }
    const payload = dashboardQuery.getDashboard();
    const markdown = buildMonthlyReviewMarkdown({
      month: selectedMonth,
      review: payload.review,
      decisions: payload.workspace.decisions.filter((item) =>
        item.date.startsWith(selectedMonth),
      ),
      events: payload.workspace.events.filter((item) =>
        item.date.startsWith(selectedMonth),
      ),
      note: reviewsRepository.getReviewNote(selectedMonth),
      holdings: payload.workspace.holdings,
      holdingsSummary: payload.workspace.holdings_summary,
      generatedAt: new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(now()),
    });
    return {
      markdown,
      filename: `r2-review-${selectedMonth}.md`,
      month: selectedMonth,
    };
  }

  function parseDraftRequest(periodType, period, action) {
    const validPeriod =
      periodType === 'monthly'
        ? /^\d{4}-(0[1-9]|1[0-2])$/.test(period)
        : /^\d{4}-Q[1-4]$/.test(period);
    if (!validPeriod) throw reviewError(400, '复盘周期格式不正确');
    return { periodType, period, action };
  }

  function getDraft(periodType, period) {
    return {
      draft: reviewsRepository.getDraft(periodType, period),
    };
  }

  function generateDraft(periodType, period) {
    const draft = reviewsRepository.generateDraft(periodType, period);
    return {
      draft,
      automation: reviewsRepository.getWorkspace(todayProvider()),
    };
  }

  function confirmDraft(periodType, period, body) {
    let result;
    try {
      result = transactionManager.run(() =>
        reviewsRepository.confirmDraft(periodType, period, {
          answers: body.answers,
          conclusion: body.conclusion,
        }),
      );
    } catch (error) {
      throw reviewError(400, error.message);
    }
    return {
      ...result,
      dashboard: dashboardQuery.getDashboard(),
    };
  }

  return {
    confirmDraft,
    createEvent,
    deleteEvent,
    exportReview,
    generateDraft,
    getDraft,
    parseDraftRequest,
    saveMonthlyNote,
    saveQuarterlyNote,
    updateEvent,
  };
}

module.exports = {
  createReviewsService,
};
