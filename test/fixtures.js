'use strict';

const path = require('node:path');
const { resolveProductCsv } = require('../server');

module.exports = {
  productCsv: resolveProductCsv(path.join(__dirname, '..')),
};
