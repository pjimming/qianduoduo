'use strict';

const fs = require('node:fs');
const { readJsonBody } = require('../../http/middleware/json-body');
const {
  SECURITY_HEADERS,
  sendError,
  sendJson,
} = require('../../http/response');
const { decodeImagePayload } = require('../../shared/images');

function sendIncomeError(response, error) {
  if (!error.statusCode) throw error;
  sendError(response, error.statusCode, error.message);
}

function createIncomeRoutes(income) {
  return [
    {
      method: 'GET',
      path: '/api/income/inbox',
      handler(request, response) {
        sendJson(response, 200, income.list());
      },
    },
    {
      method: 'POST',
      path: '/api/income/inbox/prune',
      async handler(request, response) {
        const body = await readJsonBody(request);
        try {
          sendJson(response, 200, income.prune(body));
        } catch (error) {
          sendIncomeError(response, error);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/income/inbox',
      async handler(request, response) {
        const body = await readJsonBody(request, 20 * 1024 * 1024);
        const decoded = decodeImagePayload(body);
        if (decoded.error) {
          sendError(response, 400, decoded.error);
          return;
        }
        const result = await income.upload(decoded.value);
        sendJson(response, result.statusCode, result.body);
      },
    },
    {
      method: 'GET',
      path: /^\/api\/income\/inbox\/(\d+)\/image$/,
      handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/income\/inbox\/(\d+)\/image$/,
        );
        const file = income.getImage(Number(match[1]));
        if (!file) {
          sendError(response, 404, '收益截图不存在或已清理');
          return;
        }
        fs.stat(file.path, (error, stats) => {
          if (error || !stats.isFile()) {
            sendError(response, 404, '收益截图不存在或已清理');
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
      method: 'POST',
      path: /^\/api\/income\/inbox\/(\d+)\/apply$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/income\/inbox\/(\d+)\/apply$/,
        );
        const body = await readJsonBody(request);
        try {
          sendJson(
            response,
            200,
            income.apply(Number(match[1]), body),
          );
        } catch (error) {
          sendIncomeError(response, error);
        }
      },
    },
    {
      method: 'POST',
      path: /^\/api\/income\/inbox\/(\d+)\/ignore$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/income\/inbox\/(\d+)\/ignore$/,
        );
        const body = await readJsonBody(request);
        try {
          sendJson(
            response,
            200,
            income.ignore(Number(match[1]), body),
          );
        } catch (error) {
          sendIncomeError(response, error);
        }
      },
    },
  ];
}

module.exports = {
  createIncomeRoutes,
};
