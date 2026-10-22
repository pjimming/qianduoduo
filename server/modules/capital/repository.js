'use strict';

function createCapitalRepository(repository) {
  if (!repository) throw new Error('capital repository 需要 repository');
  return {
    createEvent(event) {
      return repository.createCapitalEvent(event);
    },
    deleteEvent(id) {
      return repository.deleteCapitalEvent(id);
    },
    getState(today) {
      return repository.getCapitalState(today);
    },
    initialize(principal, date, note) {
      return repository.initializeCapital(principal, date, note);
    },
    updateInitial(principal, date) {
      return repository.updateCapitalInitial(principal, date);
    },
  };
}

module.exports = {
  createCapitalRepository,
};
