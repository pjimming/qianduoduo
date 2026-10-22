'use strict';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
};

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  response.end(body);
}

function sendError(response, statusCode, message, details = null) {
  sendJson(response, statusCode, {
    error: message,
    ...(details ? { details } : {}),
  });
}

module.exports = {
  SECURITY_HEADERS,
  sendError,
  sendJson,
};
