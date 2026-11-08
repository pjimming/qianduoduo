'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { strategyFixture } = require('./fixtures/r2-strategy.cjs');
const { evaluateStrategy, compactStrategyResult } = require('../server/modules/r2-strategy/engine');

test('same frozen contract connects public screen, allocation, pretrade review and proposal eligibility', () => {
  const fixture = strategyFixture(), before = JSON.stringify(fixture);
  const result = evaluateStrategy(fixture);
  assert.equal(result.evidence.rows.length, 6);
  assert.equal(result.allocation.status, 'simulation_passed');
  assert.equal(result.allocation.allocated_cents, 10000);
  assert.equal(result.may_generate_buy_proposals, true);
  assert.ok(result.selected_reviews.every(row => row.executable));
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
test('asset review and current-day App quota stay separate from a valid allocation simulation', () => {
  const fixture = strategyFixture();
  fixture.checks.forEach(row => { row.facts.assets.actual_assets_verified = false; });
  const result = evaluateStrategy(fixture);
  assert.equal(result.allocation.full_investment, true);
  assert.equal(result.may_generate_buy_proposals, false);
  assert.ok(result.selected_reviews.every(row => row.blockers.includes('assets_unverified')));
});
test('mapping removal, new account commitments and source changes alter the shared input fingerprint', () => {
  const fixture = strategyFixture(), before = evaluateStrategy(fixture);
  fixture.mappings[0].revoked_at = '2026-11-07T05:00:00Z';
  const after = evaluateStrategy(fixture);
  assert.notEqual(after.input_fingerprint, before.input_fingerprint);
  assert.equal(after.pretrade_reviews.some(row => row.identity.code === 'S1'), false);
  fixture.sourceSnapshot.run.id = 2;
  assert.notEqual(evaluateStrategy(fixture).input_fingerprint, after.input_fingerprint);
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
