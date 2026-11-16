'use strict';

// Share the maintained mainland market workday calendar. Weekend make-up
// office days are not bank product disclosure days.
const { valuationCalendar, shift, isoDate } = require('../server/modules/r2-screening/calendar');

function shiftDisclosureWorkdays(date, days) {
  if (!isoDate(date)) return date;
  const direction = days < 0 ? -1 : 1;
  let remaining = Math.abs(days);
  let result = date;
  while (remaining > 0) {
    result = shift(result, direction);
    const open = valuationCalendar.isOpen(result);
    // Outside maintained coverage dates are provisional only. Reconciliation
    // must not declare a missing disclosure from this weekday estimate.
    const weekday = new Date(result).getUTCDay();
    if (open === true || (open === null && weekday >= 1 && weekday <= 5)) remaining--;
  }
  return result;
}

function disclosureCalendarCovers(...dates) {
  return dates.every((date) => isoDate(date) && date >= valuationCalendar.start && date <= valuationCalendar.end);
}

module.exports = { shiftDisclosureWorkdays, disclosureCalendarCovers };
