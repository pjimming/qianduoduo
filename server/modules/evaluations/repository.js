'use strict';

function createEvaluationsRepository(repository) {
  if (!repository) throw new Error('evaluations repository 需要 repository');
  return {
    forceApplyRun(id, input) {
      return repository.automationStore.forceApplyRun(id, input);
    },
    getWorkspace(today) {
      return repository.automationStore.getWorkspace(today);
    },
    resolveJob(id, input) {
      return repository.automationStore.resolveJob(id, input);
    },
    runCycle(input) {
      return repository.automationStore.runCycle(input);
    },
    undoRun(id) {
      return repository.automationStore.undoRun(id);
    },
    updateSettings(patch) {
      return repository.automationStore.updateSettings(patch);
    },
  };
}

module.exports = {
  createEvaluationsRepository,
};
