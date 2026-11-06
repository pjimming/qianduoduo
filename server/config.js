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
const DEFAULT_SCREENING_DB = path.join(ROOT, 'data', 'r2_screening.sqlite');
const SCREENING_ENABLE_FILE = path.join(ROOT, 'data', 'r2_screening.enabled');
const DATA_TRUST_MODE = String(
  process.env.R2_DATA_TRUST_MODE || 'shadow',
).toLowerCase();

module.exports = {
  DATA_TRUST_MODE,
  DEFAULT_DB,
  DEFAULT_SCREENING_DB,
  SCREENING_ENABLE_FILE,
  DIST_DIR,
  PUBLIC_DIR,
  ROOT,
  STATIC_DIR,
};
