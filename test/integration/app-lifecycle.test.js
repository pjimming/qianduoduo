'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../../server/app');
const { requestJson, startTestServer } = require('../helpers/test-context');

test('application factory binds an existing repository without opening another database', () => {
  const repository = {
    marker: 'repository',
    db: { exec() {} },
  };
  const app = createApp({ repository });
  assert.equal(app.repository, repository);
  assert.equal(typeof app.server.listen, 'function');
  app.server.close();
});

test('app starts on an isolated port and closes without leaking the database', async (t) => {
  const context = await startTestServer(t);

  const health = await requestJson(`${context.baseUrl}/api/health`);
  assert.equal(health.response.status, 200);
  assert.equal(health.body.ok, true);
  assert.match(health.body.time, /^\d{4}-\d{2}-\d{2}T/);

  assert.equal(context.server.listening, true);
  await new Promise((resolve) => context.server.close(resolve));
  assert.equal(context.server.listening, false);

  context.repository.close();
  assert.throws(
    () => context.repository.listRecords(),
    /database is not open|statement has been finalized/i,
  );
});

test('unknown API and malformed JSON retain their current HTTP behavior', async (t) => {
  const context = await startTestServer(t);

  const missing = await requestJson(`${context.baseUrl}/api/does-not-exist`);
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error, '接口不存在');

  const malformed = await requestJson(`${context.baseUrl}/api/records`, {
    method: 'POST',
    body: '{"date":',
  });
  assert.equal(malformed.response.status, 500);
  assert.equal(malformed.body.error, '请求不是有效的 JSON');
});
