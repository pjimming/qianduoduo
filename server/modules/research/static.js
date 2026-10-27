'use strict';

const LIBRARY_INDEX_PATH = '/research/index.html';
const LIBRARY_APP_PATH = '/investment/research';
const ASSET_PREFIXES = Object.freeze([
  '/research/media/',
  '/research/techmap/',
]);

function ownsResearchAsset(pathname) {
  if (pathname === '/research/tech-map' || pathname.startsWith('/research/tech-map/')) {
    return false;
  }
  if (pathname === LIBRARY_INDEX_PATH) {
    return true;
  }
  return ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function createResearchStaticService(staticService) {
  if (!staticService) {
    throw new Error('research static service 需要 static service');
  }

  return {
    owns: ownsResearchAsset,
    serve(request, response, pathname) {
      if (pathname === LIBRARY_INDEX_PATH) {
        response.writeHead(302, {
          Location: LIBRARY_APP_PATH,
          'Cache-Control': 'no-store',
        });
        response.end();
        return;
      }
      staticService.serveStatic(request, response, pathname);
    },
  };
}

module.exports = {
  ASSET_PREFIXES,
  LIBRARY_INDEX_PATH,
  LIBRARY_APP_PATH,
  createResearchStaticService,
  ownsResearchAsset,
};
