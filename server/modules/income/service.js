'use strict';

const path = require('node:path');
const { shiftDate, todayShanghai } = require('../../../lib/metrics');

function incomeError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeApplyInput(body = {}) {
  return {
    date: body.date,
    daily_pnl:
      body.daily_pnl === undefined || body.daily_pnl === null
        ? undefined
        : Number(body.daily_pnl),
    products: Array.isArray(body.products)
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
      : undefined,
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
    return incomeRepository.pruneScreenshots({
      today: todayProvider(),
      olderThanDays,
    });
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
          dashboard: dashboardQuery.getDashboard(),
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
    let item = incomeRepository.addInbox({
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
    let record = null;
    let autoApplied = false;
    let applyError = '';
    let savedValuations = [];
    let valuationConflicts = [];
    let missingProductCodes = parsed.missing_product_codes || [];
    let reconciliation = null;
    let incomeConflict = null;
    let incomeIgnored = false;
    const threshold = incomeRepository.getAutoConfidenceThreshold();
    if (ocrResult.ok && parsed.daily_pnl !== null && parsed.confidence >= threshold) {
      try {
        const applied = incomeRepository.applyIncomeScreenshot(item.id, parsed, {
          today,
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
        dashboard: dashboardQuery.getDashboard(),
      },
    };
  }

  function apply(id, body) {
    let result;
    try {
      result = incomeRepository.applyIncomeScreenshot(
        id,
        normalizeApplyInput(body),
        { today: todayProvider() },
      );
    } catch (error) {
      throw incomeError(400, error.message);
    }
    if (!result) throw incomeError(404, '没有找到这张收益截图');
    return {
      ...result,
      dashboard: dashboardQuery.getDashboard(),
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
      dashboard: dashboardQuery.getDashboard(),
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
