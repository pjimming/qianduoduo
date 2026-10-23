'use strict';

const { sendJson } = require('../../http/response');

function createDashboardRoutes(dashboardQuery) {
  return [
    {
      method: 'GET',
      path: '/api/dashboard',
      handler(request, response) {
        sendJson(response, 200, dashboardQuery.getDashboard());
      },
    },
    {
      method: 'GET',
      path: '/api/review/workspace',
      handler(request, response) {
        sendJson(response, 200, {
          workspace: dashboardQuery.getWorkspace(),
        });
      },
    },
    {
      method: 'POST',
      path: '/api/dashboard/refresh',
      handler(request, response) {
        sendJson(response, 200, dashboardQuery.projectDashboard());
      },
    },
  ];
}

module.exports = {
  createDashboardRoutes,
};
