'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  appendCoverageNote,
  coverageFromInput,
  markCoverageCleared,
  parseCoveredYieldDates,
} = require('../lib/product-income-coverage');

test('coverage parser recognizes existing Chinese merged-update notes', () => {
  assert.deepEqual(
    parseCoveredYieldDates(
      '收益截图说明该次更新覆盖10月24日至26日，金额按10月26日合并入账。',
      '2026-10-26',
    ),
    ['2026-10-24', '2026-10-25', '2026-10-26'],
  );
});

test('coverage parser and writer preserve a stable auditable contract', () => {
  const dates = ['2026-10-24', '2026-10-25', '2026-10-26'];
  const notes = appendCoverageNote(
    '用户确认该收益为合并更新。',
    dates,
    '2026-10-26',
  );
  assert.equal(
    notes,
    '用户确认该收益为合并更新。\n覆盖收益日期：2026-10-24 至 2026-10-26。',
  );
  assert.deepEqual(parseCoveredYieldDates(notes, '2026-10-26'), dates);
  assert.equal(
    appendCoverageNote(notes, dates, '2026-10-26'),
    notes,
    '重复写入必须幂等',
  );
});

test('coverage input accepts explicit dates and validates the attribution date', () => {
  assert.deepEqual(
    coverageFromInput(
      {
        covered_yield_dates: [
          '2026-10-24',
          '2026-10-25',
          '2026-10-26',
        ],
      },
      '2026-10-26',
    ),
    ['2026-10-24', '2026-10-25', '2026-10-26'],
  );
  assert.throws(
    () =>
      coverageFromInput(
        {
          coverage_start_date: '2026-10-24',
          coverage_end_date: '2026-10-25',
        },
        '2026-10-26',
      ),
    /必须包含该条产品收益的归属日/,
  );
});

test('negated or uncertain coverage notes never close a real gap', () => {
  for (const note of [
    '收益记录未覆盖10月24日至26日。',
    '页面没有覆盖10月24日至26日。',
    '是否覆盖10月24日至26日尚待确认。',
    '该次更新覆盖10月24日至26日，是否计息待确认。',
    '该次更新覆盖10月24日至26日，覆盖范围待核实。',
    '收益截图覆盖10月24日至26日的情况尚不清楚。',
    '该次更新覆盖10月24日至26日，尚未证实。',
    '覆盖10月24日至26日可能只是估算。',
  ]) {
    assert.deepEqual(parseCoveredYieldDates(note, '2026-10-26'), []);
  }
});

test('an explicit clear marker overrides an earlier merged-update note', () => {
  const note = markCoverageCleared(
    '收益截图说明该次更新覆盖10月24日至26日。',
  );
  assert.deepEqual(parseCoveredYieldDates(note, '2026-10-26'), []);
  assert.equal(markCoverageCleared(note), note);
});
