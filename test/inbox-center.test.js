'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { makeSourceItems } = require('../lib/inbox-center');

function pendingEvaluation(id, decisionId) {
  return {
    id,
    decision_id: decisionId,
    outcome: 'unknown',
    confidence: 52,
    summary: '2026-10 组合收益样本不足',
    evidence: {},
  };
}

function productReconciliation(date, overrides = {}) {
  const missing = overrides.missing_product_codes || ['120056A', '120026A'];
  const covered = overrides.covered_product_codes || [];
  return {
    account_date: date,
    yield_dates: [date],
    product_pnl: 1.21,
    product_count: 1,
    expected_product_count: 3,
    covered_product_count: 1 + covered.length,
    covered_only_product_codes: [],
    missing_product_codes: missing,
    same_day_redeemed_product_codes: [],
    max_yield_lag_days: 2,
    final_disclosure_date: '2026-10-27',
    waiting_product_codes: [],
    is_final: true,
    account_pnl: 1.21,
    account_projection_status: 'ready',
    account_projection_reason: null,
    difference: 0,
    status: 'missing-product-details',
    message: '测试缺口',
    record_id: 1,
    ...overrides,
    missing_product_codes: missing,
    covered_product_codes: covered,
  };
}

function dashboardWithReconciliations(items, today = '2026-10-28') {
  return {
    meta: {
      today,
      reporting_date: today,
      has_reporting_record: true,
    },
    capital: { initialized: false },
    workspace: {
      product_valuation_reconciliation: { items, counts: {} },
    },
    automation: {
      pending_evaluations: [],
      drafts: [],
      notifications: [],
    },
  };
}

test('identical pending evaluation reminders are consolidated into one inbox item', () => {
  const items = makeSourceItems({
    meta: {
      today: '2026-10-27',
      reporting_date: '2026-10-25',
      has_reporting_record: false,
    },
    capital: { initialized: false },
    workspace: {},
    automation: {
      pending_evaluations: [
        pendingEvaluation(7, 1),
        pendingEvaluation(8, 2),
        pendingEvaluation(13, 4),
      ],
      drafts: [],
      notifications: [],
    },
  });
  const evaluations = items.filter(
    (item) => item.source_type === 'evaluation',
  );
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].title, '评估等待更多收益样本（3 条）');
  assert.deepEqual(evaluations[0].metadata.evaluation_ids, [7, 8, 13]);
  assert.deepEqual(evaluations[0].metadata.decision_ids, [1, 2, 4]);
});

test('evaluation reminders with different evidence states stay separate', () => {
  const items = makeSourceItems({
    meta: {
      today: '2026-10-27',
      reporting_date: '2026-10-25',
      has_reporting_record: false,
    },
    capital: { initialized: false },
    workspace: {},
    automation: {
      pending_evaluations: [
        pendingEvaluation(7, 1),
        {
          ...pendingEvaluation(8, 2),
          evidence: { decision_missing_fields: ['reason'] },
        },
      ],
      drafts: [],
      notifications: [],
    },
  });
  const evaluations = items.filter(
    (item) => item.source_type === 'evaluation',
  );
  assert.equal(evaluations.length, 2);
  assert.deepEqual(
    evaluations.map((item) => item.title).sort(),
    ['决策证据待补充', '评估等待更多收益样本'].sort(),
  );
});

test('consecutive reconciliation dates with the same missing products are merged', () => {
  const items = makeSourceItems(
    dashboardWithReconciliations([
      productReconciliation('2026-10-25'),
      productReconciliation('2026-10-24'),
    ]),
  );
  const reconciliations = items.filter(
    (item) => item.source_type === 'product_valuation_reconciliation',
  );
  assert.equal(reconciliations.length, 1);
  assert.equal(reconciliations[0].title, '产品收益待补（10/24—10/25）');
  assert.deepEqual(reconciliations[0].metadata.account_dates, [
    '2026-10-24',
    '2026-10-25',
  ]);
  assert.match(reconciliations[0].summary, /当前已入账或覆盖 1\/3 只/);
  assert.match(reconciliations[0].summary, /10\/24 ¥1\.21、10\/25 ¥1\.21/);
  assert.doesNotMatch(reconciliations[0].summary, /。。/);
});

test('reconciliation groups do not merge different missing products or boundary states', () => {
  const items = makeSourceItems(
    dashboardWithReconciliations([
      productReconciliation('2026-10-25', {
        missing_product_codes: ['120056A'],
      }),
      productReconciliation('2026-10-24', {
        missing_product_codes: ['120026A'],
      }),
      productReconciliation('2026-10-23', {
        missing_product_codes: ['107320A'],
        same_day_redeemed_product_codes: ['107320A'],
      }),
    ]),
  );
  const reconciliations = items.filter(
    (item) => item.source_type === 'product_valuation_reconciliation',
  );
  assert.equal(reconciliations.length, 3);
  assert.ok(
    reconciliations.some(
      (item) =>
        item.title === '产品收益待核对（10/23）' &&
        item.summary.includes('需确认当日是否计息'),
    ),
  );
});

test('same missing products stay separate when only one date is a redemption boundary', () => {
  const items = makeSourceItems(
    dashboardWithReconciliations([
      productReconciliation('2026-10-24', {
        missing_product_codes: ['107320A'],
      }),
      productReconciliation('2026-10-23', {
        missing_product_codes: ['107320A'],
        same_day_redeemed_product_codes: ['107320A'],
      }),
    ]),
  );
  const reconciliations = items.filter(
    (item) => item.source_type === 'product_valuation_reconciliation',
  );
  assert.equal(reconciliations.length, 2);
  assert.ok(
    reconciliations.some(
      (item) =>
        item.title === '产品收益待核对（10/23）' &&
        item.summary.includes('需确认当日是否计息'),
    ),
  );
  assert.ok(
    reconciliations.some(
      (item) =>
        item.title === '产品收益待补（10/24）' &&
        !item.summary.includes('当日是否计息'),
    ),
  );
});

test('a projection mismatch remains visible as a repair action', () => {
  const items = makeSourceItems(
    dashboardWithReconciliations([
      productReconciliation('2026-10-26', {
        status: 'mismatch',
        missing_product_codes: [],
        covered_product_codes: ['120056A', '120026A'],
        covered_product_count: 2,
        product_pnl: 1.21,
        account_pnl: 1.2,
        difference: -0.01,
      }),
    ]),
  );
  const mismatch = items.find(
    (item) =>
      item.source_type === 'product_valuation_reconciliation' &&
      item.metadata.account_date === '2026-10-26',
  );
  assert.ok(mismatch);
  assert.equal(mismatch.title, '账户收益投影需修复（10/26）');
  assert.match(mismatch.summary, /产品合计 ¥1\.21/);
  assert.match(mismatch.summary, /账户投影 ¥1\.20/);
  assert.match(mismatch.summary, /差额 -¥0\.01/);
});

test('inbox sync replaces old daily items with a group and deletes it after resolution', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'r2-inbox-reconciliation-'),
  );
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: null,
    logger: { warn() {}, info() {} },
  });
  t.after(() => {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  repository.inboxCenter.sync(
    dashboardWithReconciliations([productReconciliation('2026-10-24')]),
  );
  const initialItem = repository.inboxCenter
    .getWorkspace('2026-10-28')
    .pending.find(
      (item) => item.source_type === 'product_valuation_reconciliation',
    );
  assert.ok(initialItem);

  repository.inboxCenter.sync(
    dashboardWithReconciliations([
      productReconciliation('2026-10-25'),
      productReconciliation('2026-10-24'),
    ]),
  );
  const afterGrouping = repository.inboxCenter.getWorkspace('2026-10-28');
  assert.equal(
    afterGrouping.items.find((item) => item.id === initialItem.id).status,
    'active',
  );
  const grouped = afterGrouping.pending.find(
    (item) => item.source_type === 'product_valuation_reconciliation',
  );
  assert.ok(grouped);
  assert.equal(grouped.id, initialItem.id);
  assert.equal(grouped.dedupe_key, initialItem.dedupe_key);
  assert.deepEqual(grouped.metadata.account_dates, [
    '2026-10-24',
    '2026-10-25',
  ]);

  repository.inboxCenter.sync(dashboardWithReconciliations([]));
  const completed = repository.inboxCenter.getWorkspace('2026-10-28');
  assert.equal(
    completed.items.some((item) => item.id === grouped.id),
    false,
  );
  assert.deepEqual(completed.handled, []);
  assert.equal(completed.summary.handled_count, 0);
  assert.equal(
    completed.pending.some(
      (item) => item.source_type === 'product_valuation_reconciliation',
    ),
    false,
  );
  assert.equal(
    repository.db
      .prepare('SELECT 1 FROM inbox_items WHERE id = ?')
      .get(grouped.id),
    undefined,
  );

  repository.inboxCenter.sync(
    dashboardWithReconciliations([productReconciliation('2026-10-24')]),
  );
  const reopened = repository.inboxCenter
    .getWorkspace('2026-10-28')
    .pending.find(
      (item) => item.source_type === 'product_valuation_reconciliation',
    );
  assert.ok(reopened);
  assert.notEqual(reopened.id, grouped.id);
});

test('inbox sync purges resolved projections created by older releases', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'r2-inbox-resolved-cleanup-'),
  );
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: null,
    logger: { warn() {}, info() {} },
  });
  t.after(() => {
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  repository.inboxCenter.sync(
    dashboardWithReconciliations([productReconciliation('2026-10-24')]),
  );
  const item = repository.inboxCenter
    .getWorkspace('2026-10-28')
    .pending.find(
      (entry) => entry.source_type === 'product_valuation_reconciliation',
    );
  assert.ok(item);
  repository.db
    .prepare(
      `UPDATE inbox_items
       SET status = 'resolved', resolved_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run('2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z', item.id);

  repository.inboxCenter.sync(dashboardWithReconciliations([]));
  const workspace = repository.inboxCenter.getWorkspace('2026-10-28');
  assert.deepEqual(workspace.items, []);
  assert.deepEqual(workspace.handled, []);
  assert.equal(
    repository.db.prepare('SELECT COUNT(*) AS count FROM inbox_items').get()
      .count,
    0,
  );
});

test('rollover decisions hide maturity reminders and matured evaluation notices', () => {
  const rolloverDecision = {
    id: 15,
    review_meta: {
      rollover: true,
      holding_code: 'JX040210',
      matured_trade_ids: [7, 11],
    },
  };
  const items = makeSourceItems({
    meta: {
      today: '2026-11-04',
      reporting_date: '2026-11-02',
      has_reporting_record: true,
    },
    capital: { initialized: true },
    workspace: {
      decisions: [rolloverDecision],
      holding_reviews: [
        {
          lot_id: '7:JX040210',
          product_code: 'JX040210',
          product_name: '建信理财嘉鑫固收类最低持有7天产品第6期',
          verdict: 'watch',
          maturity_date: '2026-10-30',
          reminder: {
            level: 'urgent',
            kind: 'maturity',
            text: '已到期 5 天，需处理赎回或续作',
          },
          decision: rolloverDecision,
        },
        {
          lot_id: '13:120019K',
          product_code: '120019K',
          product_name: '招银理财招睿添金7天持有期9号固定收益类理财计划',
          verdict: 'hold',
          maturity_date: '2026-11-10',
          reminder: {
            level: 'window',
            kind: 'maturity',
            text: '距到期 6 天，进入替换/续作比较窗口',
          },
          decision: null,
        },
      ],
      trades: {
        trades: [
          { id: 7, product_code: 'JX040210' },
          { id: 11, product_code: 'JX040210' },
          { id: 12, product_code: 'JX040210' },
          { id: 15, product_code: 'JX040210' },
        ],
      },
    },
    automation: {
      pending_evaluations: [
        { ...pendingEvaluation(20, 2), trade_id: 7 },
        { ...pendingEvaluation(30, 3), trade_id: 11 },
        { ...pendingEvaluation(33, 9), trade_id: 15 },
        {
          ...pendingEvaluation(34, 3),
          trade_id: 12,
          summary:
            '建信理财嘉鑫固收类最低持有7天产品第6期 已于 2026-11-09 到期，仍显示 4000.00 元本金未赎回；实际年化和资金可用性需要赎回/到账记录。',
        },
      ],
      drafts: [],
      notifications: [],
    },
  });
  const reviews = items.filter((item) => item.source_type === 'holding_review');
  assert.equal(reviews.length, 0, '到期与赎回窗口默认续作，不再生成提醒');
  const evaluations = items.filter((item) => item.source_type === 'evaluation');
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].metadata.evaluation_id, 33);
  assert.ok(
    evaluations.every((item) => item.metadata.evaluation_id !== 34),
    '同一续作产品后续批次的到期未赎回提醒应被隐藏',
  );
});

test('strategy projection is merged into the message center with its stable key', () => {
  const items = makeSourceItems({
    meta: { today: '2026-11-08', reporting_date: '2026-11-08', has_reporting_record: true },
    capital: { initialized: false },
    workspace: {},
    automation: { pending_evaluations: [], drafts: [], notifications: [] },
    strategy_inbox: [
      {
        dedupe_key: 'r2-strategy:message-exit-1',
        source_type: 'r2_strategy_holding',
        source_id: 'lot:120056A:2026-10-01',
        category: 'action',
        severity: 'urgent',
        title: '续持不达标：120056A',
        summary: '有效近1月年化 1.82%，低于2.15%续持门槛。',
        action_label: '确认退出',
        action_url: '/ledger/products?section=holdings&lot=lot%3A120056A%3A2026-10-01',
        metadata: { lot_id: 'lot:120056A:2026-10-01' },
      },
    ],
  });
  const strategy = items.filter((item) => item.source_type === 'r2_strategy_holding');
  assert.equal(strategy.length, 1);
  assert.equal(strategy[0].dedupe_key, 'r2-strategy:message-exit-1');
  assert.equal(strategy[0].severity, 'urgent');
  assert.equal(strategy[0].metadata.lot_id, 'lot:120056A:2026-10-01');
});
