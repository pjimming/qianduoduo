'use strict';

function createTransactionManager(db) {
  if (!db) throw new Error('transaction manager 需要 database');
  let depth = 0;

  function run(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('transaction callback 必须是函数');
    }
    if (depth > 0) return callback();
    db.exec('BEGIN IMMEDIATE');
    depth = 1;
    try {
      const result = callback();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      depth = 0;
    }
  }

  return {
    run,
    isActive: () => depth > 0,
  };
}

module.exports = {
  createTransactionManager,
};
