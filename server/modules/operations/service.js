'use strict';

const {
  createDailyBackup,
  defaultBackupDir,
  listBackups,
} = require('../../../lib/backup');

function createOperationsService(repository, options = {}) {
  if (!repository) throw new Error('operations 服务需要 repository');
  const now = options.now || (() => new Date());

  function health() {
    return {
      ok: true,
      time: now().toISOString(),
    };
  }

  function backupDir() {
    return repository.backupDir || defaultBackupDir(repository.dbPath);
  }

  function listDatabaseBackups() {
    return listBackups(backupDir());
  }

  function createBackup() {
    const dir = backupDir();
    const result = createDailyBackup(repository.db, repository.dbPath, {
      dir,
      today: options.todayProvider?.(),
    });
    return {
      ...result,
      backups: listBackups(dir),
    };
  }

  return {
    backupDir,
    createBackup,
    health,
    listDatabaseBackups,
  };
}

module.exports = {
  createOperationsService,
};
