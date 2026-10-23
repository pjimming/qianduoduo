'use strict';

const { sendError, sendJson } = require('../../http/response');

function createDataTrustRoutes(dataTrust) {
  return [
    {
      method: 'GET',
      path: '/api/data-trust/status',
      handler(request, response) {
        sendJson(response, 200, dataTrust.status());
      },
    },
    {
      method: 'GET',
      path: /^\/api\/evidence\/\d+\/trace$/,
      handler(request, response, context) {
        const match = context.pathname.match(/^\/api\/evidence\/(\d+)\/trace$/);
        const trace = dataTrust.evidenceTrace(match[1]);
        if (!trace) {
          sendError(response, 404, '没有找到该证据');
          return;
        }
        sendJson(response, 200, { evidence_trace: trace });
      },
    },
    {
      method: 'GET',
      path: /^\/api\/facts\/[^/]+\/[^/]+\/trace$/,
      handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/facts\/([^/]+)\/([^/]+)\/trace$/,
        );
        const factType = decodeURIComponent(match[1]);
        const factKey = decodeURIComponent(match[2]);
        sendJson(response, 200, {
          fact_trace: dataTrust.factTrace(factType, factKey),
        });
      },
    },
  ];
}

module.exports = {
  createDataTrustRoutes,
};
