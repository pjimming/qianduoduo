'use strict';

const { parseYmd, todayShanghai } = require('../../../lib/metrics');

function validateCapitalInitPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '本金初始化格式不正确' };
  }
  const today = options.today || todayShanghai();
  const date = String(payload.initial_date || '').trim();
  if (!parseYmd(date)) return { error: '起始日期格式应为 YYYY-MM-DD' };
  if (date > today) return { error: '起始日期不能晚于今天' };
  const amount = Number(payload.initial_principal);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) {
    return { error: '起始本金需要是大于 0 的数字' };
  }
  return {
    value: {
      initial_principal: Math.round(amount * 100) / 100,
      initial_date: date,
    },
  };
}

function validateCapitalEventPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '资金变动格式不正确' };
  }
  const today = options.today || todayShanghai();
  const date = String(payload.event_date || '').trim();
  if (!parseYmd(date)) return { error: '转入/转出日期格式应为 YYYY-MM-DD' };
  if (date > today) return { error: '不能记录未来的转入/转出' };
  const type = String(payload.event_type || '').trim();
  if (!['deposit', 'withdraw'].includes(type)) {
    return { error: '资金变动类型必须是转入或转出' };
  }
  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) {
    return { error: '转入/转出金额需要是大于 0 的数字' };
  }
  const note = String(payload.note || '').trim();
  if (note.length > 200) return { error: '本金变动备注不能超过 200 个字符' };
  return {
    value: {
      date,
      type,
      amount: Math.round(amount * 100) / 100,
      note,
    },
  };
}

module.exports = {
  validateCapitalEventPayload,
  validateCapitalInitPayload,
};
