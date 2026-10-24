'use strict';

const fs = require('node:fs');
const { readJsonBody } = require('../../http/middleware/json-body');
const {
  SECURITY_HEADERS,
  sendError,
  sendJson,
} = require('../../http/response');
const { decodeImagePayload } = require('../../shared/images');

function sendServiceError(response, error) {
  if (!error.statusCode) throw error;
  sendError(response, error.statusCode, error.message);
}

function createProductValuationsRoutes(productValuations) {
  return [
    {
      method: 'GET',
      path: '/api/holding-valuations',
      handler(request, response, context) {
        sendJson(
          response,
          200,
          productValuations.listHoldingValuations(
            context.requestUrl.searchParams,
          ),
        );
      },
    },
    {
      method: 'POST',
      path: '/api/holding-valuations',
      async handler(request, response) {
        const body = await readJsonBody(request);
        try {
          const result = productValuations.createHoldingValuation(body);
          sendJson(response, result.statusCode, result.body);
        } catch (error) {
          sendServiceError(response, error);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/holding-valuations/evidence',
      async handler(request, response) {
        const body = await readJsonBody(request, 20 * 1024 * 1024);
        const decoded = decodeImagePayload(body);
        if (decoded.error) {
          sendError(response, 400, decoded.error);
          return;
        }
        try {
          const result =
            productValuations.uploadHoldingValuationEvidence(decoded.value);
          sendJson(response, result.statusCode, result.body);
        } catch (error) {
          sendServiceError(response, error);
        }
      },
    },
    {
      method: 'GET',
      path: /^\/api\/holding-valuations\/evidence\/(\d+)\/image$/,
      handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/holding-valuations\/evidence\/(\d+)\/image$/,
        );
        const file = productValuations.getHoldingValuationEvidenceFile(
          Number(match[1]),
        );
        if (!file) {
          sendError(response, 404, '市值截图不存在或已清理');
          return;
        }
        fs.stat(file.path, (error, stats) => {
          if (error || !stats.isFile()) {
            sendError(response, 404, '市值截图不存在或已清理');
            return;
          }
          response.writeHead(200, {
            'Content-Type': file.mime,
            'Content-Length': stats.size,
            'Cache-Control': 'no-store',
            ...SECURITY_HEADERS,
          });
          if (request.method === 'HEAD') {
            response.end();
            return;
          }
          fs.createReadStream(file.path).pipe(response);
        });
      },
    },
    {
      method: 'GET',
      path: '/api/product-valuations',
      handler(request, response, context) {
        sendJson(
          response,
          200,
          productValuations.list(context.requestUrl.searchParams),
        );
      },
    },
    {
      method: 'GET',
      path: '/api/product-yield-settings',
      handler(request, response) {
        sendJson(response, 200, productValuations.listYieldSettings());
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/product-yield-settings\/([A-Za-z0-9-]+)$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/product-yield-settings\/([A-Za-z0-9-]+)$/,
        );
        const body = await readJsonBody(request);
        try {
          sendJson(
            response,
            200,
            productValuations.saveYieldSetting(match[1], body),
          );
        } catch (error) {
          sendServiceError(response, error);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/product-valuations',
      async handler(request, response) {
        const body = await readJsonBody(request);
        try {
          const result = productValuations.createValuation(body);
          sendJson(response, result.statusCode, result.body);
        } catch (error) {
          sendServiceError(response, error);
        }
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/product-valuations\/(\d+)$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/product-valuations\/(\d+)$/,
        );
        const id = Number(match[1]);
        const before = productValuations.getValuation(id);
        if (!before) {
          sendError(response, 404, '没有找到这条产品收益记录');
          return;
        }
        const body = await readJsonBody(request);
        try {
          sendJson(
            response,
            200,
            productValuations.updateValuation(id, before, body),
          );
        } catch (error) {
          sendServiceError(response, error);
        }
      },
    },
  ];
}

module.exports = {
  createProductValuationsRoutes,
};
