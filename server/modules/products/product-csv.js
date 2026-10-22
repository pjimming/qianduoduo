'use strict';

const fs = require('node:fs');
const path = require('node:path');

function resolveProductCsv(rootDir, options = {}) {
  const env = options.env || process.env;
  if (env.R2_PRODUCT_CSV) {
    return path.resolve(env.R2_PRODUCT_CSV);
  }
  const dataDir = path.join(rootDir, 'data');
  if (!fs.existsSync(dataDir)) {
    return path.join(dataDir, 'cmb_r2_universe.csv');
  }
  const newest = (pattern) =>
    fs
      .readdirSync(dataDir)
      .filter((name) => pattern.test(name))
      .map((name) => {
        const filePath = path.join(dataDir, name);
        const match = /(\d{4}-\d{2}-\d{2})/.exec(name);
        return {
          filePath,
          date: match ? match[1] : '',
          mtime: fs.statSync(filePath).mtimeMs,
        };
      })
      .sort(
        (a, b) =>
          b.date.localeCompare(a.date) || b.mtime - a.mtime,
      )[0]?.filePath;

  return (
    newest(/^cmb_r2_universe.*\.csv$/i) ||
    newest(/^cmb_r2_products.*\.csv$/i) ||
    path.join(dataDir, 'cmb_r2_universe.csv')
  );
}

module.exports = {
  resolveProductCsv,
};
