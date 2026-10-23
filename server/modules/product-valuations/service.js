'use strict';

const { todayShanghai } = require('../../../lib/metrics');

function serviceError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createProductValuationsService({
  productValuationsRepository,
  dashboardQuery,
}) {
  const todayProvider = () => todayShanghai();

  function list(query) {
    const productCode = String(query.get('product_code') || '');
    const today = todayProvider();
    if (productCode) {
      return {
        detail: productValuationsRepository.getDetail(productCode, today),
      };
    }
    return {
      valuations: productValuationsRepository.listValuations(),
      ...productValuationsRepository.getWorkspace(
        today,
        productValuationsRepository.getPortfolio(),
      ),
    };
  }

  function listYieldSettings() {
    return {
      settings: productValuationsRepository.listYieldSettings(),
    };
  }

  function saveYieldSetting(productCode, body) {
    try {
      return {
        setting: productValuationsRepository.saveYieldSetting(
          productCode,
          body,
        ),
        dashboard: dashboardQuery.projectDashboard(),
      };
    } catch (error) {
      throw serviceError(400, error.message);
    }
  }

  function createValuation(body) {
    const today = todayProvider();
    const yieldDate = String(body.yield_date || body.date || '');
    const creditDate = String(
      body.credit_date || body.valuation_date || yieldDate,
    );
    if (body.product_code && yieldDate) {
      if (yieldDate > today) {
        throw serviceError(400, '产品收益归属日不能晚于今天');
      }
      if (creditDate && creditDate < yieldDate) {
        throw serviceError(400, '到账/可见日期不能早于收益归属日');
      }
    }
    let result;
    try {
      result = productValuationsRepository.upsertValuation(body, {
        source: 'manual-correction',
        auditNote: body.correction_note || '手工补录产品收益',
      });
    } catch (error) {
      throw serviceError(400, error.message);
    }
    const notification = result.conflict
      ? productValuationsRepository.flagProductIncomeConflict({
          date: yieldDate || body.date,
          productCode: body.product_code,
          existing: result.valuation.daily_pnl,
          incoming: body.daily_pnl,
          source: 'manual-product',
        })
      : null;
    return {
      statusCode: result.conflict ? 200 : 201,
      body: {
        valuation: result.valuation,
        conflict: result.conflict,
        notification_id: notification?.id ?? null,
        dashboard: dashboardQuery.projectDashboard(),
      },
    };
  }

  function getValuation(id) {
    return productValuationsRepository.getValuation(id);
  }

  function updateValuation(id, before, body) {
    const today = todayProvider();
    const yieldDate = String(body.yield_date || before.yield_date || '');
    const creditDate = String(
      body.credit_date ||
        body.valuation_date ||
        before.credit_date ||
        yieldDate,
    );
    if (yieldDate > today) {
      throw serviceError(400, '产品收益归属日不能晚于今天');
    }
    if (creditDate < yieldDate) {
      throw serviceError(400, '到账/可见日期不能早于收益归属日');
    }
    let result;
    try {
      result = productValuationsRepository.updateValuationById(
        id,
        {
          ...before,
          ...body,
          product_code: before.product_code,
          yield_date: yieldDate,
          credit_date: creditDate,
          source: 'manual-correction',
        },
        {
          source: 'manual-correction',
          auditNote: body.correction_note || '手工修正产品收益',
        },
      );
    } catch (error) {
      throw serviceError(400, error.message);
    }
    return {
      valuation: result.valuation,
      conflict: result.conflict,
      dashboard: dashboardQuery.projectDashboard(),
    };
  }

  return {
    createValuation,
    getValuation,
    list,
    listYieldSettings,
    saveYieldSetting,
    updateValuation,
  };
}

module.exports = {
  createProductValuationsService,
};
