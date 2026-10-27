'use strict';

const { todayShanghai } = require('../../../lib/metrics');
const { validateRecordPayload } = require('./validation');
const { buildCsv } = require('./export');

function serviceError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createLedgerService({ ledgerRepository, dashboardQuery }) {
  const todayProvider = () => todayShanghai();

  function createRecord(body) {
    const today = todayProvider();
    const capitalState = ledgerRepository.getCapitalState(today);
    if (!capitalState.initialized) {
      throw serviceError(400, '请先初始化本金账户，再记录收益');
    }
    const date = String(body?.date || '').trim();
    const productSummary = ledgerRepository.getProductIncomeSummary(date);
    if (!productSummary.available) {
      throw serviceError(400, '请先录入至少一条产品当日收益，账户总收益会自动汇总');
    }
    const validation = validateRecordPayload(
      { ...body, daily_pnl: productSummary.daily_pnl },
      { today },
    );
    if (validation.error) throw serviceError(400, validation.error);
    const existing = ledgerRepository.getRecord(validation.value.date);
    if (existing) {
      const sameValue =
        Math.abs(
          Number(existing.daily_pnl) -
            Number(validation.value.daily_pnl),
        ) <= 0.005;
      const canAdoptFirstMetadata =
        existing.source === 'product-income-summary' &&
        existing.action === '无操作' &&
        existing.notes === '由逐产品每日收益汇总生成';
      let record = existing;
      let adoptedMetadata = false;
      if (
        canAdoptFirstMetadata &&
        (validation.value.action !== existing.action ||
          validation.value.notes !== existing.notes)
      ) {
        try {
          record = ledgerRepository.updateRecord(
            validation.value.date,
            validation.value,
          );
          adoptedMetadata = true;
        } catch (error) {
          throw serviceError(400, error.message);
        }
      }
      return {
        statusCode: 200,
        body: {
          record,
          duplicate: sameValue && !adoptedMetadata,
          changed: adoptedMetadata,
          conflict: null,
          derived_daily_pnl: productSummary.daily_pnl,
          dashboard: dashboardQuery.projectDashboard(),
        },
      };
    }
    let record;
    try {
      record = ledgerRepository.createRecord(validation.value);
    } catch (error) {
      throw serviceError(400, error.message);
    }
    return {
      statusCode: 201,
      body: {
        record,
        duplicate: false,
        changed: true,
        conflict: null,
        derived_daily_pnl: productSummary.daily_pnl,
        dashboard: dashboardQuery.projectDashboard(),
      },
    };
  }

  function updateRecord(date, body) {
    const existing = ledgerRepository.getRecord(date);
    if (!existing) throw serviceError(404, '没有找到这条记录');
    if (body.date && body.date !== date) {
      throw serviceError(
        400,
        '修改记录时不能更改日期，请删除后重新记录',
      );
    }
    const today = todayProvider();
    const productSummary = ledgerRepository.getProductIncomeSummary(date);
    if (!productSummary.available) {
      throw serviceError(400, '该日期没有产品收益事实，账户总收益不能独立修改');
    }
    const validation = validateRecordPayload(
      { ...body, date, daily_pnl: productSummary.daily_pnl },
      { date, today },
    );
    if (validation.error) throw serviceError(400, validation.error);
    let record;
    try {
      record = ledgerRepository.updateRecord(date, validation.value);
    } catch (error) {
      throw serviceError(400, error.message);
    }
    return {
      record,
      dashboard: dashboardQuery.projectDashboard(),
    };
  }

  function deleteRecord(date) {
    const productSummary = ledgerRepository.getProductIncomeSummary(date);
    if (productSummary.available) {
      throw serviceError(400, '账户总收益由产品收益汇总生成，请修改产品明细');
    }
    if (!ledgerRepository.deleteRecord(date)) {
      throw serviceError(404, '没有找到这条记录');
    }
    return {
      deleted: true,
      dashboard: dashboardQuery.projectDashboard(),
    };
  }

  function hasRecord(date) {
    return Boolean(ledgerRepository.getRecord(date));
  }

  function exportCsv() {
    return {
      csv: buildCsv(ledgerRepository.listRecords()),
      filename: `r2-daily-log-${todayProvider()}.csv`,
    };
  }

  return {
    createRecord,
    deleteRecord,
    exportCsv,
    hasRecord,
    updateRecord,
  };
}

module.exports = {
  createLedgerService,
};
