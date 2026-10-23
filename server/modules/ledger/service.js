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
    const validation = validateRecordPayload(body, { today });
    if (validation.error) throw serviceError(400, validation.error);
    const existing = ledgerRepository.getRecord(validation.value.date);
    if (existing) {
      const sameValue =
        Math.abs(
          Number(existing.daily_pnl) -
            Number(validation.value.daily_pnl),
        ) <= 0.005;
      if (sameValue) {
        return {
          statusCode: 200,
          body: {
            record: existing,
            duplicate: true,
            changed: false,
            conflict: null,
            dashboard: dashboardQuery.projectDashboard(),
          },
        };
      }
      const notification = ledgerRepository.flagIncomeConflict({
        date: validation.value.date,
        existing,
        incoming: validation.value.daily_pnl,
        source: 'manual',
      });
      return {
        statusCode: 200,
        body: {
          record: existing,
          duplicate: false,
          changed: false,
          conflict: {
            date: validation.value.date,
            existing_daily_pnl: Number(existing.daily_pnl),
            incoming_daily_pnl: validation.value.daily_pnl,
            difference:
              Math.round(
                (validation.value.daily_pnl -
                  Number(existing.daily_pnl)) *
                  100,
              ) / 100,
            notification_id: notification.id,
          },
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
    const validation = validateRecordPayload(
      { ...body, date },
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
