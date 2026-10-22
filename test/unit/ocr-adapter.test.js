'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { ocrImage } = require('../../lib/ocr');

test('OCR adapter reports a controlled error when the engine cannot start', async () => {
  const previous = process.env.R2_OCR;
  delete process.env.R2_OCR;
  try {
    const result = await ocrImage(path.join(os.tmpdir(), 'missing.png'), {
      powershell: path.join(os.tmpdir(), `missing-powershell-${process.pid}.exe`),
      timeoutMs: 1000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.text, '');
    assert.match(result.error, /无法启动本地 OCR/);
  } finally {
    if (previous === undefined) delete process.env.R2_OCR;
    else process.env.R2_OCR = previous;
  }
});
