'use strict';

const fs = require('node:fs');
const { readJsonBody } = require('../../http/middleware/json-body');
const {
  SECURITY_HEADERS,
  sendError,
  sendJson,
} = require('../../http/response');
const { decodeImagePayload } = require('../../shared/images');

function sendTradeError(response, error) {
  if (error.payload) {
    sendJson(response, error.statusCode || 500, error.payload);
    return;
  }
  if (error.statusCode) {
    sendError(response, error.statusCode, error.message);
    return;
  }
  throw error;
}

function createTradesRoutes(trades) {
  return [
    {
      method: 'GET',
      path: '/api/trades',
      handler(request, response) {
        sendJson(response, 200, {
          overview: trades.overview(),
          inbox: trades.listInbox(),
        });
      },
    },
    {
      method: 'POST',
      path: '/api/trades',
      async handler(request, response) {
        const body = await readJsonBody(request);
        try {
          sendJson(response, 201, trades.createTrade(body));
        } catch (error) {
          sendTradeError(response, error);
        }
      },
    },
    {
      method: 'POST',
      path: /^\/api\/trades\/(\d+)\/confirm$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/trades\/(\d+)\/confirm$/,
        );
        const body = await readJsonBody(request);
        try {
          sendJson(
            response,
            200,
            trades.confirmTrade(Number(match[1]), body),
          );
        } catch (error) {
          sendTradeError(response, error);
        }
      },
    },
    {
      method: 'POST',
      path: /^\/api\/trades\/(\d+)\/cancel$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/trades\/(\d+)\/cancel$/,
        );
        const body = await readJsonBody(request);
        try {
          sendJson(
            response,
            200,
            trades.cancelTrade(Number(match[1]), body),
          );
        } catch (error) {
          sendTradeError(response, error);
        }
      },
    },
    {
      method: 'GET',
      path: /^\/api\/trades\/(\d+)\/audit$/,
      handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/trades\/(\d+)\/audit$/,
        );
        try {
          sendJson(response, 200, trades.getAudits(Number(match[1])));
        } catch (error) {
          sendTradeError(response, error);
        }
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/trades\/(\d+)$/,
      async handler(request, response, context) {
        const match = context.pathname.match(/^\/api\/trades\/(\d+)$/);
        const body = await readJsonBody(request);
        try {
          sendJson(
            response,
            200,
            trades.updateTrade(Number(match[1]), body),
          );
        } catch (error) {
          sendTradeError(response, error);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/trades/inbox/prune',
      async handler(request, response) {
        const body = await readJsonBody(request);
        try {
          sendJson(response, 200, trades.pruneInbox(body));
        } catch (error) {
          sendTradeError(response, error);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/trades/inbox',
      handler(request, response) {
        sendJson(response, 200, {
          inbox: trades.listInbox(),
          overview: trades.overview(),
        });
      },
    },
    {
      method: 'POST',
      path: '/api/trades/inbox',
      async handler(request, response) {
        const body = await readJsonBody(request, 20 * 1024 * 1024);
        const decoded = decodeImagePayload(body);
        if (decoded.error) {
          sendError(response, 400, decoded.error);
          return;
        }
        const result = await trades.uploadInbox(decoded.value);
        sendJson(response, result.statusCode, result.body);
      },
    },
    {
      method: 'GET',
      path: /^\/api\/trades\/inbox\/(\d+)\/image$/,
      handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/trades\/inbox\/(\d+)\/image$/,
        );
        const file = trades.getInboxFilePath(Number(match[1]));
        if (!file) {
          sendError(response, 404, '截图不存在或已清理');
          return;
        }
        fs.stat(file.path, (error, stats) => {
          if (error || !stats.isFile()) {
            sendError(response, 404, '截图不存在或已清理');
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
      path: /^\/api\/trades\/inbox\/(\d+)\/apply$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/trades\/inbox\/(\d+)\/apply$/,
        );
        const item = trades.getInboxItem(Number(match[1]));
        if (!item) {
          sendError(response, 404, '没有找到这张截图');
          return;
        }
        const body = await readJsonBody(request);
        try {
          sendJson(response, 200, trades.applyInboxItem(item, body));
        } catch (error) {
          sendTradeError(response, error);
        }
      },
    },
    {
      method: 'POST',
      path: /^\/api\/trades\/inbox\/(\d+)\/vision-apply$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/trades\/inbox\/(\d+)\/vision-apply$/,
        );
        const item = trades.getInboxItem(Number(match[1]));
        if (!item) {
          sendError(response, 404, '没有找到这张截图');
          return;
        }
        const body = await readJsonBody(request);
        try {
          sendJson(response, 200, trades.visionApply(item, body));
        } catch (error) {
          sendTradeError(response, error);
        }
      },
    },
    {
      method: 'POST',
      path: /^\/api\/trades\/inbox\/(\d+)\/ignore$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/trades\/inbox\/(\d+)\/ignore$/,
        );
        const body = await readJsonBody(request);
        try {
          sendJson(
            response,
            200,
            trades.ignoreInbox(Number(match[1]), body),
          );
        } catch (error) {
          sendTradeError(response, error);
        }
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/trades\/inbox\/(\d+)$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/trades\/inbox\/(\d+)$/,
        );
        const id = Number(match[1]);
        const item = trades.getInboxItem(id);
        if (!item) {
          sendError(response, 404, '没有找到这张截图');
          return;
        }
        const body = await readJsonBody(request);
        try {
          sendJson(response, 200, trades.updateInbox(id, item, body));
        } catch (error) {
          sendTradeError(response, error);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/review/holdings',
      async handler(request, response) {
        const body = await readJsonBody(request);
        try {
          sendJson(response, 201, trades.createHolding(body));
        } catch (error) {
          sendTradeError(response, error);
        }
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/review\/holdings\/(\d+)$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/review\/holdings\/(\d+)$/,
        );
        const body = await readJsonBody(request);
        try {
          sendJson(
            response,
            200,
            trades.updateHolding(Number(match[1]), body),
          );
        } catch (error) {
          sendTradeError(response, error);
        }
      },
    },
    {
      method: 'DELETE',
      path: /^\/api\/review\/holdings\/(\d+)$/,
      handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/review\/holdings\/(\d+)$/,
        );
        try {
          sendJson(
            response,
            200,
            trades.deleteHolding(Number(match[1])),
          );
        } catch (error) {
          sendTradeError(response, error);
        }
      },
    },
  ];
}

module.exports = {
  createTradesRoutes,
};
