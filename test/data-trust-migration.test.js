'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('../lib/db');
const {
  DDL_PATH,
  MIGRATION_ID,
  migrationStatus,
  runDataTrustMigration,
  verifyMigration,
} = require('../lib/data-trust-migration');
const { createTestContext, initializeCapital } = require('./helpers/test-context');
const { startTestServer } = require('./helpers/test-context');
const { productCsv } = require('./fixtures');

test('bundled data trust migration SQL is available at runtime path', () => {
  assert.equal(
    DDL_PATH,
    path.resolve(
      __dirname,
      '../server/modules/data-trust/migrations/001-data-trust-v1.up.sql',
    ),
  );
  assert.equal(
    fs.existsSync(DDL_PATH),
    true,
    `missing data trust migration SQL: ${DDL_PATH}`,
  );
});

function createDeferredDatabase(t, seed) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'r2-data-trust-migration-'),
  );
  const dbPath = path.join(directory, 'legacy.sqlite');
  const tradeInboxDir = path.join(directory, 'trade-inbox');
  const incomeInboxDir = path.join(directory, 'income-inbox');
  fs.mkdirSync(tradeInboxDir, { recursive: true });
  fs.mkdirSync(incomeInboxDir, { recursive: true });
  const repository = openDatabase({
    dbPath,
    productCsvPath: productCsv,
    tradeInboxDir,
    incomeInboxDir,
    migrationPolicy: 'defer',
    logger: { warn() {}, info() {} },
  });
  try {
    seed(repository, { directory, dbPath, tradeInboxDir, incomeInboxDir });
  } finally {
    repository.close();
  }
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { dbPath, tradeInboxDir, incomeInboxDir, directory };
}

test('data trust migration backfills evidence, revisions, links and preserves facts', (t) => {
  const image = Buffer.from('income screenshot fixture');
  const sha256 = crypto.createHash('sha256').update(image).digest('hex');
  const paths = createDeferredDatabase(t, (repository, context) => {
    repository.initializeCapital(30000, '2026-10-01', 'test');
    fs.writeFileSync(path.join(context.incomeInboxDir, 'income.png'), image);
    const inbox = repository.incomeStore.addInbox({
      original_name: 'income.png',
      stored_name: 'income.png',
      mime: 'image/png',
      bytes: image.length,
      sha256,
      ocr_text: '2026-10-12 账户收益 5.00',
      parsed: {
        date: '2026-10-12',
        daily_pnl: 5,
        confidence: 95,
      },
      parse_confidence: 95,
      record_date: '2026-10-12',
    });
    repository.createRecord({
      date: '2026-10-12',
      daily_pnl: 5,
      action: '无操作',
      notes: 'legacy income',
      source: 'income-screenshot',
      screenshot_id: inbox.id,
    });
    repository.productValuationStore.upsertValuation({
      valuation_date: '2026-10-12',
      credit_date: '2026-10-12',
      yield_date: '2026-10-12',
      product_code: '120056A',
      product_name: '测试产品',
      holding_amount: 1000,
      daily_pnl: 5,
      source: 'income-screenshot',
      screenshot_id: inbox.id,
      confidence: 95,
    });
    repository.incomeStore.updateInbox(inbox.id, {
      status: 'applied',
      applied_at: '2026-10-12T01:00:00.000Z',
    });
  });

  const db = new DatabaseSync(paths.dbPath);
  let result;
  try {
    result = runDataTrustMigration(db, {
      dbPath: paths.dbPath,
      tradeInboxDir: paths.tradeInboxDir,
      incomeInboxDir: paths.incomeInboxDir,
      apply: true,
    });
    const second = runDataTrustMigration(db, {
      dbPath: paths.dbPath,
      tradeInboxDir: paths.tradeInboxDir,
      incomeInboxDir: paths.incomeInboxDir,
      apply: true,
    });
    assert.equal(second.applied, false);
    assert.equal(migrationStatus(db).status, 'completed');
  } finally {
    db.close();
  }

  assert.equal(result.report.ok, true);
  assert.equal(result.report.business_fingerprint_match, true);
  assert.equal(result.report.counts.evidence_assets, 1);
  assert.ok(result.report.counts.fact_revisions >= 3);
  assert.equal(result.report.counts.fact_evidence_links, 2);

  const repository = openDatabase({
    dbPath: paths.dbPath,
    productCsvPath: productCsv,
    tradeInboxDir: paths.tradeInboxDir,
    incomeInboxDir: paths.incomeInboxDir,
    migrationPolicy: 'require',
    logger: { warn() {}, info() {} },
  });
  try {
    const [inbox] = repository.listIncomeScreenshots();
    assert.equal(inbox.workflow_state, 'posted');
    assert.ok(inbox.evidence_id);
    assert.ok(inbox.selected_event_id);
    const trace = repository.dataTrustStore.traceFact(
      'account_income',
      'account_income:1',
    );
    assert.equal(trace.evidence_status, 'complete');
    assert.equal(trace.revisions.length, 1);
    assert.equal(trace.evidence_links.length, 1);
    assert.equal(
      repository.dataTrustStore.traceEvidence(inbox.evidence_id).events[0]
        .event_type,
      'legacy_snapshot',
    );
  } finally {
    repository.close();
  }
});

test('migration failure rolls back feature schema and leaves a retryable status', (t) => {
  const paths = createDeferredDatabase(t, (repository) => {
    repository.initializeCapital(30000, '2026-10-01', 'test');
    repository.incomeStore.addInbox({
      original_name: 'failure.png',
      stored_name: '',
      mime: 'image/png',
      bytes: 1,
      sha256: 'a'.repeat(64),
      parsed: {},
      parse_confidence: 0,
    });
  });
  const db = new DatabaseSync(paths.dbPath);
  try {
    db.exec(`
      CREATE TRIGGER fail_income_lineage
      BEFORE UPDATE ON income_inbox
      BEGIN
        SELECT RAISE(ABORT, 'injected lineage failure');
      END;
    `);
    assert.throws(
      () =>
        runDataTrustMigration(db, {
          dbPath: paths.dbPath,
          tradeInboxDir: paths.tradeInboxDir,
          incomeInboxDir: paths.incomeInboxDir,
          apply: true,
        }),
      /injected lineage failure|migration failed/,
    );
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    assert.equal(tables.has('schema_migrations'), true);
    assert.equal(tables.has('evidence_assets'), false);
    assert.equal(
      db.prepare('SELECT status FROM schema_migrations WHERE id = ?').get(
        MIGRATION_ID,
      ).status,
      'failed',
    );
    assert.equal(migrationStatus(db).schema.partial, false);

    db.exec('DROP TRIGGER fail_income_lineage');
    const retried = runDataTrustMigration(db, {
      dbPath: paths.dbPath,
      tradeInboxDir: paths.tradeInboxDir,
      incomeInboxDir: paths.incomeInboxDir,
      apply: true,
    });
    assert.equal(retried.applied, true);
    assert.equal(verifyMigration(db).ok, true);
  } finally {
    db.close();
  }
});

test('same account total still posts missing product details atomically', (t) => {
  const context = createTestContext(t);
  initializeCapital(context.repository);
  context.repository.createRecord({
    date: '2026-10-20',
    daily_pnl: 2,
    action: '无操作',
    notes: 'existing total',
  });
  const inbox = context.repository.incomeStore.addInbox({
    original_name: 'same-total.png',
    stored_name: '',
    mime: 'image/png',
    bytes: 1,
    sha256: 'same-total-screenshot',
    parsed: {
      date: '2026-10-20',
      daily_pnl: 2,
      products: [
        {
          product_code: '120056A',
          product_name: '测试产品',
          holding_amount: 1000,
          daily_pnl: 2,
        },
      ],
    },
    parse_confidence: 95,
  });
  const result = context.repository.applyIncomeScreenshot(
    inbox.id,
    {},
    { today: '2026-10-23', actorType: 'human' },
  );
  assert.equal(result.duplicate, true);
  assert.equal(result.ignored, false);
  assert.equal(result.saved_valuations.length, 1);
  assert.equal(result.inbox.workflow_state, 'posted');
  assert.equal(
    context.repository.productValuationStore.getValuationByKey(
      '120056A',
      '2026-10-20',
    ).daily_pnl,
    2,
  );
  const productTrace = context.repository.dataTrustStore.traceFact(
    'product_income',
    `product_income:${result.saved_valuations[0].id}`,
  );
  assert.equal(productTrace.revisions.length, 1);
  assert.equal(productTrace.evidence_links.length, 1);
});

test('data trust trace APIs expose evidence and fact lineage', async (t) => {
  const previousOcr = process.env.R2_OCR;
  process.env.R2_OCR = '0';
  t.after(() => {
    if (previousOcr === undefined) delete process.env.R2_OCR;
    else process.env.R2_OCR = previousOcr;
  });
  const { baseUrl, repository } = await startTestServer(t);
  const post = (url, body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  await post(`${baseUrl}/api/capital/init`, {
    initial_principal: 30000,
    initial_date: '2026-10-01',
  });
  const inbox = repository.incomeStore.addInbox({
    original_name: 'trace.png',
    stored_name: '',
    mime: 'image/png',
    bytes: 1,
    sha256: 'trace-evidence',
    parsed: {
      date: '2026-10-20',
      daily_pnl: 1.5,
      products: [],
    },
    parse_confidence: 90,
  });
  const appliedResponse = await post(
    `${baseUrl}/api/income/inbox/${inbox.id}/apply`,
    { date: '2026-10-20', daily_pnl: 1.5, products: [] },
  );
  assert.equal(appliedResponse.status, 200);
  const applied = await appliedResponse.json();

  const evidenceResponse = await fetch(
    `${baseUrl}/api/evidence/${applied.inbox.evidence_id}/trace`,
  );
  assert.equal(evidenceResponse.status, 200);
  const evidenceTrace = await evidenceResponse.json();
  assert.ok(evidenceTrace.evidence_trace.events.length >= 1);
  assert.equal(
    evidenceTrace.evidence_trace.events.some(
      (item) => item.event_type === 'human_corrected',
    ),
    true,
  );
  assert.equal(
    evidenceTrace.evidence_trace.fact_links.some(
      (item) => item.fact_type === 'account_income',
    ),
    true,
  );

  const factKey = encodeURIComponent(
    `account_income:${applied.record.id}`,
  );
  const factResponse = await fetch(
    `${baseUrl}/api/facts/account_income/${factKey}/trace`,
  );
  assert.equal(factResponse.status, 200);
  const factTrace = await factResponse.json();
  assert.equal(factTrace.fact_trace.revisions.length, 1);
  assert.equal(factTrace.fact_trace.evidence_links.length, 1);

  const statusResponse = await fetch(`${baseUrl}/api/data-trust/status`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.migration.status, 'completed');
  assert.equal(status.verification.ok, true);
});

test('linked evidence is retained when old screenshot pruning runs', (t) => {
  const context = createTestContext(t);
  initializeCapital(context.repository);
  const image = Buffer.from('retained screenshot');
  const sha256 = crypto.createHash('sha256').update(image).digest('hex');
  fs.writeFileSync(
    path.join(context.incomeInboxDir, 'retained.png'),
    image,
  );
  const inbox = context.repository.incomeStore.addInbox({
    original_name: 'retained.png',
    stored_name: 'retained.png',
    mime: 'image/png',
    bytes: image.length,
    sha256,
    parsed: { date: '2026-10-20', daily_pnl: 2, products: [] },
    parse_confidence: 95,
  });
  context.repository.applyIncomeScreenshot(
    inbox.id,
    { date: '2026-10-20', daily_pnl: 2, products: [] },
    { today: '2026-10-23', actorType: 'human' },
  );
  context.repository.db
    .prepare('UPDATE income_inbox SET received_at = ? WHERE id = ?')
    .run('2020-01-01T00:00:00.000Z', inbox.id);
  const result = context.repository.incomeStore.pruneScreenshots({
    today: '2026-10-23',
    olderThanDays: 180,
  });
  assert.equal(result.removed, 0);
  assert.equal(
    fs.existsSync(path.join(context.incomeInboxDir, 'retained.png')),
    true,
  );
});

test('account updates and deletes keep before and after revisions', (t) => {
  const context = createTestContext(t);
  initializeCapital(context.repository);
  const created = context.repository.createRecord({
    date: '2026-10-20',
    daily_pnl: 1,
    action: '无操作',
    notes: 'created',
  });
  context.repository.updateRecord('2026-10-20', {
    daily_pnl: 2,
    action: '无操作',
    notes: 'updated',
  });
  context.repository.deleteRecord('2026-10-20');
  const trace = context.repository.dataTrustStore.traceFact(
    'account_income',
    `account_income:${created.id}`,
  );
  assert.deepEqual(
    trace.revisions.map((item) => item.action),
    ['delete', 'update', 'create'],
  );
  assert.equal(trace.revisions[1].before.daily_pnl, 1);
  assert.equal(trace.revisions[1].after.daily_pnl, 2);
});

test('capital, trade and decision writes produce linked revision histories', (t) => {
  const context = createTestContext(t);
  initializeCapital(context.repository);
  const event = context.repository.createCapitalEvent({
    date: '2026-09-10',
    type: 'deposit',
    amount: 1000,
    note: '追加本金',
  });
  const capitalTrace = context.repository.dataTrustStore.traceFact(
    'capital_event',
    `capital_event:${event.id}`,
  );
  assert.equal(capitalTrace.revisions.length, 1);
  assert.equal(capitalTrace.revisions[0].after.amount, 1000);

  const decision = context.repository.createDecision({
    date: '2026-10-01',
    product_name: '测试产品',
    action: '观察',
    reason: '测试来源链',
    expectation: '保持流动性',
    invalidation_condition: '规则变化',
    strategy_version: 'r2-3pct-v1',
    target_annualized: 3,
    bucket_plan: { short: 30, medium: 35, long: 35 },
    evaluation_at: ['buy_day'],
    evidence_date: '2026-10-01',
    verify_date: '2026-10-15',
    review_meta: {},
    rating: '待评估',
  });
  context.repository.updateDecision(decision.id, {
    ...decision,
    reason: '测试来源链修正',
    correction_note: '补充理由',
  });
  const decisionTrace = context.repository.dataTrustStore.traceFact(
    'decision',
    `decision:${decision.id}`,
  );
  assert.equal(decisionTrace.revisions.length, 2);
  assert.equal(decisionTrace.revisions[0].reason, '补充理由');

  const trade = context.repository.tradeStore.createTrade({
    trade_date: '2026-10-02',
    confirm_date: null,
    trade_type: 'buy',
    status: 'pending',
    product_code: '120056A',
    product_name: '测试产品',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: 1000,
    term_days: 30,
    source: 'manual',
    notes: '',
    decision_id: decision.id,
  });
  context.repository.tradeStore.confirmTrade(
    trade.id,
    '2026-10-03',
    '测试确认',
  );
  const tradeTrace = context.repository.dataTrustStore.traceFact(
    'trade',
    `trade:${trade.id}`,
  );
  assert.equal(tradeTrace.revisions.length, 2);
  assert.deepEqual(
    tradeTrace.revisions.map((item) => item.action),
    ['confirm', 'create'],
  );
});

test('concurrent income apply requests converge to one formal fact', async (t) => {
  const previousOcr = process.env.R2_OCR;
  process.env.R2_OCR = '0';
  t.after(() => {
    if (previousOcr === undefined) delete process.env.R2_OCR;
    else process.env.R2_OCR = previousOcr;
  });
  const { baseUrl, repository } = await startTestServer(t);
  const post = (url, body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  await post(`${baseUrl}/api/capital/init`, {
    initial_principal: 30000,
    initial_date: '2026-10-01',
  });
  const inbox = repository.incomeStore.addInbox({
    original_name: 'concurrent.png',
    stored_name: '',
    mime: 'image/png',
    bytes: 1,
    sha256: 'concurrent-income',
    parsed: {
      date: '2026-10-20',
      daily_pnl: 2,
      products: [
        {
          product_code: '120056A',
          product_name: '测试产品',
          holding_amount: 1000,
          daily_pnl: 2,
        },
      ],
    },
    parse_confidence: 95,
  });
  const body = {
    date: '2026-10-20',
    daily_pnl: 2,
    products: [
      {
        product_code: '120056A',
        product_name: '测试产品',
        holding_amount: 1000,
        daily_pnl: 2,
      },
    ],
  };
  const responses = await Promise.all([
    post(`${baseUrl}/api/income/inbox/${inbox.id}/apply`, body),
    post(`${baseUrl}/api/income/inbox/${inbox.id}/apply`, body),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  );
  assert.equal(repository.listRecords().length, 1);
  assert.equal(
    repository.productValuationStore.listValuations({
      productCode: '120056A',
    }).length,
    1,
  );
  const item = repository.incomeStore.getInboxItem(inbox.id);
  assert.ok(['posted', 'duplicate_resolved'].includes(item.workflow_state));
  const events = repository.dataTrustStore.traceEvidence(item.evidence_id);
  assert.equal(
    events.events.filter((event) => event.event_type === 'posted').length,
    1,
  );
});

test('data trust off mode remains a compatible logical rollback', (t) => {
  const context = createTestContext(t, { dataTrustMode: 'off' });
  initializeCapital(context.repository);
  const inbox = context.repository.incomeStore.addInbox({
    original_name: 'rollback.png',
    stored_name: '',
    mime: 'image/png',
    bytes: 1,
    sha256: 'rollback-evidence',
    parsed: {
      date: '2026-10-20',
      daily_pnl: 1,
      products: [],
    },
    parse_confidence: 90,
  });
  const result = context.repository.applyIncomeScreenshot(
    inbox.id,
    { date: '2026-10-20', daily_pnl: 1, products: [] },
    { today: '2026-10-23' },
  );
  assert.equal(result.record.daily_pnl, 1);
  assert.equal(result.inbox.status, 'applied');
  assert.equal(result.inbox.evidence_id, null);
  assert.equal(
    context.repository.db
      .prepare('SELECT COUNT(*) AS n FROM evidence_assets')
      .get().n,
    0,
  );
});
