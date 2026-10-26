'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  requestJson,
  startTestServer,
} = require('../helpers/test-context');

test('research library uses Vue documents and no longer serves archived report copies', async (t) => {
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

  const reportPage = await fetch(
    `${context.baseUrl}/investment/research/${encodeURIComponent(report.slug)}`,
  );
  assert.equal(reportPage.status, 200);
  assert.match(reportPage.headers.get('content-type'), /^text\/html/);
  assert.match(await reportPage.text(), /<div id="app"><\/div>/);

  const legacyReportAsset = await fetch(
    `${context.baseUrl}/research/stocks/${encodeURIComponent(report.file)}`,
  );
  assert.equal(legacyReportAsset.status, 404);

  const legacyNavigation = await fetch(
    `${context.baseUrl}/research/scripts/report-nav.js`,
  );
  assert.equal(legacyNavigation.status, 404);

  const techMap = await fetch(`${context.baseUrl}/research/techmap/index.html`);
  assert.equal(techMap.status, 200);
  assert.match(techMap.headers.get('content-type'), /^text\/html/);

  const spaTechMap = await fetch(`${context.baseUrl}/research/tech-map`);
  assert.equal(spaTechMap.status, 200);
  assert.match(spaTechMap.headers.get('content-type'), /^text\/html/);

  const unknownApi = await requestJson(`${context.baseUrl}/api/research`);
  assert.equal(unknownApi.response.status, 404);
});
