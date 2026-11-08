'use strict';

const { sendJson } = require('../../http/response');
const { readJsonBody } = require('../../http/middleware/json-body');
const { strategyError } = require('./repository');
const BASE = '/api/r2-strategy';
const REVIEW = /^\/api\/r2-strategy\/reviews\/([^/]+)\/([^/]+)$/;
const CANCEL_REMAINING = /^\/api\/r2-strategy\/proposals\/(\d+)\/cancel-remaining$/;
const patterns = [['GET', BASE + '/status'], ['GET', BASE + '/workspace'], ['GET', REVIEW],
  ['POST', BASE + '/preview'], ['POST', BASE + '/recompute'], ['POST', BASE + '/proposals'],
  ['POST', CANCEL_REMAINING], ['POST', BASE + '/mappings'], ['POST', BASE + '/checks']];
const FINGERPRINT = /^[a-f0-9]{64}$/;
const PROPOSAL_KEYS = new Set(['expected_input_fingerprint', 'kind', 'lot_id', 'amount_cents', 'target_product_code']);
const COMPUTE_KEYS = new Set(['expected_input_fingerprint']);
const MAPPING_KEYS = new Set(['source', 'channel', 'sales_code', 'product_code', 'registration_code', 'supersedes_id', 'expected_seq']);
const CHECK_KEYS = new Set(['mapping_id', 'lot_id', 'supersedes_id', 'expected_seq', 'facts']);
const CANCEL_KEYS = new Set(['reason']);

function objectBody(body, message) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw strategyError('invalid_input', message, 400);
  return body;
}
function onlyKeys(body, allowed, message) {
  if (Object.keys(body).some(key => !allowed.has(key))) throw strategyError('invalid_input', message, 400);
}
function optionalFingerprint(body) {
  if (body.expected_input_fingerprint !== undefined && (typeof body.expected_input_fingerprint !== 'string' ||
      !FINGERPRINT.test(body.expected_input_fingerprint))) throw strategyError('invalid_input', '输入指纹格式不正确', 400);
  return { expectedInputFingerprint: body.expected_input_fingerprint };
}
function proposalOptions(body) {
  const options = optionalFingerprint(body);
  if (body.kind === undefined) return options;
  const kind = body.kind;
  if (kind !== 'holding_exit' && kind !== 'holding_switch') throw strategyError('invalid_input', '提案类型无效', 400);
  if (typeof body.lot_id !== 'string' || !body.lot_id.trim() || body.lot_id.length > 160) {
    throw strategyError('invalid_input', '持仓批次格式不正确', 400);
  }
  if (body.amount_cents !== undefined && (!Number.isSafeInteger(body.amount_cents) || body.amount_cents < 1)) {
    throw strategyError('invalid_input', '提案金额必须为1分以上的安全整数', 400);
  }
  if (body.target_product_code !== undefined && (typeof body.target_product_code !== 'string' ||
      !body.target_product_code.trim() || body.target_product_code.length > 80)) {
    throw strategyError('invalid_input', '目标产品代码格式不正确', 400);
  }
  return { ...options, kind, lotId: body.lot_id.trim(), amountCents: body.amount_cents,
    targetProductCode: body.target_product_code?.trim() };
}
function decode(value) {
  try { return decodeURIComponent(value); }
  catch { throw strategyError('invalid_input', '产品身份编码无效', 400); }
}

function createStrategyRoutes(service, proposals) {
  return patterns.map(([method, path]) => ({ method, path,
    async handler(request, response, context) {
      if (method === 'GET') {
        if (path === REVIEW) {
          const match = REVIEW.exec(context?.pathname ?? '');
          if (!match) throw strategyError('invalid_input', '产品身份路径无效', 400);
          const query = context?.requestUrl?.searchParams;
          sendJson(response, 200, service.review({ channel: decode(match[1]), code: decode(match[2]),
            lot: query?.get('lot') ?? '', source: query?.get('source') ?? 'cmb' }));
          return;
        }
        sendJson(response, 200, path.endsWith('/status') ? service.status() : service.workspace());
        return;
      }
      const body = objectBody(await readJsonBody(request), '请求体必须为JSON对象');
      if (path === CANCEL_REMAINING) {
        const match = CANCEL_REMAINING.exec(context?.pathname ?? '');
        if (!match) throw strategyError('invalid_input', '提案路径无效', 400);
        onlyKeys(body, CANCEL_KEYS, '取消剩余金额请求包含未知字段');
        if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 500)) {
          throw strategyError('invalid_input', '取消原因需为500字以内文本', 400);
        }
        sendJson(response, 200, proposals.cancelRemaining(Number(match[1]), { reason: body.reason }));
        return;
      }
      if (path.endsWith('/mappings')) {
        onlyKeys(body, MAPPING_KEYS, '映射请求包含未知字段');
        sendJson(response, 200, service.saveMapping(body));
        return;
      }
      if (path.endsWith('/checks')) {
        onlyKeys(body, CHECK_KEYS, '复核请求包含未知字段');
        sendJson(response, 200, service.saveCheck(body));
        return;
      }
      if (path.endsWith('/proposals')) {
        onlyKeys(body, PROPOSAL_KEYS, '提案请求包含未知字段');
        sendJson(response, 200, proposals.generate(proposalOptions(body)));
        return;
      }
      onlyKeys(body, COMPUTE_KEYS, '重算请求只接受有效的当前输入指纹');
      const options = optionalFingerprint(body);
      sendJson(response, 200, path.endsWith('/preview') ? service.preview(options) : service.recompute(options));
    } }));
}

module.exports = { patterns, createStrategyRoutes };
