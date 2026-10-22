'use strict';

const { parseYmd, todayShanghai } = require('../../../lib/metrics');

const EVENT_TYPES = new Set(['费率', '经理', '底层', '赎回规则', '额度', '其他']);
const EVENT_IMPACTS = new Set(['低', '中', '高']);
const EVENT_STATUSES = new Set(['待复核', '已处理']);

function validateProductEventPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '产品事件格式不正确' };
  }
  const today = todayShanghai();
  const date = String(payload.date || '').trim();
  if (!parseYmd(date)) return { error: '事件日期格式应为 YYYY-MM-DD' };
  if (date > today) return { error: '不能记录未来日期' };
  const productName = String(payload.product_name || '').trim();
  if (!productName) return { error: '请填写产品名称' };
  if (productName.length > 100) return { error: '产品名称不能超过 100 个字符' };
  const eventType = String(payload.event_type || '').trim();
  if (!EVENT_TYPES.has(eventType)) {
    return { error: '事件类型不在允许范围内' };
  }
  const description = String(payload.description || '').trim();
  if (!description) return { error: '请填写事件说明' };
  if (description.length > 1000) return { error: '事件说明不能超过 1000 个字符' };
  const impact = String(payload.impact || '中').trim();
  if (!EVENT_IMPACTS.has(impact)) return { error: '影响程度只能是低、中、高' };
  const status = String(payload.status || '待复核').trim();
  if (!EVENT_STATUSES.has(status)) {
    return { error: '事件状态只能是待复核或已处理' };
  }
  return {
    value: {
      date,
      product_name: productName,
      event_type: eventType,
      description,
      impact,
      status,
    },
  };
}

function validateReviewNotePayload(payload, period, count, label) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: `${label}格式不正确` };
  }
  const answers = Array.isArray(payload.answers)
    ? payload.answers.map((item) => String(item ?? '').trim())
    : [];
  while (answers.length < count) answers.push('');
  if (answers.length > count) answers.length = count;
  for (const answer of answers) {
    if (answer.length > 2000) {
      return { error: `${label}单条回答不能超过 2000 个字符` };
    }
  }
  const conclusion = String(payload.conclusion || '').trim();
  if (conclusion.length > 4000) {
    return { error: `${label}结论不能超过 4000 个字符` };
  }
  return { value: { period, answers, conclusion } };
}

module.exports = {
  validateProductEventPayload,
  validateReviewNotePayload,
};
