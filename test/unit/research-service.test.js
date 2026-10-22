'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT } = require('../../server/config');
const {
  createResearchService,
} = require('../../server/modules/research/service');

test('research service reads the static index and owns only report asset paths', () => {
  const served = [];
  const service = createResearchService({
    rootDir: ROOT,
    staticService: {
      serveStatic(request, response, pathname) {
        served.push(pathname);
      },
    },
  });
  const library = service.librarySummary();
  const techMap = service.techMapSummary();

  assert.equal(library.count, library.reports.length);
  assert.equal(library.count > 0, true);
  assert.equal(techMap.groups > 0, true);
  assert.equal(service.ownsAsset('/research/stocks/example.html'), true);
  assert.equal(service.ownsAsset('/research/media/example.webp'), true);
  assert.equal(service.ownsAsset('/research/techmap/index.html'), true);
  assert.equal(service.ownsAsset('/research/tech-map'), false);
  assert.equal(service.ownsAsset('/investment/research'), false);

  service.serveAsset({}, {}, '/research/scripts/report-nav.js');
  assert.deepEqual(served, ['/research/scripts/report-nav.js']);
  assert.equal(path.basename(service.librarySummary().reports[0].file).endsWith('.html'), true);
});
