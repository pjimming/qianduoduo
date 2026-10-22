'use strict';

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function buildCsv(records) {
  const lines = ['date,principal,daily_pnl,action,notes'];
  for (const record of records) {
    lines.push(
      [
        record.date,
        record.principal,
        record.daily_pnl,
        record.action,
        record.notes,
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

module.exports = {
  buildCsv,
  csvEscape,
};
