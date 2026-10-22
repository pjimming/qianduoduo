'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('../helpers/test-context');

test('historical principal recalculation preserves ledger identity and non-principal fields', (t) => {
  const context = createTestContext(t);
  const repository = context.repository;
  repository.initializeCapital(100000, '2026-09-01', 'compatibility baseline');
  const deposit = repository.createCapitalEvent({
    date: '2026-09-10',
    type: 'deposit',
    amount: 5000,
    note: 'deposit',
  });
  repository.createCapitalEvent({
    date: '2026-09-20',
    type: 'withdraw',
    amount: 2000,
    note: 'withdraw',
  });
  repository.createRecord({
    date: '2026-09-05',
    daily_pnl: 10,
    action: '无操作',
    notes: 'first',
  });
  repository.createRecord({
    date: '2026-09-15',
    daily_pnl: -5,
    action: '买入',
    notes: 'second',
  });
  repository.createRecord({
    date: '2026-09-25',
    daily_pnl: 20,
    action: '赎回',
    notes: 'third',
  });

  const before = repository.listRecords();
  assert.deepEqual(
    before.map((record) => ({
      date: record.date,
      principal: record.principal,
      daily_pnl: record.daily_pnl,
      action: record.action,
      notes: record.notes,
    })),
    [
      {
        date: '2026-09-05',
        principal: 100000,
        daily_pnl: 10,
        action: '无操作',
        notes: 'first',
      },
      {
        date: '2026-09-15',
        principal: 105000,
        daily_pnl: -5,
        action: '买入',
        notes: 'second',
      },
      {
        date: '2026-09-25',
        principal: 103000,
        daily_pnl: 20,
        action: '赎回',
        notes: 'third',
      },
    ],
  );

  repository.updateCapitalInitial(110000, '2026-09-01');
  const afterInitialUpdate = repository.listRecords();
  assert.deepEqual(
    afterInitialUpdate.map((record) => record.principal),
    [110000, 115000, 113000],
  );
  assert.deepEqual(
    afterInitialUpdate.map((record) => ({
      id: record.id,
      date: record.date,
      daily_pnl: record.daily_pnl,
      action: record.action,
      notes: record.notes,
    })),
    before.map((record) => ({
      id: record.id,
      date: record.date,
      daily_pnl: record.daily_pnl,
      action: record.action,
      notes: record.notes,
    })),
  );

  assert.equal(repository.deleteCapitalEvent(deposit.id), true);
  const afterEventDelete = repository.listRecords();
  assert.deepEqual(
    afterEventDelete.map((record) => record.principal),
    [110000, 110000, 108000],
  );
  assert.deepEqual(
    afterEventDelete.map((record) => record.daily_pnl),
    [10, -5, 20],
  );
  assert.equal(repository.getCapitalState('2026-09-25').current_principal, 108000);
});
