'use strict';

const path = require('node:path');
const { parseYmd, todayShanghai } = require('../../../lib/metrics');
const {
  validateHoldingPayload,
  validateInboxOverridePayload,
  validateTradePayload,
} = require('./validation');

function tradeError(statusCode, message, payload = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (payload) error.payload = payload;
  return error;
}

function validationValue(result) {
  if (result.error) throw tradeError(400, result.error);
  return result.value;
}

function storeError(error) {
  throw tradeError(
    error.code === 'DUPLICATE_TRADE' ? 409 : 400,
    error.message,
  );
}

function createTradesService({
  tradesRepository,
  dashboardQuery,
  ocr,
  todayProvider = todayShanghai,
}) {
  if (!tradesRepository || !dashboardQuery || !ocr) {
    throw new Error('trades service 需要 repository、dashboard 和 OCR');
  }

  function overview(today = todayProvider()) {
    return tradesRepository.getOverview(today);
  }

  function ensureDecision(fields) {
    if (
      fields.decision_id &&
      !tradesRepository.hasDecision(fields.decision_id)
    ) {
      throw tradeError(400, '关联决策不存在');
    }
  }

  function syncDecisionAndEvaluate(trade, trigger) {
    const today = todayProvider();
    const matched = tradesRepository.matchProposal(trade, today);
    if (matched?.trade) trade = matched.trade;
    tradesRepository.reconcileExecutionStatuses(today);
    tradesRepository.ensureTradeDecisions();
    tradesRepository.runAutomationCycle({ today, trigger });
    tradesRepository.reconcileExecutionStatuses(today);
    return trade?.id ? tradesRepository.getTrade(trade.id) : trade;
  }

  function mutationResult(trade, trigger) {
    trade = syncDecisionAndEvaluate(trade, trigger);
    return {
      trade,
      overview: overview(),
      dashboard: dashboardQuery.getDashboard(),
    };
  }

  function createTrade(body) {
    const value = validationValue(validateTradePayload(body));
    ensureDecision(value);
    let trade;
    try {
      trade = tradesRepository.createTrade(value, '页面手工录入');
    } catch (error) {
      storeError(error);
    }
    return mutationResult(trade, 'trade-create');
  }

  function updateTrade(id, body) {
    const before = tradesRepository.getTrade(id);
    if (!before) throw tradeError(404, '没有找到这笔交易');
    const value = validationValue(
      validateTradePayload({
        ...before,
        ...body,
        trade_date: body.trade_date ?? before.trade_date,
      }),
    );
    ensureDecision(value);
    let trade;
    try {
      trade = tradesRepository.updateTrade(
        id,
        value,
        body.note || '页面修改',
      );
    } catch (error) {
      storeError(error);
    }
    return mutationResult(trade, 'trade-update');
  }

  function confirmTrade(id, body) {
    const today = todayProvider();
    const confirmDate = String(body.confirm_date || today).trim();
    if (!parseYmd(confirmDate)) {
      throw tradeError(400, '确认日期格式应为 YYYY-MM-DD');
    }
    if (confirmDate > today) {
      throw tradeError(400, '确认日期不能晚于今天');
    }
    let trade;
    try {
      trade = tradesRepository.confirmTrade(
        id,
        confirmDate,
        body.note || '页面确认',
      );
    } catch (error) {
      storeError(error);
    }
    if (!trade) throw tradeError(404, '没有找到这笔交易');
    return mutationResult(trade, 'trade-confirm');
  }

  function cancelTrade(id, body) {
    let trade;
    try {
      trade = tradesRepository.cancelTrade(
        id,
        String(body.note || '页面撤销'),
      );
    } catch (error) {
      storeError(error);
    }
    if (!trade) throw tradeError(404, '没有找到这笔交易');
    return mutationResult(trade, 'trade-update');
  }

  function getAudits(id) {
    if (!tradesRepository.getTrade(id)) {
      throw tradeError(404, '没有找到这笔交易');
    }
    return { audits: tradesRepository.getAudits(id) };
  }

  function getInboxItem(id) {
    return tradesRepository.getInboxItem(id);
  }

  function getInboxFilePath(id) {
    return tradesRepository.getInboxFilePath(id);
  }

  async function uploadInbox(decoded) {
    const saved = tradesRepository.saveInboxImage(decoded);
    if (saved.duplicate) {
      return {
        statusCode: 200,
        body: {
          inbox: saved.item,
          duplicate: true,
          overview: overview(),
        },
      };
    }
    const storedPath = path.join(
      tradesRepository.inboxDir,
      saved.item.stored_name,
    );
    let item;
    try {
      item = tradesRepository.withDataTrustTransaction(() => {
        const created = tradesRepository.addInbox({
          original_name: saved.item.original_name,
          stored_name: saved.item.stored_name,
          mime: saved.item.mime,
          bytes: saved.item.bytes,
          sha256: saved.sha256,
          ocr_text: '',
          parsed: {},
          parse_confidence: 0,
          error: '',
        });
        tradesRepository.registerInboxEvidence(created.id, {
          workflowState: 'received',
          actorType: 'human',
          actorRef: 'trade-upload',
          requestId: `trade-upload:${created.id}`,
        });
        return tradesRepository.getInboxItem(created.id);
      });
    } catch (error) {
      const existing = tradesRepository.getInboxByHash(saved.sha256);
      if (
        existing &&
        String(error.message || '').includes(
          'UNIQUE constraint failed: trade_inbox.sha256',
        )
      ) {
        if (existing.stored_name !== saved.item.stored_name) {
          tradesRepository.removeStoredInboxImage(saved.item.stored_name);
        }
        return {
          statusCode: 200,
          body: {
            inbox: existing,
            duplicate: true,
            overview: overview(),
          },
        };
      }
      tradesRepository.removeStoredInboxImage(saved.item.stored_name);
      throw error;
    }
    const today = todayProvider();
    let ocrResult;
    try {
      ocrResult = await ocr.read(storedPath, {
        products: tradesRepository.listProducts(),
        today,
      });
    } catch (error) {
      ocrResult = {
        ok: false,
        text: '',
        language: null,
        error: error instanceof Error ? error.message : String(error),
        parsed: { confidence: 0 },
      };
    }
    tradesRepository.withDataTrustTransaction(() => {
      item = tradesRepository.updateInbox(item.id, {
        parsed: ocrResult.parsed || {},
        ocr_text: ocrResult.text || '',
        parse_confidence: Number(ocrResult.parsed?.confidence || 0),
        error: ocrResult.ok ? '' : ocrResult.error,
        stored_name: saved.item.stored_name,
      });
      tradesRepository.appendInboxEvent(
        item.id,
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
        `trade-upload:${item.id}`,
      );
      tradesRepository.appendInboxEvent(
        item.id,
        {
          event_type: 'machine_parsed',
          actor_type: 'ocr',
          actor_ref: ocrResult.language || 'windows-ocr',
          payload: ocrResult.parsed || {},
          confidence: Number(ocrResult.parsed?.confidence || 0),
          dedupe_key: `machine-parsed:${saved.sha256}:v1`,
          created_at: new Date().toISOString(),
        },
        `trade-upload:${item.id}`,
      );
      if (!ocrResult.ok) {
        tradesRepository.appendInboxEvent(
          item.id,
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
          `trade-upload:${item.id}`,
        );
      }
      tradesRepository.transitionInbox(item.id, {
        toState: 'needs_correction',
        actorType: 'ocr',
        actorRef: ocrResult.language || 'windows-ocr',
        reason: ocrResult.ok
          ? 'OCR 已完成，等待人工核对'
          : 'OCR 失败，等待人工校正',
        requestId: `trade-upload:${item.id}`,
        dedupeKey: `needs-correction:${item.id}`,
      });
      item = tradesRepository.getInboxItem(item.id);
    });
    return {
      statusCode: 201,
      body: {
        inbox: item,
        duplicate: false,
        ocr: {
          ok: ocrResult.ok,
          language: ocrResult.language,
          error: ocrResult.error,
        },
        overview: overview(),
      },
    };
  }

  function applyInboxItem(item, body) {
    const merged = { ...item.parsed, ...body };
    const fields = validationValue(validateTradePayload(merged));
    ensureDecision(fields);
    const requestId = `trade-inbox-apply:${item.id}:${Date.now()}`;
    let result;
    try {
      result = tradesRepository.withDataTrustTransaction(() => {
        if (Object.keys(body).length) {
          const corrected = tradesRepository.appendInboxEvent(
            item.id,
            {
              event_type: 'human_corrected',
              actor_type: 'human',
              actor_ref: 'trade-inbox-apply',
              payload: {
                before: item.parsed || {},
                after: merged,
                reason: String(body.note || '人工校正交易截图'),
              },
              dedupe_key: `human:${requestId}`,
              created_at: new Date().toISOString(),
            },
            requestId,
          );
          if (corrected) {
            tradesRepository.selectInboxEvent(item.id, corrected);
          }
        }
        return tradesRepository.applyInbox(item.id, fields, {
          requestId,
          actorType: 'human',
          actorRef: 'trade-inbox-apply',
        });
      });
    } catch (error) {
      storeError(error);
    }
    result.trade = syncDecisionAndEvaluate(
      result.trade,
      'trade-inbox-apply',
    );
    return {
      ...result,
      overview: overview(),
      dashboard: dashboardQuery.getDashboard(),
    };
  }

  function visionApply(item, body) {
    const fields = validationValue(validateTradePayload(body));
    ensureDecision(fields);
    const parsed = item.parsed || {};
    const checks = [];
    const ocrAmount = Number(parsed.amount);
    if (Number.isFinite(ocrAmount) && ocrAmount > 0) {
      const pass = Math.abs(ocrAmount - fields.amount) <= 0.01;
      checks.push({
        key: 'amount',
        pass,
        ocr: ocrAmount,
        vision: fields.amount,
      });
      if (!pass && body.confirm_mismatch !== true) {
        throw tradeError(
          409,
          'OCR 参考金额与视觉识别金额不一致，请人工确认后重试',
          {
            error: 'OCR 参考金额与视觉识别金额不一致，请人工确认后重试',
            code: 'OCR_AMOUNT_MISMATCH',
            ocr_amount: ocrAmount,
            vision_amount: fields.amount,
            checks,
          },
        );
      }
    } else {
      checks.push({
        key: 'amount',
        pass: null,
        detail: 'OCR 未给出参考金额',
      });
    }
    const ocrCode = String(parsed.product_code || '').toUpperCase();
    if (ocrCode) {
      const pass = ocrCode === fields.product_code.toUpperCase();
      checks.push({
        key: 'product_code',
        pass,
        ocr: ocrCode,
        vision: fields.product_code,
      });
      if (!pass && body.confirm_mismatch !== true) {
        throw tradeError(
          409,
          'OCR 参考代码与视觉识别代码不一致，请人工确认后重试',
          {
            error: 'OCR 参考代码与视觉识别代码不一致，请人工确认后重试',
            code: 'OCR_CODE_MISMATCH',
            ocr_code: ocrCode,
            vision_code: fields.product_code,
            checks,
          },
        );
      }
    } else {
      checks.push({
        key: 'product_code',
        pass: null,
        detail: 'OCR 未识别到产品代码',
      });
    }
    const known = tradesRepository
      .listProducts()
      .find(
        (product) =>
          String(product.code).toUpperCase() ===
          fields.product_code.toUpperCase(),
      );
    checks.push({
      key: 'catalog',
      pass: Boolean(known),
      detail: known ? known.name : '产品库未收录该代码',
    });
    if (!known && body.allow_unknown_code !== true) {
      throw tradeError(
        409,
        '产品库中没有这个代码；如确认无误请允许未收录代码后重试',
        {
          error: '产品库中没有这个代码；如确认无误请允许未收录代码后重试',
          code: 'UNKNOWN_PRODUCT_CODE',
          checks,
        },
      );
    }
    const existing = tradesRepository.findMatchingTrade(fields);
    if (!existing && body.create !== true) {
      throw tradeError(
        409,
        '没有找到匹配的已有交易；如确需新建请显式允许 create',
        {
          error: '没有找到匹配的已有交易；如确需新建请显式允许 create',
          code: 'NO_MATCHING_TRADE',
          checks,
        },
      );
    }
    const confidence = Number(body.confidence);
    const requestId = `trade-inbox-vision:${item.id}:${Date.now()}`;
    let inbox;
    let visionEvent;
    let result;
    try {
      result = tradesRepository.withDataTrustTransaction(() => {
        inbox = tradesRepository.updateInbox(item.id, {
          parsed: {
            ...parsed,
            ...fields,
            ocr_reference: {
              amount: Number.isFinite(ocrAmount) ? ocrAmount : null,
              product_code: ocrCode || '',
            },
            vision: { at: new Date().toISOString(), checks },
          },
          parse_confidence: Number.isFinite(confidence)
            ? Math.max(0, Math.min(100, confidence))
            : 95,
          notes: String(body.note || '视觉识别写入').slice(0, 500),
        });
        visionEvent = tradesRepository.appendInboxEvent(
          item.id,
          {
            event_type: 'vision_parsed',
            actor_type: 'vision-model',
            actor_ref: 'trade-vision-apply',
            payload: {
              fields,
              checks,
            },
            confidence: Number.isFinite(confidence) ? confidence : 95,
            dedupe_key: `vision:${requestId}`,
            created_at: new Date().toISOString(),
          },
          requestId,
        );
        if (visionEvent) {
          tradesRepository.selectInboxEvent(item.id, visionEvent);
        }
        return tradesRepository.applyInbox(item.id, fields, {
          requestId,
          actorType: 'vision-model',
          actorRef: 'trade-vision-apply',
        });
      });
    } catch (error) {
      storeError(error);
    }
    result.trade = syncDecisionAndEvaluate(
      result.trade,
      'trade-inbox-vision-apply',
    );
    return {
      ...result,
      inbox,
      checks,
      vision: true,
      overview: overview(),
      dashboard: dashboardQuery.getDashboard(),
    };
  }

  function ignoreInbox(id, body) {
    const inbox = tradesRepository.ignoreInbox(
      id,
      String(body.note || ''),
    );
    if (!inbox) throw tradeError(404, '没有找到这张截图');
    return { inbox, overview: overview() };
  }

  function updateInbox(id, item, body) {
    const value = validationValue(validateInboxOverridePayload(body));
    const requestId = `trade-inbox-correct:${id}:${Date.now()}`;
    const inbox = tradesRepository.withDataTrustTransaction(() => {
      const updated = tradesRepository.updateInbox(id, {
        parsed: { ...item.parsed, ...value },
        parse_confidence:
          value.confidence ?? item.parse_confidence,
        notes: value.notes ?? item.notes,
      });
      const correction = tradesRepository.appendInboxEvent(
        id,
        {
          event_type: 'human_corrected',
          actor_type: 'human',
          actor_ref: 'trade-inbox-correction',
          payload: {
            before: item.parsed || {},
            after: updated.parsed || {},
            reason: value.notes || '人工校正交易截图',
          },
          dedupe_key: `human:${requestId}`,
          created_at: new Date().toISOString(),
        },
        requestId,
      );
      if (correction) {
        tradesRepository.selectInboxEvent(id, correction);
      }
      return tradesRepository.getInboxItem(id);
    });
    return { inbox, overview: overview() };
  }

  function pruneInbox(body) {
    const olderThanDays = body.olderThanDays
      ? Number(body.olderThanDays)
      : 180;
    if (
      !Number.isInteger(olderThanDays) ||
      olderThanDays < 30 ||
      olderThanDays > 3650
    ) {
      throw tradeError(400, '保留天数需要是 30–3650 的整数');
    }
    const result = tradesRepository.pruneScreenshots({
      today: todayProvider(),
      olderThanDays,
    });
    return { ...result, inbox: tradesRepository.listInbox() };
  }

  function createHolding(body) {
    const value = validationValue(validateHoldingPayload(body));
    return {
      holding: tradesRepository.createHolding(value),
      dashboard: dashboardQuery.getDashboard(),
    };
  }

  function updateHolding(id, body) {
    const value = validationValue(validateHoldingPayload(body));
    const holding = tradesRepository.updateHolding(id, value);
    if (!holding) throw tradeError(404, '没有找到这笔持仓');
    return { holding, dashboard: dashboardQuery.getDashboard() };
  }

  function deleteHolding(id) {
    if (!tradesRepository.deleteHolding(id)) {
      throw tradeError(404, '没有找到这笔持仓');
    }
    return { deleted: true, dashboard: dashboardQuery.getDashboard() };
  }

  return {
    applyInboxItem,
    cancelTrade,
    confirmTrade,
    createHolding,
    createTrade,
    deleteHolding,
    getAudits,
    getInboxFilePath,
    getInboxItem,
    ignoreInbox,
    listInbox: () => tradesRepository.listInbox(),
    overview,
    pruneInbox,
    updateHolding,
    updateInbox,
    updateTrade,
    uploadInbox,
    visionApply,
  };
}

module.exports = {
  createTradesService,
  tradeError,
};
