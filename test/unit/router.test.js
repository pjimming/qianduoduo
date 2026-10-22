'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouter } = require('../../server/http/router');
const {
  API_ROUTE_PATTERNS,
} = require('../../server/http/routes');

test('explicit API route manifest has unique method and path patterns', () => {
  const keys = API_ROUTE_PATTERNS.map(
    ([method, pattern]) => `${method} ${String(pattern)}`,
  );
  assert.equal(keys.length, new Set(keys).size);
  assert.equal(keys.length >= 60, true);
  assert.equal(keys.includes('GET /api/health'), true);
  assert.equal(keys.includes('POST /api/trades'), true);
  assert.equal(keys.includes('GET /api/review/export'), true);
});

test('router matches exact actions and regex parameters without fallback', () => {
  const handler = () => 'route';
  const fallback = () => 'fallback';
  const router = createRouter();
  for (const [method, pattern] of API_ROUTE_PATTERNS) {
    router.add(method, pattern, handler);
  }

  assert.equal(
    router.match('POST', '/api/trades/42/confirm')?.handler,
    handler,
  );
  assert.equal(
    router.match('POST', '/api/inbox/8/snooze')?.handler,
    handler,
  );
  assert.equal(router.match('GET', '/api/trades/42/confirm'), null);

  const fallbackRouter = createRouter();
  assert.equal(
    fallbackRouter.match('GET', '/api/not-registered'),
    null,
  );
  assert.equal(typeof fallback, 'function');
});
