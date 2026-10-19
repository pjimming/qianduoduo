'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOcrOutput } = require('../lib/ocr');

test('OCR output parser keeps UTF-8 Chinese text and ignores noise', () => {
  const stdout = [
    'Windows PowerShell',
    '{"ok":true,"text":"购买成功 交易金额 7,500.00","language":"zh-Hans-CN","available":["en-US","zh-Hans-CN"]}',
  ].join('\r\n');
  const parsed = parseOcrOutput(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.language, 'zh-Hans-CN');
  assert.match(parsed.text, /购买成功/);
  assert.match(parsed.text, /7,500/);
  assert.deepEqual(parsed.available, ['en-US', 'zh-Hans-CN']);
});

test('OCR output parser reports unreadable output', () => {
  const parsed = parseOcrOutput('not json');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /没有返回/);
});
