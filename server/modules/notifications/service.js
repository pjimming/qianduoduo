'use strict';

const { parseYmd } = require('../../../lib/metrics');

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function createNotificationsService(repository) {
  if (!repository) throw new Error('notifications 服务需要 repository');

  function validateConfirmationInput(body = {}) {
    const rawCapitalBridge =
      body.metadata?.capital_bridge ?? body.capital_bridge ?? null;
    let capitalBridge = null;
    if (rawCapitalBridge !== null) {
      if (
        typeof rawCapitalBridge !== 'object' ||
        Array.isArray(rawCapitalBridge)
      ) {
        throw validationError('capital_bridge 元数据必须是对象');
      }
      const bridgeAmount = Number(rawCapitalBridge.bridge_amount);
      const targetPrincipal = Number(rawCapitalBridge.target_principal);
      const decisionId = Number(rawCapitalBridge.decision_id);
      const bridgeDate = String(rawCapitalBridge.bridge_date || '').trim();
      const withdrawDate = String(
        rawCapitalBridge.withdraw_date || '',
      ).trim();
      if (!Number.isFinite(bridgeAmount) || bridgeAmount <= 0) {
        throw validationError('bridge_amount 必须是正数');
      }
      if (!parseYmd(bridgeDate)) {
        throw validationError('bridge_date 格式应为 YYYY-MM-DD');
      }
      if (withdrawDate && !parseYmd(withdrawDate)) {
        throw validationError('withdraw_date 格式应为 YYYY-MM-DD');
      }
      if (withdrawDate && withdrawDate < bridgeDate) {
        throw validationError('withdraw_date 不能早于 bridge_date');
      }
      if (!Number.isFinite(targetPrincipal) || targetPrincipal < 0) {
        throw validationError('target_principal 必须是非负数');
      }
      if (!Number.isInteger(decisionId) || decisionId <= 0) {
        throw validationError('decision_id 必须是正整数');
      }
      if (
        !repository
          .listDecisions()
          .some((decision) => Number(decision.id) === decisionId)
      ) {
        throw validationError('decision_id 对应的决策不存在');
      }
      capitalBridge = {
        bridge_amount: Math.round(bridgeAmount * 100) / 100,
        bridge_date: bridgeDate,
        withdraw_date: withdrawDate || null,
        target_principal: Math.round(targetPrincipal * 100) / 100,
        decision_id: decisionId,
      };
    }
    const rawProductIncomeRequirement =
      body.metadata?.product_income_requirement ??
      body.product_income_requirement ??
      null;
    let productIncomeRequirement = null;
    if (rawProductIncomeRequirement !== null) {
      if (
        typeof rawProductIncomeRequirement !== 'object' ||
        Array.isArray(rawProductIncomeRequirement)
      ) {
        throw validationError(
          'product_income_requirement 元数据必须是对象',
        );
      }
      const productCode = String(
        rawProductIncomeRequirement.product_code || '',
      )
        .trim()
        .toUpperCase();
      const yieldDate = String(
        rawProductIncomeRequirement.yield_date || '',
      ).trim();
      if (!/^[A-Z0-9-]{4,32}$/.test(productCode)) {
        throw validationError('product_income_requirement.product_code 格式不正确');
      }
      if (!parseYmd(yieldDate)) {
        throw validationError(
          'product_income_requirement.yield_date 格式应为 YYYY-MM-DD',
        );
      }
      productIncomeRequirement = {
        product_code: productCode,
        yield_date: yieldDate,
      };
    }
    const value = {
      dedupe_key: String(body.dedupe_key || '').trim(),
      title: String(body.title || '').trim(),
      message: String(body.message || body.summary || '').trim(),
      category: String(body.category || 'action').trim(),
      level: String(body.level || 'warn').trim(),
      severity: String(body.severity || body.level || 'warn').trim(),
      action_label: String(body.action_label || '查看详情').trim(),
      action_url: String(body.action_url || '/ledger/overview').trim(),
      due_at: String(body.due_at || '').trim(),
      capital_bridge: capitalBridge,
      product_income_requirement: productIncomeRequirement,
    };
    if (!/^[A-Za-z0-9:_-]{3,160}$/.test(value.dedupe_key)) {
      throw validationError(
        'dedupe_key 需为 3–160 位字母、数字、冒号、下划线或连字符',
      );
    }
    if (!value.title || value.title.length > 100) {
      throw validationError('title 不能为空或超过 100 个字符');
    }
    if (!value.message || value.message.length > 1200) {
      throw validationError('message 不能为空或超过 1200 个字符');
    }
    if (!['action', 'reminder', 'system'].includes(value.category)) {
      throw validationError('category 必须是 action、reminder 或 system');
    }
    if (!['info', 'warn'].includes(value.level)) {
      throw validationError('level 必须是 info 或 warn');
    }
    if (!['info', 'warn', 'urgent'].includes(value.severity)) {
      throw validationError('severity 必须是 info、warn 或 urgent');
    }
    if (!value.action_label || value.action_label.length > 40) {
      throw validationError('action_label 不能为空或超过 40 个字符');
    }
    if (
      !value.action_url.startsWith('/') ||
      value.action_url.startsWith('//') ||
      /[\r\n]/.test(value.action_url)
    ) {
      throw validationError('action_url 必须是以 / 开头的站内地址');
    }
    if (value.due_at && !parseYmd(value.due_at)) {
      throw validationError('due_at 格式应为 YYYY-MM-DD');
    }
    return value;
  }

  function saveConfirmation(body) {
    const value = validateConfirmationInput(body);
    return repository.automationStore.saveNotification({
      dedupe_key: value.dedupe_key,
      kind: 'agent_confirmation',
      level: value.level,
      title: value.title,
      message: value.message,
      data: {
        category: value.category,
        severity: value.severity,
        action_label: value.action_label,
        action_url: value.action_url,
        due_at: value.due_at || null,
        source: 'codex-r2-review',
        ...(value.capital_bridge
          ? { capital_bridge: value.capital_bridge }
          : {}),
        ...(value.product_income_requirement
          ? { product_income_requirement: value.product_income_requirement }
          : {}),
      },
    });
  }

  function markAllInboxRead() {
    return repository.inboxCenter.markAllRead();
  }

  function markInbox(id, action, body) {
    return repository.inboxCenter.mark(Number(id), action, body);
  }

  function markAllNotificationsRead() {
    return repository.automationStore.markAllNotificationsRead();
  }

  function markNotification(id, action) {
    return repository.automationStore.markNotification(Number(id), action);
  }

  return {
    markAllInboxRead,
    markAllNotificationsRead,
    markInbox,
    markNotification,
    saveConfirmation,
    validateConfirmationInput,
  };
}

module.exports = {
  createNotificationsService,
};
