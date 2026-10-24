'use strict';

const { sendError, sendJson } = require('../../http/response');

function sendDashboardError(response, error) {
  if (error.statusCode) {
    sendError(response, error.statusCode, error.message);
    return;
  }
  throw error;
}

function createDashboardRoutes(dashboardQuery) {
  const sectionRoutes = dashboardQuery.DASHBOARD_SECTIONS.filter(
    (section) => section !== 'summary',
  ).map((section) => ({
    method: 'GET',
    path: `/api/dashboard/${section}`,
    handler(request, response) {
      try {
        sendJson(response, 200, dashboardQuery.getSection(section));
      } catch (error) {
        sendDashboardError(response, error);
      }
    },
  }));

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
      path: '/api/dashboard/summary',
      handler(request, response) {
        try {
          sendJson(response, 200, dashboardQuery.getSection('summary'));
        } catch (error) {
          sendDashboardError(response, error);
        }
      },
    },
    ...sectionRoutes,
    {
      method: 'GET',
      path: '/api/dashboard/sections',
      handler(request, response, context) {
        try {
          sendJson(
            response,
            200,
            dashboardQuery.getSections(
              context.requestUrl.searchParams.get('include'),
            ),
          );
        } catch (error) {
          sendDashboardError(response, error);
        }
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
