'use strict';

const {
  OCR_SCRIPT,
  ocrImage,
  parseOcrOutput,
  terminateOcrProcesses,
} = require('./windows-ocr');
const { parseTradeText } = require('../../../lib/trade-parser');
const { parseIncomeText } = require('../../../lib/income-parser');

function createTradeOcrAdapter(options = {}) {
  const recognize = options.ocrImage || ocrImage;
  const parse = options.parseTradeText || parseTradeText;
  return {
    async read(imagePath, parseOptions = {}) {
      const result = await recognize(imagePath);
      return {
        ...result,
        parsed: parse(result.text, parseOptions),
      };
    },
  };
}

function createIncomeOcrAdapter(options = {}) {
  const recognize = options.ocrImage || ocrImage;
  const parse = options.parseIncomeText || parseIncomeText;
  return {
    async read(imagePath, parseOptions = {}) {
      const result = await recognize(imagePath);
      return {
        ...result,
        parsed: parse(result.text, parseOptions),
      };
    },
  };
}

module.exports = {
  OCR_SCRIPT,
  createIncomeOcrAdapter,
  createTradeOcrAdapter,
  ocrImage,
  parseOcrOutput,
  terminateOcrProcesses,
};
