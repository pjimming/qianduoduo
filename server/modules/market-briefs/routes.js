'use strict';

const { sendJson } = require('../../http/response');

const patterns = [
  ['GET', '/api/market-briefs/dates'],
  ['GET', /^\/api\/market-briefs\/\d{4}-\d{2}-\d{2}$/],
];

function createMarketBriefRoutes(service) {
  return [
    {
      method: 'GET', path: patterns[0][1],
      async handler(request, response) {
        sendJson(response, 200, await service.dates());
      },
    },
    {
      method: 'GET', path: patterns[1][1],
      async handler(request, response, context) {
        const date = context.pathname.split('/').at(-1);
        sendJson(response, 200, await service.daily(date));
      },
    },
  ];
}

module.exports = { createMarketBriefRoutes, patterns };
