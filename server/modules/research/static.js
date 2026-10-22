'use strict';

const ASSET_PREFIXES = Object.freeze([
  '/research/stocks/',
  '/research/media/',
  '/research/scripts/',
  '/research/techmap/',
]);

function ownsResearchAsset(pathname) {
  if (pathname === '/research/tech-map' || pathname.startsWith('/research/tech-map/')) {
    return false;
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
      staticService.serveStatic(request, response, pathname);
    },
  };
}

module.exports = {
  ASSET_PREFIXES,
  createResearchStaticService,
  ownsResearchAsset,
};
