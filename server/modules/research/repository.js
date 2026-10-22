'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createResearchRepository(rootDir) {
  const indexPath = path.join(rootDir, 'src', 'data', 'stockReports.json');
  const routeMapPath = path.join(rootDir, 'src', 'data', 'techmap.json');

  return {
    indexPath,
    routeMapPath,
    readLibrary() {
      return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    },
    readTechMap() {
      return JSON.parse(fs.readFileSync(routeMapPath, 'utf8'));
    },
  };
}

module.exports = {
  createResearchRepository,
};
