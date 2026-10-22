'use strict';

const { readJsonBody } = require('../../http/middleware/json-body');
const { sendError, sendJson } = require('../../http/response');

function createProposalsRoutes(proposals) {
  return [
    {
      method: 'GET',
      path: '/api/decision-proposals',
      handler(request, response) {
        sendJson(response, 200, proposals.list());
      },
    },
    {
      method: 'POST',
      path: /^\/api\/decision-proposals\/(\d+)\/(adopt|reject)$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/decision-proposals\/(\d+)\/(adopt|reject)$/,
        );
        const body = await readJsonBody(request);
        try {
          sendJson(
            response,
            200,
            proposals.act(Number(match[1]), match[2], body),
          );
        } catch (error) {
          if (!error.statusCode) throw error;
          sendError(response, error.statusCode, error.message);
        }
      },
    },
  ];
}

module.exports = {
  createProposalsRoutes,
};
