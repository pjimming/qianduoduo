'use strict';

const BASE_URL = 'https://touzikexue.com/api/daily-market-analyses';
const TYPES = new Set(['morning_brief', 'midday_brief', 'market_overview']);

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function sourceError(message, statusCode = 502) {
  return Object.assign(new Error(message), { statusCode });
}

function createMarketBriefSource({ fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  async function request(suffix, allowMissing = false) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // 固定公开主机，不透传浏览器 Cookie、Authorization 或任意 URL。
      const response = await fetchImpl(`${BASE_URL}/${suffix}`, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (allowMissing && response.status === 404) return null;
      if (!response.ok) throw sourceError('投资科学暂时无法提供分析，请稍后重试');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 2 * 1024 * 1024) {
          controller.abort();
          throw sourceError('投资科学返回的分析内容过大');
        }
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (controller.signal.aborted && !error.statusCode) {
        throw sourceError('投资科学响应超时，请重新读取', 504);
      }
      if (error.statusCode) throw error;
      throw sourceError('投资科学数据读取失败，请重新读取');
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async dates() {
      const data = await request('dates');
      if (!Array.isArray(data?.dates) || !data.dates.every(isCalendarDate)) {
        throw sourceError('投资科学日期列表格式异常');
      }
      return [...new Set(data.dates)].sort().reverse();
    },
    async daily(date) {
      if (!isCalendarDate(date)) throw sourceError('请选择有效日期', 400);
      const data = await request(date, true);
      if (!data) return { trade_date: date, analyses: [] };
      if (data.trade_date !== date || !Array.isArray(data.analyses)) {
        throw sourceError('投资科学返回的分析日期或格式不匹配');
      }
      const analyses = data.analyses.filter((item) => TYPES.has(item?.analysis_type))
        .filter((item) => typeof item.published_at === 'string' && item.published_at
          && Number.isFinite(Date.parse(item.published_at)))
        .map((item) => {
          if (typeof item.content_markdown !== 'string' || !item.content_markdown.trim()
            || item.content_markdown.length > 500000 || typeof item.title !== 'string') {
            throw sourceError('投资科学分析正文格式异常');
          }
          return {
            analysis_type: item.analysis_type,
            title: item.title,
            content_markdown: item.content_markdown,
            published_at: item.published_at,
            generated_at: typeof item.generated_at === 'string' ? item.generated_at : null,
            validation_status: typeof item.validation_status === 'string' ? item.validation_status : null,
          };
        });
      // 同一时段若返回多个版本，只展示发布时间最新的一份。
      const latest = new Map();
      for (const item of analyses) {
        const previous = latest.get(item.analysis_type);
        if (!previous || Date.parse(item.published_at) > Date.parse(previous.published_at)) {
          latest.set(item.analysis_type, item);
        }
      }
      return { trade_date: date, analyses: [...latest.values()] };
    },
  };
}

module.exports = { createMarketBriefSource, isCalendarDate };
