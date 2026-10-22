'use strict';

const {
  validateCapitalEventPayload,
  validateCapitalInitPayload,
} = require('./validation');

function serviceError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createCapitalService({ capitalRepository, dashboardQuery }) {
  function validationError(result) {
    if (result.error) throw serviceError(400, result.error);
    return result.value;
  }

  function initialize(body, options = {}) {
    const value = validationError(validateCapitalInitPayload(body, options));
    if (capitalRepository.getState().initialized) {
      throw serviceError(
        409,
        '本金账户已经初始化，如需调整请使用修改接口',
      );
    }
    capitalRepository.initialize(
      value.initial_principal,
      value.initial_date,
      '页面首次初始化',
    );
    return dashboardQuery.getDashboard();
  }

  function updateInitial(body, options = {}) {
    const value = validationError(validateCapitalInitPayload(body, options));
    if (!capitalRepository.getState().initialized) {
      throw serviceError(404, '本金账户尚未初始化');
    }
    try {
      capitalRepository.updateInitial(
        value.initial_principal,
        value.initial_date,
      );
    } catch (error) {
      throw serviceError(400, error.message);
    }
    return dashboardQuery.getDashboard();
  }

  function createEvent(body, options = {}) {
    const value = validationError(validateCapitalEventPayload(body, options));
    let event;
    try {
      event = capitalRepository.createEvent(value);
    } catch (error) {
      throw serviceError(400, error.message);
    }
    return {
      event,
      dashboard: dashboardQuery.getDashboard(),
    };
  }

  function deleteEvent(id) {
    let deleted;
    try {
      deleted = capitalRepository.deleteEvent(id);
    } catch (error) {
      throw serviceError(400, error.message);
    }
    if (!deleted) {
      throw serviceError(404, '没有找到这笔本金变动');
    }
    return {
      deleted: true,
      dashboard: dashboardQuery.getDashboard(),
    };
  }

  return {
    createEvent,
    deleteEvent,
    initialize,
    updateInitial,
  };
}

module.exports = {
  createCapitalService,
};
