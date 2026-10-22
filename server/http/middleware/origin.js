'use strict';

const { URL } = require('node:url');

function isAllowedOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}

module.exports = {
  isAllowedOrigin,
};
