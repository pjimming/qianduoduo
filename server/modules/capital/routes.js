'use strict';

const { readJsonBody } = require('../../http/middleware/json-body');
const { sendError, sendJson } = require('../../http/response');

function sendServiceError(response, error) {
  if (!error.statusCode) throw error;
  sendError(response, error.statusCode, error.message);
}

function createCapitalRoutes(capital) {
  return [
    {
      method: 'POST',
      path: '/api/capital/init',
      async handler(request, response) {
        const body = await readJsonBody(request);
        try {
          const dashboard = capital.initialize(body);
          sendJson(response, 201, { dashboard });
        } catch (error) {
          sendServiceError(response, error);
        }
      },
    },
    {
      method: 'PUT',
      path: '/api/capital/init',
      async handler(request, response) {
        const body = await readJsonBody(request);
        try {
          const dashboard = capital.updateInitial(body);
          sendJson(response, 200, { dashboard });
        } catch (error) {
          sendServiceError(response, error);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/capital/events',
      async handler(request, response) {
        const body = await readJsonBody(request);
        try {
          sendJson(response, 201, capital.createEvent(body));
        } catch (error) {
          sendServiceError(response, error);
        }
      },
    },
    {
      method: 'DELETE',
      path: /^\/api\/capital\/events\/(\d+)$/,
      handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/capital\/events\/(\d+)$/,
        );
        try {
          sendJson(response, 200, capital.deleteEvent(Number(match[1])));
        } catch (error) {
          sendServiceError(response, error);
        }
      },
    },
  ];
}

module.exports = {
  createCapitalRoutes,
};
