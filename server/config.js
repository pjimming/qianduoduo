'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const PUBLIC_DIR = path.join(ROOT, 'public');
const STATIC_DIR = fs.existsSync(path.join(DIST_DIR, 'index.html'))
  ? DIST_DIR
  : PUBLIC_DIR;
const DEFAULT_DB = path.join(ROOT, 'data', 'r2_ledger.sqlite');

module.exports = {
  DEFAULT_DB,
  DIST_DIR,
  PUBLIC_DIR,
  ROOT,
  STATIC_DIR,
};
