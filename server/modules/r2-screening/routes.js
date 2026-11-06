'use strict';

const { sendJson, sendError } = require('../../http/response');
const { isoDate } = require('./calendar');
const { CATEGORIES, STATES, HINTS } = require('./policy');
const { KEY } = require('./source');
const { apiError, createScreeningService } = require('./service');

const BASE = '/api/r2-screening';
const patterns = [
  ['GET', BASE + '/status'],
  ['GET', BASE + '/runs'],
  ['POST', BASE + '/runs'],
  ['GET', /^\/api\/r2-screening\/runs\/([^/]+)$/],
  ['GET', BASE + '/results'],
  ['GET', /^\/api\/r2-screening\/results\/([^/]+)\/([^/]+)$/],
  ['GET', /^\/api\/r2-screening\/results\/([^/]+)\/([^/]+)\/nav$/],
];
const fallback = createScreeningService();

function invalid(name) { throw apiError(400, 'invalid_parameter', `参数 ${name} 无效`); }
function number(input, name, min, max) {
  if (!/^\d+$/.test(input ?? '') || !Number.isSafeInteger(Number(input)) || +input < min || +input > max) invalid(name);
  return +input;
}
function one(params, name) {
  if (params.getAll(name).length > 1) invalid(name);
  return params.has(name) ? params.get(name) : undefined;
}
function choice(params, name, values, fallback) {
  const value = one(params, name);
  if (value === undefined) return fallback;
  if (!values.includes(value)) invalid(name);
  return value;
}
function text(params, name, max) {
  const value = one(params, name)?.trim();
  if (value !== undefined && (value.length > max || /[\x00-\x1f]/.test(value))) invalid(name);
  return value || undefined;
}
function date(params, name) {
  const value = one(params, name);
  if (value !== undefined && (!isoDate(value) || value !== isoDate(value))) invalid(name);
  return value;
}
function pagination(params, defaults = 30, maximum = 100) {
  const limit = number(one(params, 'limit') ?? String(defaults), 'limit', 1, maximum);
  const page = number(one(params, 'page') ?? '1', 'page', 1, 10000);
  return { limit, offset: (page - 1) * limit, page };
}
function runId(params) {
  const value = one(params, 'run_id');
  return value === undefined ? undefined : number(value, 'run_id', 1, Number.MAX_SAFE_INTEGER);
}
function query(params) {
  const term = one(params, 'term');
  const shortlisted = choice(params, 'shortlisted', ['0', '1']);
  return {
    ...pagination(params),
    status: choice(params, 'status', STATES),
    shortlisted: shortlisted === undefined ? undefined : +shortlisted,
    term: term === 'unknown' || term === undefined ? term : number(term, 'term', 0, 10000),
    category: choice(params, 'category', CATEGORIES), issuer: text(params, 'issuer', 100), q: text(params, 'q', 100),
    hint: choice(params, 'hint', HINTS), stage: choice(params, 'stage', ['yield', 'quota']),
    sort: choice(params, 'sort', ['group', 'yield_desc', 'code', 'drawdown'], 'group'),
  };
}

function createScreeningRoutes(service = fallback) {
  const handlers = [
    () => service.status(),
    ({ params }) => {
      const paging = pagination(params);
      return { ...service.runs(paging), page: paging.page, limit: paging.limit };
    },
    ({ request }) => {
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(key)) invalid('Idempotency-Key');
      const { run, existing, conflict } = service.manual(key);
      const status_url = `${BASE}/runs/${run.id}`;
      if (conflict) throw apiError(409, 'active_run', '已有初筛批次在运行，可加入查看', { run, status_url });
      return { payload: { run, status_url }, statusCode: existing ? 200 : 202 };
    },
    ({ matches }) => service.runDetail(number(matches[1], 'run_id', 1, Number.MAX_SAFE_INTEGER)),
    ({ params }) => {
      const filters = query(params);
      return { ...service.results(runId(params), filters), page: filters.page, limit: filters.limit };
    },
    ({ params, matches }) => service.detail(runId(params), sharePart(matches[1]), sharePart(matches[2])),
    ({ params, matches }) => {
      const filters = {
        ...pagination(params, 100, 400), window: choice(params, 'window', ['recent', 'year'], 'recent'),
        from: date(params, 'from'), to: date(params, 'to'),
      };
      return { ...service.nav(runId(params), sharePart(matches[1]), sharePart(matches[2]), filters),
        page: filters.page, limit: filters.limit };
    },
  ];
  return patterns.map(([method, path], i) => ({
    method, path,
    handler(request, response, { requestUrl, pathname }) {
      try {
        const result = handlers[i]({ request, params: requestUrl.searchParams, matches: path instanceof RegExp ? pathname.match(path) : null });
        sendJson(response, result.statusCode ?? 200, result.payload ?? result);
      } catch (error) {
        if (error.statusCode) sendError(response, error.statusCode, error.message, { code: error.code, ...error.data });
        else sendError(response, 503, '初筛库暂不可读', { code: 'store_unavailable' });
      }
    },
  }));
}

function sharePart(value) {
  if (!KEY.test(value)) invalid('share');
  return value;
}

module.exports = { patterns, createScreeningRoutes };
