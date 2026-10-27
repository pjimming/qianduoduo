'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT } = require('../../server/config');
const {
  createResearchService,
} = require('../../server/modules/research/service');

test('research service reads the report index and owns the library, media, and tech map assets', () => {
  const served = [];
  const response = {
    headers: null,
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end() {
      this.ended = true;
    },
  };
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
  assert.equal(service.ownsAsset('/research/index.html'), true);
  assert.equal(service.ownsAsset('/research/media/example.webp'), true);
  assert.equal(service.ownsAsset('/research/techmap/index.html'), true);
  assert.equal(service.ownsAsset('/research/stocks/example.html'), false);
  assert.equal(service.ownsAsset('/research/scripts/report-nav.js'), false);
  assert.equal(service.ownsAsset('/research/tech-map'), false);
  assert.equal(service.ownsAsset('/investment/research'), false);

  service.serveAsset({}, {}, '/research/media/example.webp');
  service.serveAsset({}, response, '/research/index.html');
  assert.deepEqual(served, ['/research/media/example.webp']);
  assert.equal(response.status, 302);
  assert.equal(response.headers.Location, '/investment/research');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.ended, true);
  assert.equal(path.basename(service.librarySummary().reports[0].file).endsWith('.html'), true);
});
