'use strict';

const DAY = 86400000;
const TIMEZONE = 'Asia/Shanghai';
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function shanghaiTime(now) {
  const fields = Object.fromEntries(formatter.formatToParts(now).map(({ type, value }) => [type, value]));
  return { date: `${fields.year}-${fields.month}-${fields.day}`, hour: Number(fields.hour), minute: Number(fields.minute) };
}

function isoDate(input) {
  const value = typeof input === 'string'
    ? input.trim().replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')
      .replace(/^(\d{4})年(\d{2})月(\d{2})日$/, '$1-$2-$3')
    : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? value : null;
}

function shift(date, days) {
  return new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return (Date.parse(to) - Date.parse(from)) / DAY;
}

function weekday(date) {
  const day = new Date(date).getUTCDay();
  return day >= 1 && day <= 5;
}

function createCalendar({ version, sources, start, end, closed }) {
  return {
    version, sources, start, end,
    isOpen(date) {
      if (date < start || date > end) return null;
      return weekday(date) && !closed.some(([first, last]) => date >= first && date <= last);
    },
  };
}

const government = 'https://www.gov.cn/zhengce/content/202511/content_7047090.htm';
const sse2025 = 'https://www.sse.com.cn/disclosure/dealinstruc/closed/c/c_20241223_10767110.shtml';
const sse2026 = 'https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml';
const holiday2026 = [
  ['2026-01-01', '2026-01-03'], ['2026-02-15', '2026-02-23'], ['2026-04-04', '2026-04-06'],
  ['2026-05-01', '2026-05-05'], ['2026-06-19', '2026-06-21'], ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
];
const refreshCalendar = createCalendar({
  version: 'cn-gov-2026-7', sources: [government], start: '2026-01-01', end: '2026-12-31', closed: holiday2026,
});
const valuationCalendar = createCalendar({
  version: 'sse-2025-2026', sources: [sse2025, sse2026], start: '2025-01-01', end: '2026-12-31',
  closed: [
    ['2025-01-01', '2025-01-01'], ['2025-01-28', '2025-02-04'], ['2025-04-04', '2025-04-06'],
    ['2025-05-01', '2025-05-05'], ['2025-05-31', '2025-06-02'], ['2025-10-01', '2025-10-08'],
    ...holiday2026,
  ],
});

function nextDue(now, calendar) {
  const { date, hour } = shanghaiTime(now);
  for (let day = hour < 12 ? date : shift(date, 1); day <= calendar.end; day = shift(day, 1)) {
    if (calendar.isOpen(day)) return `${day}T12:00:00+08:00`;
  }
  return null;
}

module.exports = { TIMEZONE, shanghaiTime, isoDate, shift, daysBetween, createCalendar, refreshCalendar, valuationCalendar, nextDue };
