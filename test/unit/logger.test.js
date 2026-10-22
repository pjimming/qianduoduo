'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSafeLogger,
  sanitizeLogText,
} = require('../../server/infrastructure/logging/logger');

test('logger redacts bearer tokens, passwords and API keys', () => {
  assert.equal(
    sanitizeLogText('Authorization: Bearer abc.def.ghi'),
    'Authorization: Bearer [REDACTED]',
  );
  assert.equal(
    sanitizeLogText('password=hunter2 token:secret api_key=xyz'),
    'password=[REDACTED] token:[REDACTED] api_key=[REDACTED]',
  );
});

test('safe logger applies redaction before writing', () => {
  const lines = [];
  const logger = createSafeLogger({
    log: (line) => lines.push(line),
    warn: (line) => lines.push(line),
    error: (line) => lines.push(line),
  });
  logger.log('password=abc');
  logger.warn('Bearer qwerty');
  assert.deepEqual(lines, [
    'password=[REDACTED]',
    'Bearer [REDACTED]',
  ]);
});
