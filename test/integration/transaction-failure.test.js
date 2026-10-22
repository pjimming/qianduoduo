'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTestContext,
  initializeCapital,
} = require('../helpers/test-context');

test('characterization: income screenshot can partially commit if inbox update fails', (t) => {
  const context = createTestContext(t);
  initializeCapital(context.repository);
  const parsed = {
    date: '2026-10-12',
    daily_pnl: 5,
    action: '无操作',
    notes: 'income partial commit',
    confidence: 95,
    products: [
      {
        product_code: '120056A',
        product_name: '测试产品',
        daily_pnl: 5,
        holding_amount: 1000,
      },
    ],
  };
  const inbox = context.repository.incomeStore.addInbox({
    original_name: 'partial.png',
    stored_name: 'partial.png',
    mime: 'image/png',
    bytes: 10,
    sha256: 'a'.repeat(64),
    ocr_text: 'test',
    parsed,
    parse_confidence: 95,
  });

  const originalUpdate = context.repository.incomeStore.updateInbox;
  context.repository.incomeStore.updateInbox = () => {
    throw new Error('injected inbox update failure');
  };
  t.after(() => {
    context.repository.incomeStore.updateInbox = originalUpdate;
  });

  assert.throws(
    () =>
      context.repository.applyIncomeScreenshot(inbox.id, parsed, {
        today: '2026-10-22',
      }),
    /injected inbox update failure/,
  );

  assert.equal(context.repository.getRecord('2026-10-12').daily_pnl, 5);
  assert.equal(
    context.repository.productValuationStore.listValuations({
      productCode: '120056A',
    }).length,
    1,
  );
  assert.equal(context.repository.incomeStore.getInboxItem(inbox.id).status, 'pending');
});

test('failed automation cycle is persisted and a later retry completes', (t) => {
  const context = createTestContext(t);
  const originalOverview = context.repository.tradeStore.getOverview;
  context.repository.tradeStore.getOverview = () => {
    throw new Error('injected overview failure');
  };

  const failed = context.repository.automationStore.runCycle({
    today: '2026-10-22',
    trigger: 'test-failure',
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /injected overview failure/);

  context.repository.tradeStore.getOverview = originalOverview;
  const retried = context.repository.automationStore.runCycle({
    today: '2026-10-22',
    trigger: 'test-retry',
  });
  assert.equal(retried.ok, true);

  const runs = context.repository.automationStore.listAutomationRuns(10);
  assert.equal(runs.some((run) => run.trigger === 'test-failure' && run.status === 'failed'), true);
  assert.equal(runs.some((run) => run.trigger === 'test-retry' && run.status === 'done'), true);
});
