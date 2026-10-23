'use strict';

const {
  migrationStatus,
  verifyMigration,
} = require('../../../lib/data-trust-migration');

function createDataTrustService({ repository }) {
  if (!repository) throw new Error('data trust service 需要 repository');

  function status() {
    return {
      migration: migrationStatus(repository.db),
      verification: verifyMigration(repository.db, {
        throwOnError: false,
      }),
    };
  }

  function evidenceTrace(id) {
    return repository.dataTrustStore.traceEvidence(Number(id));
  }

  function factTrace(factType, factKey) {
    return repository.dataTrustStore.traceFact(factType, factKey);
  }

  return {
    evidenceTrace,
    factTrace,
    status,
  };
}

module.exports = {
  createDataTrustService,
};
