'use strict';

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  const rounded =
    Math.floor(Math.abs(value) * factor + 0.5 + Number.EPSILON) / factor;
  return rounded === 0 ? 0 : Math.sign(value) * rounded;
}

function rerank(values) {
  const sorted = [...new Set(values)].sort((left, right) => left - right);
  return new Map(sorted.map((value, index) => [value, index + 1]));
}

function spearmanForRanks(leftRanks, rightRanks) {
  const common = Object.keys(leftRanks)
    .filter(
      (code) =>
        Number.isFinite(leftRanks[code]) &&
        Number.isFinite(rightRanks[code]),
    )
    .sort();
  if (common.length < 2) return null;
  const leftOrder = rerank(common.map((code) => leftRanks[code]));
  const rightOrder = rerank(common.map((code) => rightRanks[code]));
  const squared = common.reduce((sum, code) => {
    const left = leftOrder.get(leftRanks[code]);
    const right = rightOrder.get(rightRanks[code]);
    return sum + (left - right) ** 2;
  }, 0);
  const count = common.length;
  return round(1 - (6 * squared) / (count * (count ** 2 - 1)));
}

module.exports = {
  spearmanForRanks,
};
