'use strict';

const { todayShanghai } = require('../../../lib/metrics');
const { DAILY_OPEN_TARGET_PCT } = require('../../../lib/r2-policy');

const DECISION_RATINGS = new Set([
  '待评估',
  '流程正确，结果好',
  '流程正确，结果差',
  '流程错误，结果好',
  '流程错误，结果差',
]);

function evaluationError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createEvaluationsService({
  evaluationsRepository,
  dashboardQuery,
  transactionManager,
  todayProvider = todayShanghai,
}) {
  function workspace() {
    return {
      automation: evaluationsRepository.getWorkspace(todayProvider()),
    };
  }

  function run() {
    const today = todayProvider();
    const result = evaluationsRepository.runCycle({
      today,
      trigger: 'manual',
    });
    return {
      statusCode: result.ok ? 200 : 500,
      body: {
        ...result,
        automation: evaluationsRepository.getWorkspace(today),
        dashboard: dashboardQuery.getDashboard(),
      },
    };
  }

  function updateSettings(body) {
    if (
      body.daily_open_target_pct !== undefined &&
      Number(body.daily_open_target_pct) !== DAILY_OPEN_TARGET_PCT
    ) {
      throw evaluationError(
        400,
        `本项目新增日开额度固定为 ${DAILY_OPEN_TARGET_PCT}%`,
      );
    }
    const numericRules = {
      target_annualized: [0.1, 20],
      hurdle_short: [0, 20],
      hurdle_medium: [0, 20],
      hurdle_long: [0, 20],
      liquidity_floor_pct: [0, 100],
      single_product_cap_pct: [0, 100],
      bucket_tolerance_pp: [0, 100],
      auto_confidence_threshold: [0, 100],
      scheduler_minutes: [1, 1440],
    };
    const patch = {};
    for (const [key, range] of Object.entries(numericRules)) {
      if (body[key] === undefined) continue;
      const value = Number(body[key]);
      if (
        !Number.isFinite(value) ||
        value < range[0] ||
        value > range[1]
      ) {
        throw evaluationError(
          400,
          `${key} 需要在 ${range[0]}–${range[1]} 之间`,
        );
      }
      patch[key] = value;
    }
    for (const key of [
      'automation_enabled',
      'notifications_enabled',
      'auto_confirm_reviews',
    ]) {
      if (body[key] !== undefined) patch[key] = Boolean(body[key]);
    }
    for (const key of ['rule_version', 'strategy_version']) {
      if (body[key] !== undefined) {
        const value = String(body[key]).trim();
        if (!value || value.length > 60) {
          throw evaluationError(
            400,
            `${key} 不能为空或超过 60 个字符`,
          );
        }
        patch[key] = value;
      }
    }
    return {
      settings: evaluationsRepository.updateSettings(patch),
      automation: evaluationsRepository.getWorkspace(todayProvider()),
    };
  }

  function applyRun(id, body) {
    let rating = null;
    if (body.rating !== undefined) {
      rating = String(body.rating).trim();
      if (!DECISION_RATINGS.has(rating)) {
        throw evaluationError(400, '评估结论不在允许范围内');
      }
    }
    let evaluation;
    try {
      evaluation = transactionManager.run(() =>
        evaluationsRepository.forceApplyRun(id, {
          rating,
          summary: body.summary ? String(body.summary) : null,
        }),
      );
    } catch (error) {
      throw evaluationError(400, error.message);
    }
    if (!evaluation) {
      throw evaluationError(404, '没有找到这条评估');
    }
    return {
      evaluation,
      automation: evaluationsRepository.getWorkspace(todayProvider()),
      dashboard: dashboardQuery.getDashboard(),
    };
  }

  function undoRun(id) {
    let evaluation;
    try {
      evaluation = transactionManager.run(() =>
        evaluationsRepository.undoRun(id),
      );
    } catch (error) {
      throw evaluationError(400, error.message);
    }
    if (!evaluation) {
      throw evaluationError(404, '没有找到这条评估');
    }
    return {
      evaluation,
      automation: evaluationsRepository.getWorkspace(todayProvider()),
      dashboard: dashboardQuery.getDashboard(),
    };
  }

  function resolveJob(id, body) {
    let job;
    try {
      job = evaluationsRepository.resolveJob(id, {
        status: body.status || 'done',
        result: body.result || {},
        note: body.note || '',
      });
    } catch (error) {
      throw evaluationError(400, error.message);
    }
    if (!job) throw evaluationError(404, '没有找到这个任务');
    return {
      job,
      automation: evaluationsRepository.getWorkspace(todayProvider()),
    };
  }

  return {
    applyRun,
    resolveJob,
    run,
    undoRun,
    updateSettings,
    workspace,
  };
}

module.exports = {
  createEvaluationsService,
};
