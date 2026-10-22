'use strict';

const { readJsonBody } = require('../../http/middleware/json-body');
const { sendError, sendJson } = require('../../http/response');

function sendEvaluationError(response, error) {
  if (!error.statusCode) throw error;
  sendError(response, error.statusCode, error.message);
}

function createEvaluationsRoutes(evaluations) {
  return [
    {
      method: 'GET',
      path: '/api/automation/workspace',
      handler(request, response) {
        sendJson(response, 200, evaluations.workspace());
      },
    },
    {
      method: 'POST',
      path: '/api/automation/run',
      handler(request, response) {
        const result = evaluations.run();
        sendJson(response, result.statusCode, result.body);
      },
    },
    {
      method: 'PUT',
      path: '/api/automation/settings',
      async handler(request, response) {
        const body = await readJsonBody(request);
        try {
          sendJson(response, 200, evaluations.updateSettings(body));
        } catch (error) {
          sendEvaluationError(response, error);
        }
      },
    },
    {
      method: 'POST',
      path: /^\/api\/evaluations\/(\d+)\/apply$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/evaluations\/(\d+)\/apply$/,
        );
        const body = await readJsonBody(request);
        try {
          sendJson(
            response,
            200,
            evaluations.applyRun(Number(match[1]), body),
          );
        } catch (error) {
          sendEvaluationError(response, error);
        }
      },
    },
    {
      method: 'POST',
      path: /^\/api\/evaluations\/(\d+)\/undo$/,
      handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/evaluations\/(\d+)\/undo$/,
        );
        try {
          sendJson(
            response,
            200,
            evaluations.undoRun(Number(match[1])),
          );
        } catch (error) {
          sendEvaluationError(response, error);
        }
      },
    },
    {
      method: 'POST',
      path: /^\/api\/automation\/jobs\/(\d+)\/resolve$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/automation\/jobs\/(\d+)\/resolve$/,
        );
        const body = await readJsonBody(request);
        try {
          sendJson(
            response,
            200,
            evaluations.resolveJob(Number(match[1]), body),
          );
        } catch (error) {
          sendEvaluationError(response, error);
        }
      },
    },
  ];
}

module.exports = {
  createEvaluationsRoutes,
};
