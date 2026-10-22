'use strict';

const { readJsonBody } = require('../../http/middleware/json-body');
const { sendError, sendJson } = require('../../http/response');

function createProductsRoutes({
  products,
  dashboardQuery,
  productCsvPath,
}) {
  return [
    {
      method: 'POST',
      path: '/api/products/refresh',
      async handler(request, response) {
        const refreshed = products.refresh(productCsvPath());
        sendJson(response, 200, {
          refreshed,
          dashboard: dashboardQuery.getDashboard(),
        });
      },
    },
    {
      method: 'PUT',
      path: '/api/products/allocation',
      async handler(request, response) {
        const body = await readJsonBody(request);
        let settings;
        try {
          settings = products.saveAllocationSettings(body);
        } catch (error) {
          if (error.statusCode === 400) {
            sendError(response, 400, error.message);
            return;
          }
          throw error;
        }
        sendJson(response, 200, {
          settings,
          dashboard: dashboardQuery.getDashboard(),
        });
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/holding-reviews\/([^/]+)$/,
      async handler(request, response, context) {
        const match = context.pathname.match(/^\/api\/holding-reviews\/([^/]+)$/);
        const body = await readJsonBody(request);
        let setting;
        try {
          setting = products.saveHoldingReviewSetting(match[1], body);
        } catch (error) {
          if (error.statusCode === 400) {
            sendError(response, 400, error.message);
            return;
          }
          throw error;
        }
        sendJson(response, 200, {
          setting,
          dashboard: dashboardQuery.getDashboard(),
        });
      },
    },
  ];
}

module.exports = {
  createProductsRoutes,
};
