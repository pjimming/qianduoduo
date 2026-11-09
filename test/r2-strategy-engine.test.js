'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { strategyFixture } = require('./fixtures/r2-strategy.cjs');
const { evaluateStrategy, compactStrategyResult } = require('../server/modules/r2-strategy/engine');

test('same frozen contract connects public screen, allocation and proposal eligibility without review facts', () => {
  const fixture = strategyFixture();
  fixture.mappings = [];
  fixture.checks = [];
  const before = JSON.stringify(fixture);
  const result = evaluateStrategy(fixture);
  assert.equal(result.evidence.rows.length, 7);
  assert.equal(result.allocation.status, 'simulation_passed');
  assert.equal(result.allocation.allocated_cents, 10000);
  assert.equal(result.may_generate_buy_proposals, true);
  assert.ok(!JSON.stringify(result.allocation.blockers).includes('pretrade'));
  assert.equal(JSON.stringify(fixture), before);
  const compact = compactStrategyResult(result);
  assert.equal(compact.input.source_fingerprint, result.evidence.fingerprint);
  assert.equal(compact.input.account_fingerprint, result.account.fingerprint);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 65536);
  assert.equal(evaluateStrategy(fixture).input_fingerprint, result.input_fingerprint);
});
test('legacy and shadow execution cannot create formal proposals or exit intents', () => {
  for (const mode of ['legacy', 'shadow', 'suspended']) {
    const fixture = strategyFixture(); fixture.state.mode = mode;
    const result = evaluateStrategy(fixture);
    assert.equal(result.allocation.full_investment, true);
    assert.equal(result.may_generate_buy_proposals, false);
    assert.deepEqual(result.exit_intents, []);
  }
});
test('missing review facts no longer block proposal generation or create pretrade blockers', () => {
  const fixture = strategyFixture();
  fixture.mappings = [];
  fixture.checks = [];
  const result = evaluateStrategy(fixture);
  assert.equal(result.allocation.full_investment, true);
  assert.equal(result.may_generate_buy_proposals, true);
  assert.ok(!JSON.stringify(result).includes('pretrade'));
});
test('source and account changes alter the shared input fingerprint without any pretrade fact', () => {
  const fixture = strategyFixture(), before = evaluateStrategy(fixture);
  fixture.sourceSnapshot.run.id = 2;
  const after = evaluateStrategy(fixture);
  assert.notEqual(after.input_fingerprint, before.input_fingerprint);
  fixture.portfolio.holdings = [{ lot_id: 'legacy:FP', product_code: 'S1', amount: 1 }];
  assert.notEqual(evaluateStrategy(fixture).input_fingerprint, after.input_fingerprint);
});

test('legacy holdings fall back to conservative product-master classification, while public limits still win', () => {
  const fixture = strategyFixture();
  fixture.portfolio.holdings = [
    { lot_id: 'legacy:H1', product_code: 'H1', amount: 25, term_days: 90 },
    { lot_id: 'legacy:H2', product_code: 'H2', amount: 25, term_days: 7 },
    { lot_id: 'legacy:S1', product_code: 'S1', amount: 25, term_days: 30 },
  ];
  fixture.products = [
    { code: 'H1', name: '存量产品', term_days: 90, benchmark: 'B1', return_3m: 2.1 },
    { code: 'H2', name: '短期限存量', term_days: 7, benchmark: 'B2', return_1m: 2.1 },
  ];
  const result = evaluateStrategy(fixture);
  const fallback = result.account.exposures.find(row => row.lot_id === 'legacy:H1');
  const shortFallback = result.account.exposures.find(row => row.lot_id === 'legacy:H2');
  const verified = result.account.exposures.find(row => row.lot_id === 'legacy:S1');
  assert.equal(fallback.classification_basis, 'holding_master_fallback');
  assert.equal(fallback.product_key, 'product:H1');
  assert.equal(fallback.family_key, 'benchmark|B1');
  assert.equal(fallback.evidence_tier, 'three_month');
  assert.equal(fallback.liquidity_eligible, false);
  assert.equal(shortFallback.bucket, 'short');
  assert.equal(shortFallback.liquidity_eligible, true);
  assert.equal(verified.classification_basis, null);
  assert.notEqual(verified.product_key, 'product:S1');
  assert.ok(!result.account.blockers.some(row => row === 'asset_unverified:H1'));
  assert.ok(!result.account.blockers.some(row => row === 'asset_unverified:S1'));
});

test('holding-only supplements change monitoring without changing the official purchase pool or allocation', () => {
  const { fingerprint } = require('../server/modules/r2-strategy/contract');
  const { monitorContent } = require('../server/modules/r2-strategy/holding-evidence');
  const fixture = strategyFixture();
  fixture.portfolio.holdings = [{ lot_id: 'synthetic:S1', product_code: 'S1', amount: 10 }];
  const baseline = evaluateStrategy(fixture);
  const row = structuredClone(fixture.sourceSnapshot.rows[0]);
  row.data.performance['1m'] = '1.20';
  const evidence = structuredClone(fixture.sourceSnapshot.evidence[0]);
  evidence.summary.performance['1m'] = '1.20';
  evidence.hash = fingerprint(evidence.summary);
  const batch = { scope: 'holding_monitor', business_date: fixture.date, collector_version: 'cmb-public-v1',
    captured_at: '2026-11-07T05:00:00.000Z', items: [{ identity: { source: row.source, channel: row.channel, code: row.code },
      data: row.data, nav_hash: row.nav_hash, issues: [], evidence: [evidence] }] };
  batch.content_hash = fingerprint(monitorContent(batch));
  const result = evaluateStrategy({ ...fixture, holdingSupplements: [batch] });
  assert.equal(baseline.monitoring.rows[0].yield_state, 'pass');
  assert.equal(result.monitoring.rows[0].yield_state, 'below');
  assert.equal(result.exit_intents.length, 1);
  assert.equal(result.evidence.fingerprint, baseline.evidence.fingerprint);
  assert.equal(result.allocation.fingerprint, baseline.allocation.fingerprint);
  assert.notEqual(result.input_fingerprint, baseline.input_fingerprint);
  assert.deepEqual(compactStrategyResult(result).monitoring.rows[0].identity, { source: 'cmb', channel: 'TEST', code: 'S1' });
});

test('unknown public term falls back to the confirmed holding term instead of erasing its bucket', () => {
  const fixture = strategyFixture();
  fixture.sourceSnapshot.rows = fixture.sourceSnapshot.rows.map(row => row.code === 'M1'
    ? { ...row, data: { ...row.data, term: { kind: 'unknown', days: null, basis: null } } }
    : row);
  fixture.portfolio.holdings = [{ lot_id: 'lot:m1', product_code: 'M1', amount: 25, term_days: 90 }];
  const result = evaluateStrategy(fixture);
  const exposure = result.account.exposures.find(row => row.lot_id === 'lot:m1');
  assert.equal(exposure.bucket, 'medium');
  assert.equal(exposure.amount_cents, 2500);
  assert.ok(!result.account.blockers.includes('asset_unverified:M1'));
  assert.ok(!result.allocation.blockers.includes('exposure_unverified'));
});
