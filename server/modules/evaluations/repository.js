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
    getCalibration(month, today) {
      return repository.automationStore.getCalibration(month, today);
    },
    getCalibrationPrediction(id, today) {
      return repository.automationStore.getCalibrationPrediction(id, today);
    },
    confirmCalibrationPrediction(id, input) {
      return repository.automationStore.confirmPredictionResult(id, input);
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
