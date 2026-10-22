'use strict';

const { parseYmd, todayShanghai } = require('../../../lib/metrics');

const ACTIONS = new Set(['无操作', '买入', '赎回', '切换']);

function validateRecordPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '记录格式不正确' };
  }
  const today = options.today || todayShanghai();
  const date = String(payload.date ?? options.date ?? '').trim();
  if (!parseYmd(date)) {
    return { error: '日期格式应为 YYYY-MM-DD' };
  }
  if (date > today) {
    return { error: '不能记录未来日期' };
  }
  if (date < '2000-01-01') {
    return { error: '日期过早，请检查是否填写正确' };
  }
  const dailyPnl = Number(payload.daily_pnl);
  if (!Number.isFinite(dailyPnl) || Math.abs(dailyPnl) > 1e9) {
    return { error: '当日收益需要是有效数字，亏损请填负数' };
  }
  const action = String(payload.action || '无操作').trim();
  if (!ACTIONS.has(action)) {
    return { error: '操作类型不在允许范围内' };
  }
  const notes = String(payload.notes || '').trim();
  if (notes.length > 500) {
    return { error: '备注不能超过 500 个字符' };
  }
  return {
    value: {
      date,
      daily_pnl: Math.round(dailyPnl * 100) / 100,
      action,
      notes,
    },
  };
}

module.exports = {
  validateRecordPayload,
};
