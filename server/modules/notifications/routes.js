'use strict';

const { readJsonBody } = require('../../http/middleware/json-body');
const { sendError, sendJson } = require('../../http/response');

function createNotificationsRoutes({ notifications, dashboardQuery }) {
  return [
    {
      method: 'GET',
      path: '/api/inbox',
      handler(request, response) {
        const dashboard = dashboardQuery.getDashboard();
        sendJson(response, 200, {
          inbox_center: dashboard.inbox_center,
        });
      },
    },
    {
      method: 'POST',
      path: '/api/inbox/confirmations',
      async handler(request, response) {
        const body = await readJsonBody(request);
        let notification;
        try {
          notification = notifications.saveConfirmation(body);
        } catch (error) {
          if (error.statusCode === 400) {
            sendError(response, 400, error.message);
            return;
          }
          throw error;
        }
        const dashboard = dashboardQuery.projectDashboard();
        sendJson(response, 201, {
          notification,
          inbox_center: dashboard.inbox_center,
          dashboard,
        });
      },
    },
    {
      method: 'POST',
      path: '/api/inbox/read-all',
      handler(request, response) {
        notifications.markAllInboxRead();
        const dashboard = dashboardQuery.projectDashboard();
        sendJson(response, 200, {
          inbox_center: dashboard.inbox_center,
          dashboard,
        });
      },
    },
    {
      method: 'POST',
      path: /^\/api\/inbox\/(\d+)\/(read|unread|snooze|unsnooze)$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/inbox\/(\d+)\/(read|unread|snooze|unsnooze)$/,
        );
        const body = await readJsonBody(request);
        let item;
        try {
          item = notifications.markInbox(
            Number(match[1]),
            match[2],
            body,
          );
        } catch (error) {
          sendError(response, 400, error.message);
          return;
        }
        if (!item) {
          sendError(response, 404, '没有找到这条消息');
          return;
        }
        const dashboard = dashboardQuery.projectDashboard();
        sendJson(response, 200, {
          item,
          inbox_center: dashboard.inbox_center,
          dashboard,
        });
      },
    },
    {
      method: 'POST',
      path: '/api/notifications/read-all',
      handler(request, response) {
        sendJson(response, 200, {
          notifications: notifications.markAllNotificationsRead(),
        });
      },
    },
    {
      method: 'POST',
      path: /^\/api\/notifications\/(\d+)\/(read|unread|resolve)$/,
      handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/notifications\/(\d+)\/(read|unread|resolve)$/,
        );
        const notification = notifications.markNotification(
          Number(match[1]),
          match[2],
        );
        if (!notification) {
          sendError(response, 404, '没有找到这条提醒');
          return;
        }
        dashboardQuery.projectDashboard();
        sendJson(response, 200, { notification });
      },
    },
  ];
}

module.exports = {
  createNotificationsRoutes,
};
