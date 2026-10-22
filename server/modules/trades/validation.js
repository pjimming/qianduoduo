'use strict';

const { parseYmd, todayShanghai } = require('../../../lib/metrics');

const TRADE_TYPES = new Set(['buy', 'redeem', 'switch']);
const TRADE_STATUSES = new Set(['pending', 'confirmed', 'cancelled']);

function validateHoldingPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '持仓格式不正确' };
  }
  const today = todayShanghai();
  const productName = String(payload.product_name || '').trim();
  if (!productName) return { error: '请填写产品名称' };
  if (productName.length > 100) return { error: '产品名称不能超过 100 个字符' };
  const productCode = String(payload.product_code || '').trim();
  if (productCode.length > 50) return { error: '产品代码不能超过 50 个字符' };
  const issuer = String(payload.issuer || '').trim();
  if (issuer.length > 100) return { error: '发行方不能超过 100 个字符' };
  const riskRaw = String(payload.risk_level || 'R2').trim().toUpperCase();
  const riskLevel = riskRaw === 'R2' || riskRaw === 'PR2' ? riskRaw : null;
  if (!riskLevel) return { error: '风险等级只能是 R2 或 PR2' };
  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) {
    return { error: '买入金额需要是大于 0 的数字' };
  }
  const purchaseDate = String(payload.purchase_date || '').trim();
  if (!parseYmd(purchaseDate)) return { error: '买入日期格式应为 YYYY-MM-DD' };
  if (purchaseDate > today) return { error: '买入日期不能晚于今天' };
  let termDays = null;
  const rawTerm = payload.term_days;
  if (rawTerm !== '' && rawTerm !== null && rawTerm !== undefined) {
    const parsed = Number(rawTerm);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650) {
      return { error: '期限需要是 0–3650 的整数天，0 表示日开' };
    }
    termDays = parsed;
  }
  const maturityRaw = String(payload.maturity_date || '').trim();
  let maturityDate = null;
  if (maturityRaw) {
    if (!parseYmd(maturityRaw)) {
      return { error: '到期日格式应为 YYYY-MM-DD' };
    }
    if (maturityRaw < purchaseDate) {
      return { error: '到期日不能早于买入日' };
    }
    maturityDate = maturityRaw;
  }
  const notes = String(payload.notes || '').trim();
  if (notes.length > 500) return { error: '持仓备注不能超过 500 个字符' };
  return {
    value: {
      product_name: productName,
      product_code: productCode,
      issuer,
      risk_level: riskLevel,
      amount: Math.round(amount * 100) / 100,
      purchase_date: purchaseDate,
      term_days: termDays,
      maturity_date: maturityDate,
      notes,
    },
  };
}

function validateTradePayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '交易格式不正确' };
  }
  const today = options.today || todayShanghai();
  const tradeDate = String(payload.trade_date || '').trim();
  if (!parseYmd(tradeDate)) return { error: '交易日期格式应为 YYYY-MM-DD' };
  if (tradeDate > today) return { error: '交易日期不能晚于今天' };
  if (tradeDate < '2000-01-01') return { error: '交易日期过早' };

  const tradeType = String(payload.trade_type || '').trim();
  if (!TRADE_TYPES.has(tradeType)) {
    return { error: '交易类型必须是买入、赎回或切换' };
  }
  const status = String(payload.status || 'pending').trim();
  if (!TRADE_STATUSES.has(status)) {
    return { error: '交易状态必须是待确认、已确认或已撤销' };
  }

  const productCode = String(payload.product_code || '').trim();
  if (!productCode) return { error: '请填写产品代码' };
  if (productCode.length > 50) return { error: '产品代码不能超过 50 个字符' };
  const productName = String(payload.product_name || '').trim();
  if (!productName) return { error: '请填写产品名称' };
  if (productName.length > 120) return { error: '产品名称不能超过 120 个字符' };

  const issuer = String(payload.issuer || '').trim();
  if (issuer.length > 100) return { error: '发行方不能超过 100 个字符' };
  const riskRaw = String(payload.risk_level || 'R2').trim().toUpperCase();
  const riskLevel = riskRaw === 'R2' || riskRaw === 'PR2' ? riskRaw : null;
  if (!riskLevel) return { error: '风险等级只能是 R2 或 PR2' };

  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) {
    return { error: '交易金额需要是大于 0 的数字' };
  }
  let settlementAmount = null;
  if (
    payload.settlement_amount !== '' &&
    payload.settlement_amount !== null &&
    payload.settlement_amount !== undefined
  ) {
    settlementAmount = Number(payload.settlement_amount);
    if (
      !Number.isFinite(settlementAmount) ||
      settlementAmount <= 0 ||
      settlementAmount > 1e12
    ) {
      return { error: '到账金额需要是大于 0 的数字' };
    }
  }
  let shares = null;
  if (
    payload.shares !== '' &&
    payload.shares !== null &&
    payload.shares !== undefined
  ) {
    shares = Number(payload.shares);
    if (!Number.isFinite(shares) || shares <= 0 || shares > 1e15) {
      return { error: '份额需要是大于 0 的数字' };
    }
  }
  let termDays = null;
  if (
    payload.term_days !== '' &&
    payload.term_days !== null &&
    payload.term_days !== undefined
  ) {
    termDays = Number(payload.term_days);
    if (!Number.isInteger(termDays) || termDays < 0 || termDays > 3650) {
      return { error: '期限需要是 0–3650 的整数天，0 表示日开' };
    }
  }
  const maturityRaw = String(payload.maturity_date || '').trim();
  let maturityDate = null;
  if (maturityRaw) {
    if (!parseYmd(maturityRaw)) return { error: '到期日格式应为 YYYY-MM-DD' };
    if (maturityRaw < tradeDate) return { error: '到期日不能早于交易日期' };
    maturityDate = maturityRaw;
  }
  const confirmRaw = String(payload.confirm_date || '').trim();
  let confirmDate = null;
  if (confirmRaw) {
    if (!parseYmd(confirmRaw)) return { error: '确认日期格式应为 YYYY-MM-DD' };
    if (confirmDateIsFuture(confirmRaw, today)) {
      return { error: '确认日期不能晚于今天' };
    }
    if (confirmRaw < tradeDate) return { error: '确认日期不能早于交易日期' };
    confirmDate = confirmRaw;
  }
  if (status === 'confirmed' && !confirmDate) confirmDate = tradeDate;
  if (status !== 'confirmed') confirmDate = null;

  let targetCode = String(payload.target_product_code || '').trim();
  let targetName = String(payload.target_product_name || '').trim();
  let targetTermDays = null;
  let targetMaturityDate = null;
  if (tradeType === 'switch') {
    if (!targetCode) return { error: '切换交易请填写目标产品代码' };
    if (!targetName) return { error: '切换交易请填写目标产品名称' };
    if (targetName.length > 120) return { error: '目标产品名称不能超过 120 个字符' };
    if (
      payload.target_term_days !== '' &&
      payload.target_term_days !== null &&
      payload.target_term_days !== undefined
    ) {
      targetTermDays = Number(payload.target_term_days);
      if (
        !Number.isInteger(targetTermDays) ||
        targetTermDays < 0 ||
        targetTermDays > 3650
      ) {
        return { error: '目标产品期限需要是 0–3650 的整数天' };
      }
    }
    const targetMaturityRaw = String(payload.target_maturity_date || '').trim();
    if (targetMaturityRaw) {
      if (!parseYmd(targetMaturityRaw)) {
        return { error: '目标产品到期日格式应为 YYYY-MM-DD' };
      }
      if (targetMaturityRaw < tradeDate) {
        return { error: '目标产品到期日不能早于交易日期' };
      }
      targetMaturityDate = targetMaturityRaw;
    }
  }

  let decisionId = null;
  if (
    payload.decision_id !== '' &&
    payload.decision_id !== null &&
    payload.decision_id !== undefined
  ) {
    decisionId = Number(payload.decision_id);
    if (!Number.isInteger(decisionId) || decisionId <= 0) {
      return { error: '关联决策编号不正确' };
    }
  }
  const notes = String(payload.notes || '').trim();
  if (notes.length > 500) return { error: '交易备注不能超过 500 个字符' };

  return {
    value: {
      trade_date: tradeDate,
      confirm_date: confirmDate,
      trade_type: tradeType,
      status,
      product_code: productCode,
      product_name: productName,
      issuer,
      risk_level: riskLevel,
      target_product_code: targetCode,
      target_product_name: targetName,
      target_term_days: targetTermDays,
      target_maturity_date: targetMaturityDate,
      amount: Math.round(amount * 100) / 100,
      settlement_amount:
        settlementAmount === null
          ? null
          : Math.round(settlementAmount * 100) / 100,
      shares: shares === null ? null : Math.round(shares * 10000) / 10000,
      term_days: termDays,
      maturity_date: maturityDate,
      decision_id: decisionId,
      notes,
    },
  };
}

function confirmDateIsFuture(date, today) {
  return date > today;
}

function validateInboxOverridePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '收件箱校正内容格式不正确' };
  }
  const allowed = [
    'trade_date',
    'confirm_date',
    'trade_type',
    'status',
    'product_code',
    'product_name',
    'issuer',
    'risk_level',
    'amount',
    'settlement_amount',
    'shares',
    'term_days',
    'maturity_date',
    'target_product_code',
    'target_product_name',
    'target_term_days',
    'target_maturity_date',
    'decision_id',
    'decision_reason',
    'decision_expectation',
    'decision_invalidation_condition',
    'decision_evidence_date',
    'decision_verify_date',
    'confidence',
    'notes',
  ];
  const value = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      value[key] = payload[key];
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(value, 'notes') &&
    String(value.notes || '').length > 500
  ) {
    return { error: '收件箱备注不能超过 500 个字符' };
  }
  return { value };
}

module.exports = {
  validateHoldingPayload,
  validateInboxOverridePayload,
  validateTradePayload,
};
