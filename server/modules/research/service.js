'use strict';

const { createResearchRepository } = require('./repository');
const {
  createResearchStaticService,
} = require('./static');

function createResearchService({ rootDir, staticService }) {
  const repository = createResearchRepository(rootDir);
  const assets = createResearchStaticService(staticService);

  function librarySummary() {
    const library = repository.readLibrary();
    return {
      generatedAt: library.generatedAt,
      count: Number(library.count),
      reports: Array.isArray(library.reports) ? library.reports : [],
    };
  }

  function techMapSummary() {
    const techMap = repository.readTechMap();
    return {
      date: techMap.date,
      groups: Array.isArray(techMap.groups) ? techMap.groups.length : 0,
    };
  }

  return {
    librarySummary,
    ownsAsset: assets.owns,
    serveAsset: assets.serve,
    techMapSummary,
  };
}

module.exports = {
  createResearchService,
};
