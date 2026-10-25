'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spearmanForRanks } = require('../lib/rank-correlation');

test('spearman reranks sparse common codes before correlation', () => {
  assert.equal(
    spearmanForRanks(
      { A: 1, B: 3, C: 5 },
      { A: 1, B: 2, C: 3 },
    ),
    1,
  );
  assert.equal(
    spearmanForRanks(
      { A: 1, B: 3, C: 5 },
      { A: 3, B: 2, C: 1 },
    ),
    -1,
  );
});

test('spearman requires at least two common finite ranks', () => {
  assert.equal(spearmanForRanks({ A: 1 }, { A: 1 }), null);
  assert.equal(spearmanForRanks({ A: 1, B: 2 }, { A: 1, C: 2 }), null);
});
