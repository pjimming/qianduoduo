'use strict';

const path = require('node:path');
const { shiftDate, todayShanghai } = require('../../../lib/metrics');

function incomeError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeApplyInput(body = {}) {
  const products = Array.isArray(body.products)
    ? body.products.map((item) => ({
        ...item,
        daily_pnl:
          item.daily_pnl === undefined || item.daily_pnl === null
            ? null
            : Number(item.daily_pnl),
        holding_amount:
          item.holding_amount === undefined ||
          item.holding_amount === null ||
          item.holding_amount === ''
            ? null
            : Number(item.holding_amount),
        confidence:
          item.confidence === undefined || item.confidence === null
            ? undefined
            : Number(item.confidence),
      }))
    : undefined;
  if (
    body.clear_coverage === true &&
    ((Array.isArray(body.covered_yield_dates) &&
      body.covered_yield_dates.length) ||
      body.coverage_start_date ||
      body.coverage_end_date)
  ) {
    throw new Error('不能同时撤回并新增收益覆盖日期');
  }
  const hasRootCoverage = Boolean(
    body.clear_coverage === true ||
      (Array.isArray(body.covered_yield_dates) &&
        body.covered_yield_dates.length) ||
      body.coverage_start_date ||
      body.coverage_end_date,
  );
  if (hasRootCoverage && (products?.length || 0) > 1) {
    throw new Error('多产品收益截图需要在各产品明细中分别提供覆盖日期');
  }
  if (body.clear_coverage === true && products?.length === 1) {
    products[0].clear_coverage = true;
  } else if (
    products?.length === 1 &&
    !products[0].covered_yield_dates?.length &&
    Array.isArray(body.covered_yield_dates) &&
    body.covered_yield_dates.length
  ) {
    products[0].covered_yield_dates = body.covered_yield_dates;
  } else if (
    products?.length === 1 &&
    !products[0].covered_yield_dates?.length &&
    (body.coverage_start_date || body.coverage_end_date)
  ) {
    products[0].coverage_start_date = body.coverage_start_date;
    products[0].coverage_end_date = body.coverage_end_date;
  }
  return {
    date: body.date,
    daily_pnl:
      body.daily_pnl === undefined || body.daily_pnl === null
        ? undefined
        : Number(body.daily_pnl),
    products,
    covered_yield_dates: Array.isArray(body.covered_yield_dates)
      ? body.covered_yield_dates
      : undefined,
    coverage_start_date: body.coverage_start_date,
    coverage_end_date: body.coverage_end_date,
    clear_coverage: body.clear_coverage === true ? true : undefined,
    action: body.action,
    notes: body.notes,
  };
}

function createIncomeService({
  incomeRepository,
  dashboardQuery,
  ocr,
  todayProvider = todayShanghai,
}) {
  if (!incomeRepository || !dashboardQuery || !ocr) {
    throw new Error('income service 需要 repository、dashboard 和 OCR');
  }

  function list() {
    return { inbox: incomeRepository.listInbox() };
  }

  function prune(body) {
    const olderThanDays = Number(body.olderThanDays || 180);
    if (
      !Number.isInteger(olderThanDays) ||
      olderThanDays < 30 ||
      olderThanDays > 3650
    ) {
      throw incomeError(400, '保留天数需要是 30–3650 的整数');
    }
    const result = incomeRepository.pruneScreenshots({
      today: todayProvider(),
      olderThanDays,
    });
    dashboardQuery.projectDashboard();
    return result;
  }

  async function upload(decoded) {
    const saved = incomeRepository.saveInboxImage({
      buffer: decoded.buffer,
      mime: decoded.mime,
      originalName: decoded.original_name,
    });
    if (saved.duplicate) {
      return {
        statusCode: 200,
        body: {
          inbox: saved.item,
          duplicate: true,
          saved_valuations: [],
          valuation_conflicts: [],
          missing_product_codes: [],
          reconciliation: null,
          dashboard: dashboardQuery.projectDashboard(),
        },
      };
    }
    const storedPath = path.join(
      incomeRepository.inboxDir,
      saved.item.stored_name,
    );
    const today = todayProvider();
    const ocrResult = await ocr.read(storedPath, {
      today,
      reportingDate: shiftDate(today, -1),
      products: incomeRepository.getPortfolio
        ? incomeRepository.getPortfolio()
        : [],
    });
    const parsed = ocrResult.parsed;
    const threshold = incomeRepository.getAutoConfidenceThreshold();
    const hasExplicitAccountPnl =
      parsed.daily_pnl !== null && parsed.daily_pnl !== undefined;
    const hasProductDetails =
      Array.isArray(parsed.products) &&
      parsed.products.some(
        (item) =>
          String(item.product_code || '').trim() &&
          item.daily_pnl !== null &&
          item.daily_pnl !== undefined &&
          Number.isFinite(Number(item.daily_pnl)),
      );
    const hasPostableFacts = hasExplicitAccountPnl || hasProductDetails;
    const workflowState =
      ocrResult.ok && hasPostableFacts
        ? parsed.confidence >= threshold
          ? 'ready_to_post'
          : 'needs_correction'
        : 'needs_correction';
    let item = incomeRepository.withDataTrustTransaction(() => {
      const created = incomeRepository.addInbox({
        original_name: saved.item.original_name,
        stored_name: saved.item.stored_name,
        mime: saved.item.mime,
        bytes: saved.item.bytes,
        sha256: saved.sha256,
        ocr_text: ocrResult.text,
        parsed,
        parse_confidence: parsed.confidence,
        record_date: parsed.date,
        error: ocrResult.ok ? '' : ocrResult.error,
      });
      incomeRepository.registerInboxEvidence(created.id, {
        workflowState,
        actorType: 'ocr',
        actorRef: ocrResult.language || 'windows-ocr',
        requestId: `income-upload:${created.id}`,
        events: [
          {
            event_type: 'ocr_completed',
            actor_type: 'ocr',
            actor_ref: ocrResult.language || 'windows-ocr',
            payload: {
              ok: ocrResult.ok,
              text: ocrResult.text || '',
              error: ocrResult.error || '',
              language: ocrResult.language || null,
            },
            dedupe_key: `ocr:${saved.sha256}`,
            created_at: new Date().toISOString(),
          },
          {
            event_type: 'machine_parsed',
            actor_type: 'ocr',
            actor_ref: ocrResult.language || 'windows-ocr',
            payload: parsed,
            confidence: parsed.confidence,
            dedupe_key: `machine-parsed:${saved.sha256}:v1`,
            created_at: new Date().toISOString(),
          },
          ...(ocrResult.ok
            ? []
            : [
                {
                  event_type: 'failed',
                  actor_type: 'ocr',
                  actor_ref: ocrResult.language || 'windows-ocr',
                  payload: {
                    stage: 'ocr',
                    error: ocrResult.error || 'OCR 识别失败',
                    retryable: true,
                  },
                  dedupe_key: `ocr-failed:${saved.sha256}`,
                  created_at: new Date().toISOString(),
                },
              ]),
        ],
      });
      return incomeRepository.getInboxItem(created.id);
    });
    let record = null;
    let autoApplied = false;
    let applyError = '';
    let savedValuations = [];
    let valuationConflicts = [];
    let missingProductCodes = parsed.missing_product_codes || [];
    let reconciliation = null;
    let incomeConflict = null;
    let incomeIgnored = false;
    if (ocrResult.ok && hasPostableFacts && parsed.confidence >= threshold) {
      try {
        const applied = incomeRepository.applyIncomeScreenshot(item.id, parsed, {
          today,
          actorType: 'ocr',
          actorRef: ocrResult.language || 'windows-ocr',
          correction: false,
          operationId: `income-auto:${item.id}:${item.selected_event_id}`,
        });
        item = applied.inbox;
        record = applied.conflict ? null : applied.record;
        savedValuations = applied.saved_valuations || [];
        valuationConflicts = applied.valuation_conflicts || [];
        missingProductCodes = applied.missing_product_codes || [];
        reconciliation = applied.reconciliation || null;
        incomeConflict = applied.conflict || null;
        incomeIgnored = Boolean(applied.ignored);
        autoApplied = !applied.conflict;
        applyError = applied.conflict
          ? '该日期已有不同收益，平台未覆盖；请在消息中心核对后人工修改。'
          : '';
      } catch (error) {
        applyError = error instanceof Error ? error.message : String(error);
        item = incomeRepository.updateInbox(item.id, { error: applyError });
      }
    }
    return {
      statusCode: 201,
      body: {
        inbox: item,
        record,
        duplicate: false,
        auto_applied: autoApplied,
        apply_error: applyError,
        saved_valuations: savedValuations,
        valuation_conflicts: valuationConflicts,
        missing_product_codes: missingProductCodes,
        reconciliation,
        income_conflict: incomeConflict,
        income_ignored: incomeIgnored,
        ocr: {
          ok: ocrResult.ok,
          language: ocrResult.language,
          error: ocrResult.error,
        },
        dashboard: dashboardQuery.projectDashboard(),
      },
    };
  }

  function apply(id, body) {
    const current = incomeRepository.getInboxItem(id);
    let result;
    try {
      result = incomeRepository.applyIncomeScreenshot(
        id,
        normalizeApplyInput(body),
        {
          today: todayProvider(),
          actorType: 'human',
          actorRef: 'income-apply',
          reason: '页面人工校正并确认收益截图',
          operationId: current
            ? `income-manual:${id}:${current.selected_event_id || 'legacy'}:${Date.now()}`
            : `income-manual:${id}`,
        },
      );
    } catch (error) {
      throw incomeError(400, error.message);
    }
    if (!result) throw incomeError(404, '没有找到这张收益截图');
    return {
      ...result,
      dashboard: dashboardQuery.projectDashboard(),
    };
  }

  function ignore(id, body) {
    const inbox = incomeRepository.ignoreInbox(
      id,
      String(body.note || '忽略收益截图'),
    );
    if (!inbox) throw incomeError(404, '没有找到这张收益截图');
    return {
      inbox,
      dashboard: dashboardQuery.projectDashboard(),
    };
  }

  return {
    apply,
    getImage: (id) => incomeRepository.getInboxFilePath(id),
    ignore,
    list,
    prune,
    upload,
  };
}

module.exports = {
  createIncomeService,
};
