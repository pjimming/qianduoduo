'use strict';

const { sendJson } = require('../../http/response');

function createOperationsRoutes(operations) {
  return [
    {
      method: 'GET',
      path: '/api/health',
      handler(request, response) {
        sendJson(response, 200, operations.health());
      },
    },
    {
      method: 'GET',
      path: '/api/backups',
      handler(request, response) {
        sendJson(response, 200, {
          dir: operations.backupDir(),
          backups: operations.listDatabaseBackups(),
        });
      },
    },
    {
      method: 'POST',
      path: '/api/backups',
      handler(request, response) {
        sendJson(response, 201, operations.createBackup());
      },
    },
  ];
}

module.exports = {
  createOperationsRoutes,
};
