'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  requestJson,
  startTestServer,
} = require('../helpers/test-context');

test('research reports and generated indexes remain isolated static assets', async (t) => {
  const context = await startTestServer(t);
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'src', 'data', 'stockReports.json'),
      'utf8',
    ),
  );
  const report = manifest.reports[0];

  const libraryRoute = await fetch(`${context.baseUrl}/investment/research`);
  assert.equal(libraryRoute.status, 200);
  assert.match(libraryRoute.headers.get('content-type'), /^text\/html/);

  const reportAsset = await fetch(
    `${context.baseUrl}/research/stocks/${encodeURIComponent(report.file)}`,
  );
  assert.equal(reportAsset.status, 200);
  assert.match(reportAsset.headers.get('content-type'), /^text\/html/);
  assert.equal((await reportAsset.text()).length > 1000, true);

  const nav = await fetch(`${context.baseUrl}/research/scripts/report-nav.js`);
  assert.equal(nav.status, 200);
  assert.match(nav.headers.get('content-type'), /javascript/);

  const techMap = await fetch(`${context.baseUrl}/research/techmap/index.html`);
  assert.equal(techMap.status, 200);
  assert.match(techMap.headers.get('content-type'), /^text\/html/);

  const spaTechMap = await fetch(`${context.baseUrl}/research/tech-map`);
  assert.equal(spaTechMap.status, 200);
  assert.match(spaTechMap.headers.get('content-type'), /^text\/html/);

  const unknownApi = await requestJson(`${context.baseUrl}/api/research`);
  assert.equal(unknownApi.response.status, 404);
});
