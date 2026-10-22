'use strict';

const { sendError } = require('./response');

function handleCaughtError(response, error) {
  if (response.headersSent || response.writableEnded) return;
  const message = error instanceof Error ? error.message : '服务器处理失败';
  const statusCode =
    error && Number.isInteger(error.statusCode) ? error.statusCode : 500;
  sendError(response, statusCode, message);
}

module.exports = {
  handleCaughtError,
};
