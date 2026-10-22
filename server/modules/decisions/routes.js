'use strict';

const { readJsonBody } = require('../../http/middleware/json-body');
const { sendError, sendJson } = require('../../http/response');

function sendDecisionError(response, error) {
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

function createDecisionsRoutes(decisions) {
  return [
    {
      method: 'POST',
      path: '/api/review/decisions',
      async handler(request, response) {
        const body = await readJsonBody(request);
        try {
          sendJson(response, 201, decisions.createDecision(body));
        } catch (error) {
          sendDecisionError(response, error);
        }
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/review\/decisions\/(\d+)$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/review\/decisions\/(\d+)$/,
        );
        const body = await readJsonBody(request);
        try {
          sendJson(
            response,
            200,
            decisions.updateDecision(Number(match[1]), body),
          );
        } catch (error) {
          sendDecisionError(response, error);
        }
      },
    },
    {
      method: 'DELETE',
      path: /^\/api\/review\/decisions\/(\d+)$/,
      handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/review\/decisions\/(\d+)$/,
        );
        try {
          sendJson(
            response,
            200,
            decisions.deleteDecision(Number(match[1])),
          );
        } catch (error) {
          sendDecisionError(response, error);
        }
      },
    },
  ];
}

module.exports = {
  createDecisionsRoutes,
};
