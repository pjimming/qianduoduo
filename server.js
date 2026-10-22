'use strict';

const app = require('./server/app');
const lifecycle = require('./server/lifecycle');

module.exports = {
  ...app,
  closeServer: lifecycle.closeServer,
  startServer: lifecycle.startServer,
};

if (require.main === module) {
  lifecycle.startServer();
}
