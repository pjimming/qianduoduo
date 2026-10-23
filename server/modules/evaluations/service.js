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
  automationRunner = null,
  todayProvider = todayShanghai,
}) {
  function automationWorkspace(today = todayProvider()) {
    return {
      ...evaluationsRepository.getWorkspace(today),
      runner: automationRunner?.getStatus?.() || null,
    };
  }

  function workspace() {
    return {
      automation: automationWorkspace(),
    };
  }

  function calibration(month) {
    const value = String(
      month || todayProvider().slice(0, 7),
    ).trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
      throw evaluationError(400, '校准月份格式应为 YYYY-MM');
    }
    return evaluationsRepository.getCalibration(
      value,
      todayProvider(),
    );
  }

  function calibrationPrediction(id) {
    const value = decodeURIComponent(String(id || '')).trim();
    if (!value || value.length > 220) {
      throw evaluationError(400, '预测 ID 不正确');
    }
    const prediction = evaluationsRepository.getCalibrationPrediction(
      value,
      todayProvider(),
    );
    if (!prediction) {
      throw evaluationError(404, '没有找到这条预测');
    }
    return prediction;
  }

  function confirmCalibrationPrediction(id, body) {
    const value = decodeURIComponent(String(id || '')).trim();
    if (!value) throw evaluationError(400, '预测 ID 不正确');
    let result;
    try {
      result = evaluationsRepository.confirmCalibrationPrediction(value, {
        status: String(body.status || '').trim(),
        note: body.note,
      });
    } catch (error) {
      throw evaluationError(400, error.message);
    }
    if (!result) throw evaluationError(404, '没有找到这条预测');
    dashboardQuery.projectDashboard();
    return {
      result,
      prediction: evaluationsRepository.getCalibrationPrediction(
        value,
        todayProvider(),
      ),
      automation: automationWorkspace(),
    };
  }

  async function run() {
    const today = todayProvider();
    const result = automationRunner
      ? await automationRunner.run({
          today,
          trigger: 'manual',
        })
      : evaluationsRepository.runCycle({
          today,
          trigger: 'manual',
        });
    return {
      statusCode: result.ok || result.skipped ? 200 : 500,
      body: {
        ...result,
        automation: automationWorkspace(today),
        dashboard: dashboardQuery.projectDashboard(),
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
      automation: automationWorkspace(),
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
      automation: automationWorkspace(),
      dashboard: dashboardQuery.projectDashboard(),
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
      automation: automationWorkspace(),
      dashboard: dashboardQuery.projectDashboard(),
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
    dashboardQuery.projectDashboard();
    return {
      job,
      automation: automationWorkspace(),
    };
  }

  return {
    applyRun,
    calibration,
    calibrationPrediction,
    confirmCalibrationPrediction,
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
