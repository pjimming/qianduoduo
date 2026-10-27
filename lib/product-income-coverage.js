'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_COVERAGE_DAYS = 31;
const COVERAGE_LABEL = '覆盖收益日期';
const CLEARED_COVERAGE_LABEL = `${COVERAGE_LABEL}：无（用户撤回）。`;

function parseYmd(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) ? stamp : null;
}

function formatYmd(stamp) {
  return new Date(stamp).toISOString().slice(0, 10);
}

function shiftDate(date, days) {
  const stamp = parseYmd(date);
  return stamp === null ? date : formatYmd(stamp + days * DAY_MS);
}

function uniqueSortedDates(values = []) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
    .sort();
}

function datesBetween(start, end) {
  const startStamp = parseYmd(start);
  const endStamp = parseYmd(end);
  if (startStamp === null || endStamp === null || endStamp < startStamp) {
    return [];
  }
  const days = Math.round((endStamp - startStamp) / DAY_MS);
  if (days >= MAX_COVERAGE_DAYS) {
    throw new Error(`收益覆盖区间不能超过 ${MAX_COVERAGE_DAYS} 天`);
  }
  return Array.from({ length: days + 1 }, (_, index) =>
    formatYmd(startStamp + index * DAY_MS),
  );
}

function normalizeDateTime(value, fallbackYear) {
  const text = String(value || '').trim();
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  }
  match = text.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日?$/);
  if (match) {
    const year = match[1] || fallbackYear;
    return `${year}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  }
  match = text.match(/^(?:(\d{4})[/.])?(\d{1,2})[/.](\d{1,2})$/);
  if (match) {
    const year = match[1] || fallbackYear;
    return `${year}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  }
  return '';
}

function normalizeCoveredYieldDates(values, referenceDate) {
  if (!parseYmd(referenceDate)) {
    throw new Error('收益覆盖区间需要有效收益归属日');
  }
  const dates = uniqueSortedDates(Array.isArray(values) ? values : []);
  if (!dates.length || dates.length > MAX_COVERAGE_DAYS) {
    throw new Error(`收益覆盖区间需要 1–${MAX_COVERAGE_DAYS} 个有效日期`);
  }
  for (const date of dates) {
    if (!parseYmd(date)) {
      throw new Error(`收益覆盖日期格式不正确：${date}`);
    }
    if (date > referenceDate) {
      throw new Error('收益覆盖日期不能晚于该条产品收益的归属日');
    }
  }
  if (!dates.includes(referenceDate)) {
    throw new Error('收益覆盖区间必须包含该条产品收益的归属日');
  }
  const span = Math.round(
    (parseYmd(dates[dates.length - 1]) - parseYmd(dates[0])) / DAY_MS,
  );
  if (span >= MAX_COVERAGE_DAYS) {
    throw new Error(`收益覆盖区间不能超过 ${MAX_COVERAGE_DAYS} 天`);
  }
  return dates;
}

function parseExplicitMarker(notes, referenceDate) {
  const text = String(notes || '');
  const matches = [
    ...text.matchAll(
      /覆盖收益日期\s*[：:]\s*([^\n。；;]+)/g,
    ),
  ];
  if (!matches.length) {
    return { found: false, dates: [] };
  }
  const value = matches[matches.length - 1][1].trim();
  if (/^(?:无|未覆盖|不覆盖|清除|撤回|不适用)/.test(value)) {
    return { found: true, dates: [] };
  }
  const yearMatch = text.match(/(20\d{2})-\d{2}-\d{2}/);
  const fallbackYear = yearMatch?.[1] || referenceDate.slice(0, 4);
  const range = value.match(
    /((?:\d{4}[-/.])?\d{1,2}[-/.]\d{1,2})\s*(?:至|到|—|–|~|－)\s*((?:\d{4}[-/.])?\d{1,2}[-/.]\d{1,2})/,
  );
  if (range) {
    const start = normalizeDateTime(range[1], fallbackYear);
    let end = normalizeDateTime(range[2], fallbackYear);
    if (end && !/^\d{4}-/.test(end)) {
      end = `${start.slice(0, 4)}-${end}`;
    }
    return { found: true, dates: datesBetween(start, end) };
  }
  const dates = value
    .split(/[、,，\s]+/)
    .map((item) => normalizeDateTime(item, fallbackYear))
    .filter(Boolean);
  return { found: true, dates: uniqueSortedDates(dates) };
}

function hasUnconfirmedCoverageContext(text, index, matchText) {
  const prefix = text.slice(Math.max(0, index - 16), index);
  if (
    /(?:未|不|没(?:有)?|无|尚未|并未|未能|无法|是否|待确认|待核实|待核|待查|不确定|可能|疑似|预计).{0,8}$/.test(
      prefix,
    )
  ) {
    return true;
  }
  const sentenceStart = Math.max(
    text.lastIndexOf('。', index),
    text.lastIndexOf('；', index),
    text.lastIndexOf(';', index),
    text.lastIndexOf('\n', index),
  );
  const suffix = text.slice(index + matchText.length);
  const sentenceEndCandidates = ['。', '；', ';', '\n']
    .map((marker) => suffix.indexOf(marker))
    .filter((value) => value >= 0);
  const sentenceEnd =
    sentenceEndCandidates.length > 0
      ? index + matchText.length + Math.min(...sentenceEndCandidates)
      : text.length;
  const context = text.slice(sentenceStart + 1, sentenceEnd);
  if (
    /(?:不清楚|不明确|尚未证实|未证实|尚未确认|未确认|不能确认|待确认|待核实|待核|待查|不确定|是否|可能|估算|推测|估计|似乎|据说|预计)/.test(
      context,
    )
  ) {
    return true;
  }
  const prefixContext = text.slice(sentenceStart + 1, index);
  return !/(?:明确(?:显示|说明|标注)?|已确认|确认|说明|显示|标注|记录|截图|页面|App|银行|本次更新|该次更新)/i.test(
    prefixContext,
  );
}

function parseCoveredYieldDates(notes, referenceDate) {
  if (!parseYmd(referenceDate)) return [];
  try {
    const explicit = parseExplicitMarker(notes, referenceDate);
    if (explicit.found) {
      return explicit.dates.length
        ? normalizeCoveredYieldDates(explicit.dates, referenceDate)
        : [];
    }

    const text = String(notes || '');
    const year = referenceDate.slice(0, 4);
    const isoRange = text.match(
      /覆盖[^。\n]{0,40}?((?:20\d{2}-)?\d{1,2}-\d{1,2})[^。\n]{0,8}?(?:至|到|—|–|~|－)[^。\n]{0,12}?((?:20\d{2}-)?\d{1,2}-\d{1,2})/,
    );
    if (
      isoRange &&
      !hasUnconfirmedCoverageContext(text, isoRange.index, isoRange[0])
    ) {
      let start = normalizeDateTime(isoRange[1], year);
      let end = normalizeDateTime(isoRange[2], year);
      if (!/^\d{4}-/.test(start)) start = `${year}-${start}`;
      if (!/^\d{4}-/.test(end)) end = `${year}-${end}`;
      return normalizeCoveredYieldDates(datesBetween(start, end), referenceDate);
    }

    const chineseRange = text.match(
      /覆盖[^。\n]{0,40}?((?:(?:20\d{2})年)?\d{1,2}月\d{1,2}日)[^。\n]{0,8}?(?:至|到|—|–|~|－)[^。\n]{0,12}?((?:(?:20\d{2})年)?(?:\d{1,2}月)?\d{1,2}日)/,
    );
    if (
      chineseRange &&
      !hasUnconfirmedCoverageContext(
        text,
        chineseRange.index,
        chineseRange[0],
      )
    ) {
      const start = normalizeDateTime(chineseRange[1], year);
      const startMonth = start.slice(5, 7);
      let endText = chineseRange[2];
      if (!/月/.test(endText)) endText = `${startMonth}月${endText}`;
      const end = normalizeDateTime(endText, year);
      return normalizeCoveredYieldDates(datesBetween(start, end), referenceDate);
    }
  } catch {
    return [];
  }
  return [];
}

function hasCoverageDirective(notes) {
  return [
    ...String(notes || '').matchAll(
      /覆盖收益日期\s*[：:]\s*([^\n。；;]+)/g,
    ),
  ].length > 0;
}

function markCoverageCleared(notes) {
  const current = String(notes || '').trim();
  if (current.endsWith(CLEARED_COVERAGE_LABEL)) {
    return current;
  }
  return [current, CLEARED_COVERAGE_LABEL].filter(Boolean).join('\n');
}

function formatCoverageLabel(dates) {
  const normalized = uniqueSortedDates(dates);
  if (!normalized.length) return '';
  const contiguous = normalized.every(
    (date, index) => index === 0 || date === shiftDate(normalized[index - 1], 1),
  );
  return `${COVERAGE_LABEL}：${
    contiguous
      ? `${normalized[0]} 至 ${normalized[normalized.length - 1]}`
      : normalized.join('、')
  }`;
}

function appendCoverageNote(notes, dates, referenceDate) {
  const normalized = normalizeCoveredYieldDates(dates, referenceDate);
  const current = String(notes || '').trim();
  const existing = parseCoveredYieldDates(current, referenceDate);
  if (
    existing.length === normalized.length &&
    existing.every((date, index) => date === normalized[index])
  ) {
    return current;
  }
  const label = formatCoverageLabel(normalized);
  return [current, `${label}。`].filter(Boolean).join('\n');
}

function coverageFromInput(input = {}, referenceDate) {
  if (input.clear_coverage === true) {
    return [];
  }
  if (
    Array.isArray(input.covered_yield_dates) &&
    input.covered_yield_dates.length
  ) {
    return normalizeCoveredYieldDates(input.covered_yield_dates, referenceDate);
  }
  const start = String(input.coverage_start_date || '').trim();
  const end = String(input.coverage_end_date || '').trim();
  if (start || end) {
    if (!parseYmd(start) || !parseYmd(end)) {
      throw new Error('收益覆盖起止日期格式应为 YYYY-MM-DD');
    }
    return normalizeCoveredYieldDates(datesBetween(start, end), referenceDate);
  }
  return parseCoveredYieldDates(input.notes, referenceDate);
}

function sameDateList(left = [], right = []) {
  const a = uniqueSortedDates(left);
  const b = uniqueSortedDates(right);
  return a.length === b.length && a.every((date, index) => date === b[index]);
}

module.exports = {
  appendCoverageNote,
  coverageFromInput,
  datesBetween,
  formatCoverageLabel,
  hasCoverageDirective,
  markCoverageCleared,
  normalizeCoveredYieldDates,
  parseCoveredYieldDates,
  sameDateList,
};
