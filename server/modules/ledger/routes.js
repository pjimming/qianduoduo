'use strict';

const { readJsonBody } = require('../../http/middleware/json-body');
const {
  SECURITY_HEADERS,
  sendError,
  sendJson,
} = require('../../http/response');

function sendServiceError(response, error) {
  if (!error.statusCode) throw error;
  sendError(response, error.statusCode, error.message);
}

function createLedgerRoutes(ledger) {
  return [
    {
      method: 'POST',
      path: '/api/records',
      async handler(request, response) {
        const body = await readJsonBody(request);
        try {
          const result = ledger.createRecord(body);
          sendJson(response, result.statusCode, result.body);
        } catch (error) {
          sendServiceError(response, error);
        }
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/records\/(\d{4}-\d{2}-\d{2})$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/records\/(\d{4}-\d{2}-\d{2})$/,
        );
        if (!ledger.hasRecord(match[1])) {
          sendError(response, 404, '没有找到这条记录');
          return;
        }
        const body = await readJsonBody(request);
        try {
          sendJson(response, 200, ledger.updateRecord(match[1], body));
        } catch (error) {
          sendServiceError(response, error);
        }
      },
    },
    {
      method: 'DELETE',
      path: /^\/api\/records\/(\d{4}-\d{2}-\d{2})$/,
      handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/records\/(\d{4}-\d{2}-\d{2})$/,
        );
        try {
          sendJson(response, 200, ledger.deleteRecord(match[1]));
        } catch (error) {
          sendServiceError(response, error);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/export.csv',
      handler(request, response) {
        const exported = ledger.exportCsv();
        response.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${exported.filename}"`,
          'Content-Length': Buffer.byteLength(exported.csv),
          'Cache-Control': 'no-store',
          ...SECURITY_HEADERS,
        });
        response.end(exported.csv);
      },
    },
  ];
}

module.exports = {
  createLedgerRoutes,
};
