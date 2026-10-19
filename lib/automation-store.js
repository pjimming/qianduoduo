'use strict';

const { buildHoldingsSummary } = require('./review-store');
const {
  buildReview,
  enrichRecords,
  round,
  todayShanghai,
} = require('./metrics');

const DAY_MS = 24 * 60 * 60 * 1000;
const RULE_VERSION = 'r2-eval-v1';
const AUTO_MARK = '[自动评估]';

const DEFAULT_SETTINGS = {
  target_annualized: 3.0,
  hurdle_short: 2.5,
  hurdle_medium: 2.8,
  hurdle_long: 3.0,
  liquidity_floor_pct: 30,
  single_product_cap_pct: 30,
  bucket_tolerance_pp: 10,
  auto_confidence_threshold: 75,
  scheduler_minutes: 5,
  rule_version: RULE_VERSION,
  strategy_version: 'r2-3pct-v1',
  notifications_enabled: true,
  automation_enabled: true,
};

const AUTOMATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS evaluation_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS evaluation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL CHECK (scope IN ('decision', 'trade')),
    decision_id INTEGER,
    trade_id INTEGER,
    stage TEXT NOT NULL CHECK (stage IN ('buy_day', 'holding', 'maturity')),
    period TEXT NOT NULL,
    evaluated_for TEXT NOT NULL,
    rule_version TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'automation',
    confidence INTEGER NOT NULL DEFAULT 0,
    confidence_level TEXT NOT NULL DEFAULT 'low',
    process_ok INTEGER,
    outcome TEXT NOT NULL DEFAULT 'unknown' CHECK (
      outcome IN ('good', 'bad', 'unknown')
    ),
    rating TEXT NOT NULL DEFAULT '待评估',
    summary TEXT NOT NULL DEFAULT '',
    evidence_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'auto', 'confirmed', 'undone')
    ),
    previous_rating TEXT,
    previous_actual_result TEXT,
    applied_rating TEXT,
    applied_actual_result TEXT,
    applied_at TEXT,
    undone_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_evaluation_runs_decision
    ON evaluation_runs(decision_id, stage, evaluated_for DESC);

  CREATE INDEX IF NOT EXISTS idx_evaluation_runs_status
    ON evaluation_runs(status, created_at DESC);

  CREATE TABLE IF NOT EXISTS review_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_type TEXT NOT NULL CHECK (period_type IN ('monthly', 'quarterly')),
    period TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (
      status IN ('draft', 'confirmed')
    ),
    content_json TEXT NOT NULL DEFAULT '{}',
    generated_at TEXT NOT NULL,
    confirmed_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(period_type, period)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn')),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    read_at TEXT,
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_open
    ON notifications(resolved_at, level, created_at DESC);

  CREATE TABLE IF NOT EXISTS automation_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN ('pending', 'running', 'done', 'skipped', 'failed')
    ),
    payload_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT NOT NULL DEFAULT '{}',
    note TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_automation_jobs_status
    ON automation_jobs(status, created_at ASC);

  CREATE TABLE IF NOT EXISTS automation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    summary_json TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT ''
  );
`;

function parseYmd(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const [year, month, day] = value.split('-').map(Number);
  const stamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(stamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return stamp;
}

function addDays(date, days) {
  const stamp = parseYmd(date);
  if (stamp === null) return null;
  return new Date(stamp + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const start = parseYmd(from);
  const end = parseYmd(to);
  if (start === null || end === null) return 0;
  return Math.round((end - start) / DAY_MS);
}

function shiftMonth(month, delta) {
  const [year, monthNumber] = month.split('-').map(Number);
  const stamp = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${stamp.getUTCFullYear()}-${String(stamp.getUTCMonth() + 1).padStart(
    2,
    '0',
  )}`;
}

function quarterOf(date) {
  const month = Number(date.slice(5, 7));
  return `${date.slice(0, 4)}-Q${Math.floor((month - 1) / 3) + 1}`;
}

function shiftQuarter(quarter, delta) {
  const year = Number(quarter.slice(0, 4));
  const number = Number(quarter.slice(6, 7));
  const stamp = new Date(Date.UTC(year, (number - 1 + delta) * 3, 1));
  return `${stamp.getUTCFullYear()}-Q${Math.floor(stamp.getUTCMonth() / 3) + 1}`;
}

function quarterMonths(quarter) {
  const year = quarter.slice(0, 4);
  const number = Number(quarter.slice(6, 7));
  return [0, 1, 2].map(
    (offset) => `${year}-${String((number - 1) * 3 + offset + 1).padStart(2, '0')}`,
  );
}

function bucketOf(termDays) {
  if (termDays === null || termDays === undefined) return 'unknown';
  if (termDays <= 30) return 'short';
  if (termDays <= 100) return 'medium';
  return 'long';
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function confidenceLevel(value) {
  if (value >= 75) return 'high';
  if (value >= 50) return 'medium';
  return 'low';
}

function ratingFor(processOk, outcome) {
  if (processOk === null || processOk === undefined) return '待评估';
  if (outcome === 'unknown') return '待评估';
  if (processOk && outcome === 'good') return '流程正确，结果好';
  if (processOk && outcome === 'bad') return '流程正确，结果差';
  if (!processOk && outcome === 'good') return '流程错误，结果好';
  return '流程错误，结果差';
}

function stagePriority(stage) {
  if (stage === 'maturity') return 3;
  if (stage === 'holding') return 2;
  return 1;
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    dedupe_key: row.dedupe_key,
    scope: row.scope,
    decision_id: row.decision_id === null ? null : Number(row.decision_id),
    trade_id: row.trade_id === null ? null : Number(row.trade_id),
    stage: row.stage,
    period: row.period,
    evaluated_for: row.evaluated_for,
    rule_version: row.rule_version,
    source: row.source || 'automation',
    confidence: Number(row.confidence),
    confidence_level: row.confidence_level,
    process_ok: row.process_ok === null ? null : Boolean(row.process_ok),
    outcome: row.outcome,
    rating: row.rating,
    summary: row.summary,
    evidence: parseJson(row.evidence_json, {}),
    status: row.status,
    previous_rating: row.previous_rating || null,
    previous_actual_result: row.previous_actual_result || null,
    applied_rating: row.applied_rating || null,
    applied_actual_result: row.applied_actual_result || null,
    applied_at: row.applied_at || null,
    undone_at: row.undone_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapDraft(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    period_type: row.period_type,
    period: row.period,
    status: row.status,
    content: parseJson(row.content_json, {}),
    generated_at: row.generated_at,
    confirmed_at: row.confirmed_at || null,
    updated_at: row.updated_at,
  };
}

function mapNotification(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    dedupe_key: row.dedupe_key,
    kind: row.kind,
    level: row.level,
    title: row.title,
    message: row.message,
    data: parseJson(row.data_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    read_at: row.read_at || null,
    resolved_at: row.resolved_at || null,
  };
}

function mapJob(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    dedupe_key: row.dedupe_key,
    job_type: row.job_type,
    status: row.status,
    payload: parseJson(row.payload_json, {}),
    result: parseJson(row.result_json, {}),
    note: row.note || '',
    attempts: Number(row.attempts),
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at || null,
  };
}

function mapAutomationRun(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    trigger: row.trigger,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at || null,
    summary: parseJson(row.summary_json, {}),
    error: row.error || '',
  };
}

function createAutomationStore(db, options = {}) {
  const tradeStore = options.tradeStore;
  const reviewStore = options.reviewStore;
  if (!tradeStore || !reviewStore) {
    throw new Error('createAutomationStore 需要 tradeStore 和 reviewStore');
  }
  const logger = options.logger || console;
  db.exec(AUTOMATION_SCHEMA);
  const runColumns = new Set(
    db
      .prepare('PRAGMA table_info(evaluation_runs)')
      .all()
      .map((column) => column.name),
  );
  if (!runColumns.has('source')) {
    db.exec(
      "ALTER TABLE evaluation_runs ADD COLUMN source TEXT NOT NULL DEFAULT 'automation'",
    );
  }
  let running = false;

  const selectSetting = db.prepare(
    'SELECT * FROM evaluation_settings WHERE key = ?',
  );
  const upsertSetting = db.prepare(`
    INSERT INTO evaluation_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const selectAllSettings = db.prepare('SELECT * FROM evaluation_settings');

  const selectRuns = db.prepare(`
    SELECT * FROM evaluation_runs ORDER BY created_at DESC, id DESC
  `);
  const selectRunsByStatus = db.prepare(`
    SELECT * FROM evaluation_runs WHERE status = ?
    ORDER BY created_at DESC, id DESC LIMIT ?
  `);
  const selectRun = db.prepare('SELECT * FROM evaluation_runs WHERE id = ?');
  const selectRunByKey = db.prepare(
    'SELECT * FROM evaluation_runs WHERE dedupe_key = ?',
  );
  const selectDecisionRuns = db.prepare(`
    SELECT * FROM evaluation_runs WHERE decision_id = ?
    ORDER BY created_at ASC, id ASC
  `);
  const insertRun = db.prepare(`
    INSERT INTO evaluation_runs (
      dedupe_key, scope, decision_id, trade_id, stage, period, evaluated_for,
      rule_version, source, confidence, confidence_level, process_ok, outcome, rating,
      summary, evidence_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `);
  const updateRun = db.prepare(`
    UPDATE evaluation_runs
    SET confidence = ?, confidence_level = ?, process_ok = ?, outcome = ?,
        rating = ?, summary = ?, evidence_json = ?, updated_at = ?
    WHERE id = ?
  `);
  const updateRunStatus = db.prepare(`
    UPDATE evaluation_runs
    SET status = ?, previous_rating = ?, previous_actual_result = ?,
        applied_rating = ?, applied_actual_result = ?, applied_at = ?,
        undone_at = ?, updated_at = ?
    WHERE id = ?
  `);

  const selectNotifications = db.prepare(`
    SELECT * FROM notifications ORDER BY created_at DESC, id DESC
  `);
  const selectOpenNotifications = db.prepare(`
    SELECT * FROM notifications WHERE resolved_at IS NULL
    ORDER BY CASE level WHEN 'warn' THEN 0 ELSE 1 END, created_at DESC, id DESC
  `);
  const selectNotification = db.prepare('SELECT * FROM notifications WHERE id = ?');
  const selectNotificationByKey = db.prepare(
    'SELECT * FROM notifications WHERE dedupe_key = ?',
  );
  const insertNotification = db.prepare(`
    INSERT INTO notifications (
      dedupe_key, kind, level, title, message, data_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateNotification = db.prepare(`
    UPDATE notifications
    SET level = ?, title = ?, message = ?, data_json = ?, updated_at = ?,
        read_at = ?, resolved_at = ?
    WHERE id = ?
  `);

  const selectJobs = db.prepare(`
    SELECT * FROM automation_jobs ORDER BY created_at DESC, id DESC
  `);
  const selectJobsByStatus = db.prepare(`
    SELECT * FROM automation_jobs WHERE status = ?
    ORDER BY created_at ASC, id ASC LIMIT ?
  `);
  const selectJob = db.prepare('SELECT * FROM automation_jobs WHERE id = ?');
  const selectJobByKey = db.prepare(
    'SELECT * FROM automation_jobs WHERE dedupe_key = ?',
  );
  const insertJob = db.prepare(`
    INSERT INTO automation_jobs (
      dedupe_key, job_type, status, payload_json, created_at, updated_at
    ) VALUES (?, ?, 'pending', ?, ?, ?)
  `);
  const updateJob = db.prepare(`
    UPDATE automation_jobs
    SET status = ?, result_json = ?, note = ?, attempts = attempts + 1,
        updated_at = ?, resolved_at = ?
    WHERE id = ?
  `);

  const selectDrafts = db.prepare(`
    SELECT * FROM review_drafts ORDER BY period DESC, id DESC
  `);
  const selectDraft = db.prepare(`
    SELECT * FROM review_drafts WHERE period_type = ? AND period = ?
  `);
  const selectCapitalInitialDate = db.prepare(
    'SELECT initial_date FROM capital_settings WHERE id = 1',
  );
  const insertDraft = db.prepare(`
    INSERT INTO review_drafts (
      period_type, period, status, content_json, generated_at, updated_at
    ) VALUES (?, ?, 'draft', ?, ?, ?)
  `);
  const updateDraft = db.prepare(`
    UPDATE review_drafts
    SET content_json = ?, updated_at = ?
    WHERE id = ?
  `);
  const confirmDraftStatement = db.prepare(`
    UPDATE review_drafts
    SET status = 'confirmed', confirmed_at = ?, updated_at = ?
    WHERE id = ?
  `);

  const insertAutomationRun = db.prepare(`
    INSERT INTO automation_runs (trigger, status, started_at)
    VALUES (?, 'running', ?)
  `);
  const finishAutomationRun = db.prepare(`
    UPDATE automation_runs
    SET status = ?, finished_at = ?, summary_json = ?, error = ?
    WHERE id = ?
  `);
  const selectAutomationRuns = db.prepare(`
    SELECT * FROM automation_runs ORDER BY id DESC LIMIT ?
  `);

  function getSetting(key) {
    const row = selectSetting.get(key);
    if (!row) return DEFAULT_SETTINGS[key];
    return parseJson(row.value, DEFAULT_SETTINGS[key]);
  }

  function getSettings() {
    const settings = { ...DEFAULT_SETTINGS };
    for (const row of selectAllSettings.all()) {
      settings[row.key] = parseJson(row.value, settings[row.key]);
    }
    return settings;
  }

  function updateSettings(patch) {
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
    const stamp = new Date().toISOString();
    for (const [key, value] of Object.entries(patch || {})) {
      if (!allowed.has(key)) continue;
      if (typeof DEFAULT_SETTINGS[key] === 'number') {
        const number = Number(value);
        if (!Number.isFinite(number)) continue;
        upsertSetting.run(key, JSON.stringify(number), stamp);
      } else if (typeof DEFAULT_SETTINGS[key] === 'boolean') {
        upsertSetting.run(key, JSON.stringify(Boolean(value)), stamp);
      } else {
        upsertSetting.run(key, JSON.stringify(String(value)), stamp);
      }
    }
    return getSettings();
  }

  function listRuns(limit = 100) {
    return selectRuns.all().slice(0, limit).map(mapRun);
  }

  function listPendingRuns(limit = 50) {
    return selectRunsByStatus.all('pending', limit).map(mapRun);
  }

  function getRun(id) {
    return mapRun(selectRun.get(id));
  }

  function listNotifications({ openOnly = false } = {}) {
    return (openOnly ? selectOpenNotifications : selectNotifications)
      .all()
      .map(mapNotification);
  }

  function addNotification(input, activeKeys = null) {
    if (!getSetting('notifications_enabled')) return null;
    const stamp = new Date().toISOString();
    const existing = selectNotificationByKey.get(input.dedupe_key);
    if (existing) {
      if (activeKeys) activeKeys.add(input.dedupe_key);
      if (existing.resolved_at) {
        updateNotification.run(
          input.level || 'info',
          input.title,
          input.message,
          JSON.stringify(input.data || {}),
          stamp,
          null,
          null,
          existing.id,
        );
      }
      return mapNotification(selectNotification.get(existing.id));
    }
    const result = insertNotification.run(
      input.dedupe_key,
      input.kind,
      input.level || 'info',
      input.title,
      input.message,
      JSON.stringify(input.data || {}),
      stamp,
      stamp,
    );
    if (activeKeys) activeKeys.add(input.dedupe_key);
    return mapNotification(selectNotification.get(Number(result.lastInsertRowid)));
  }

  function markNotification(id, action) {
    const item = selectNotification.get(id);
    if (!item) return null;
    const stamp = new Date().toISOString();
    if (action === 'read') {
      updateNotification.run(
        item.level,
        item.title,
        item.message,
        item.data_json,
        stamp,
        item.read_at || stamp,
        item.resolved_at,
        id,
      );
    } else if (action === 'unread') {
      updateNotification.run(
        item.level,
        item.title,
        item.message,
        item.data_json,
        stamp,
        null,
        item.resolved_at,
        id,
      );
    } else if (action === 'resolve') {
      updateNotification.run(
        item.level,
        item.title,
        item.message,
        item.data_json,
        stamp,
        item.read_at || stamp,
        stamp,
        id,
      );
    }
    return mapNotification(selectNotification.get(id));
  }

  function markAllNotificationsRead() {
    const stamp = new Date().toISOString();
    db.prepare(
      'UPDATE notifications SET read_at = COALESCE(read_at, ?), updated_at = ? WHERE resolved_at IS NULL',
    ).run(stamp, stamp);
    return listNotifications({ openOnly: true });
  }

  function listJobs({ status = null, limit = 100 } = {}) {
    return (status
      ? selectJobsByStatus.all(status, limit)
      : selectJobs.all().slice(0, limit)
    ).map(mapJob);
  }

  function enqueueJob(jobType, dedupeKey, payload = {}) {
    const existing = selectJobByKey.get(dedupeKey);
    if (existing) return mapJob(existing);
    const stamp = new Date().toISOString();
    const result = insertJob.run(
      dedupeKey,
      jobType,
      JSON.stringify(payload),
      stamp,
      stamp,
    );
    return mapJob(selectJob.get(Number(result.lastInsertRowid)));
  }

  function resolveJob(id, { status = 'done', result = {}, note = '' } = {}) {
    const job = selectJob.get(id);
    if (!job) return null;
    if (!['done', 'skipped', 'failed'].includes(status)) {
      throw new Error('任务处理状态不正确');
    }
    const stamp = new Date().toISOString();
    updateJob.run(
      status,
      JSON.stringify(result || {}),
      String(note || ''),
      stamp,
      stamp,
      id,
    );
    return mapJob(selectJob.get(id));
  }

  function listDrafts() {
    return selectDrafts.all().map(mapDraft);
  }

  function getDraft(periodType, period) {
    return mapDraft(selectDraft.get(periodType, period));
  }

  function listAutomationRuns(limit = 20) {
    return selectAutomationRuns.all(limit).map(mapAutomationRun);
  }

  function getContext(today = todayShanghai()) {
    const overview = tradeStore.getOverview(today);
    const holdingsSummary = buildHoldingsSummary(overview.holdings, today);
    const records = db
      .prepare('SELECT * FROM daily_records ORDER BY record_date ASC')
      .all()
      .map((row) => ({
        date: row.record_date,
        principal: Number(row.principal),
        daily_pnl: Number(row.daily_pnl),
        action: row.action,
        notes: row.notes,
      }));
    const initialDate = selectCapitalInitialDate.get()?.initial_date ?? null;
    const review = buildReview(enrichRecords(records), today, { initialDate });
    return {
      today,
      overview,
      holdings: overview.holdings,
      holdingsSummary,
      decisions: reviewStore.listDecisions(),
      events: reviewStore.listProductEvents(),
      records,
      review,
      settings: getSettings(),
    };
  }

  function seedLegacyDecisionStrategy() {
    const meta = db
      .prepare("SELECT value FROM app_meta WHERE key = 'automation_strategy_seed_v1'")
      .get();
    if (meta) return;
    const decisions = reviewStore.listDecisions();
    for (const decision of decisions) {
      if (
        (!decision.bucket_plan || !Object.keys(decision.bucket_plan).length) &&
        /3%|策略组合|target3/i.test(decision.product_name)
      ) {
        reviewStore.updateDecision(decision.id, {
          ...decision,
          bucket_plan: { short: 30, medium: 35, long: 35, max_single: 30 },
          target_annualized: decision.target_annualized || 3,
          strategy_version: decision.strategy_version || 'r2-3pct-v1',
          evaluation_at: decision.evaluation_at.length
            ? decision.evaluation_at
            : ['buy_day', 'holding', 'maturity'],
        });
      }
    }
    db.prepare(`
      INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run('automation_strategy_seed_v1', 'done', new Date().toISOString());
  }

  function linkLegacyDecision() {
    const meta = db
      .prepare("SELECT value FROM app_meta WHERE key = 'automation_decision_link_v1'")
      .get();
    if (meta) return 0;
    const decisions = reviewStore.listDecisions();
    let linked = 0;
    if (decisions.length === 1) {
      const decision = decisions[0];
      for (const trade of tradeStore.listTrades()) {
        if (
          trade.decision_id === null &&
          trade.source === 'migration' &&
          trade.status !== 'cancelled'
        ) {
          tradeStore.updateTrade(
            trade.id,
            { ...trade, decision_id: decision.id },
            '自动关联到唯一组合决策',
          );
          linked += 1;
        }
      }
    }
    db.prepare(`
      INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run('automation_decision_link_v1', String(linked), new Date().toISOString());
    return linked;
  }

  function latestBuyDayRun(decisionId) {
    return (
      selectDecisionRuns
        .all(decisionId)
        .map(mapRun)
        .filter((run) => run.stage === 'buy_day')
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null
    );
  }

  function latestAppliedRun(decisionId) {
    return (
      selectDecisionRuns
        .all(decisionId)
        .map(mapRun)
        .filter((run) => ['auto', 'confirmed'].includes(run.status) && run.applied_at)
        .sort((a, b) => b.applied_at.localeCompare(a.applied_at))[0] || null
    );
  }

  function tradeBuyAmount(trade) {
    if (trade.trade_type === 'buy') return trade.amount;
    if (trade.trade_type === 'switch') {
      return trade.settlement_amount ?? trade.amount;
    }
    return 0;
  }

  function tradeTermDays(trade) {
    if (trade.trade_type === 'switch') return trade.target_term_days;
    return trade.term_days;
  }

  function decisionBuys(ctx, decisionId, confirmedOnly = true) {
    return ctx.overview.trades.filter(
      (trade) =>
        trade.decision_id === decisionId &&
        ['buy', 'switch'].includes(trade.trade_type) &&
        (!confirmedOnly || trade.status === 'confirmed'),
    );
  }

  function bucketAmounts(buys) {
    const buckets = { short: 0, medium: 0, long: 0, unknown: 0 };
    const byProduct = new Map();
    let total = 0;
    for (const trade of buys) {
      const amount = tradeBuyAmount(trade);
      if (!amount) continue;
      total += amount;
      const term = tradeTermDays(trade);
      buckets[bucketOf(term)] += amount;
      const code =
        trade.trade_type === 'switch'
          ? trade.target_product_code || trade.product_code
          : trade.product_code;
      const name =
        trade.trade_type === 'switch'
          ? trade.target_product_name || trade.product_name
          : trade.product_name;
      const item = byProduct.get(code) || { code, name, amount: 0 };
      item.amount += amount;
      byProduct.set(code, item);
    }
    return { buckets, byProduct: [...byProduct.values()], total };
  }

  function evaluateBuyDay(ctx, decision) {
    const linked = ctx.overview.trades.filter(
      (trade) => trade.decision_id === decision.id && trade.status !== 'cancelled',
    );
    const confirmedBuys = decisionBuys(ctx, decision.id, true);
    const pending = linked.filter((trade) => trade.status === 'pending');
    const { buckets, byProduct, total } = bucketAmounts(confirmedBuys);
    const plan = decision.bucket_plan || {};
    const checks = [];
    checks.push({
      key: 'reason',
      label: '决策理由',
      pass: Boolean(String(decision.reason || '').trim()),
      detail: decision.reason ? '已填写' : '缺少理由',
    });
    checks.push({
      key: 'expectation',
      label: '收益/流动性预期',
      pass: Boolean(String(decision.expectation || '').trim()),
      detail: decision.expectation ? '已填写' : '缺少预期',
    });

    let planKnown = Boolean(
      plan.short !== undefined || plan.medium !== undefined || plan.long !== undefined,
    );
    if (planKnown && total > 0) {
      const tolerance = Number(ctx.settings.bucket_tolerance_pp) || 10;
      for (const key of ['short', 'medium', 'long']) {
        if (plan[key] === undefined) continue;
        const actualPct = round((buckets[key] / total) * 100, 1);
        const diff = Math.abs(actualPct - Number(plan[key]));
        checks.push({
          key: `bucket-${key}`,
          label: `${key} 期限桶`,
          pass: diff <= tolerance,
          detail: `计划 ${Number(plan[key]).toFixed(1)}%，实际 ${actualPct.toFixed(
            1,
          )}%，偏差 ${diff.toFixed(1)}pp`,
        });
      }
    } else if (!planKnown) {
      checks.push({
        key: 'bucket-plan',
        label: '期限桶计划',
        pass: false,
        detail: '决策未保存期限桶计划，流程无法自动确认',
      });
    }

    if (total > 0) {
      const cap = Number(plan.max_single ?? ctx.settings.single_product_cap_pct);
      const maxProduct = byProduct
        .map((item) => ({ ...item, pct: round((item.amount / total) * 100, 2) }))
        .sort((a, b) => b.pct - a.pct)[0];
      checks.push({
        key: 'single-product',
        label: '单只产品上限',
        pass: Boolean(maxProduct && maxProduct.pct <= cap),
        detail: maxProduct
          ? `${maxProduct.name} ${maxProduct.pct}%（上限 ${cap}%）`
          : '没有已确认买入',
      });
      const shortPct = round(
        ((buckets.short + buckets.medium + buckets.long) > 0
          ? buckets.short / total
          : 0) * 100,
        1,
      );
      const floor = Number(ctx.settings.liquidity_floor_pct);
      checks.push({
        key: 'liquidity',
        label: '流动性下限',
        pass: shortPct >= floor,
        detail: `日开+30天内 ${shortPct}%，下限 ${floor}%`,
      });
    }

    const processKnown =
      decision.action === '观察'
        ? true
        : confirmedBuys.length > 0 && planKnown;
    const processOk = processKnown ? checks.every((check) => check.pass) : null;
    let confidence = 100;
    if (!decision.reason) confidence -= 20;
    if (!decision.expectation) confidence -= 20;
    if (pending.length) confidence -= 25;
    if (!confirmedBuys.length && decision.action !== '观察') confidence -= 35;
    if (!planKnown) confidence -= 15;
    if (confirmedBuys.some((trade) => !trade.screenshot_id)) confidence -= 10;
    confidence = Math.max(0, Math.min(100, confidence));

    const summaryParts = [
      `流程${processKnown ? (processOk ? '通过' : '未通过') : '无法确认'}`,
      `已关联 ${confirmedBuys.length} 笔已确认买入，合计 ¥${round(total).toLocaleString(
        'zh-CN',
      )}`,
    ];
    if (pending.length) {
      summaryParts.push(`${pending.length} 笔仍待确认，买入日评估暂为暂定`);
    }
    if (checks.some((check) => !check.pass)) {
      summaryParts.push(
        `未通过项：${checks
          .filter((check) => !check.pass)
          .map((check) => check.label)
          .join('、')}`,
      );
    }
    return {
      dedupe_key: `decision:${decision.id}:buy_day:${decision.date}`,
      scope: 'decision',
      decision_id: decision.id,
      trade_id: null,
      stage: 'buy_day',
      period: decision.date,
      evaluated_for: ctx.today,
      confidence,
      confidence_level: confidenceLevel(confidence),
      process_ok: processOk,
      outcome: 'unknown',
      rating: '待评估',
      summary: summaryParts.join('；'),
      evidence: {
        checks,
        buckets,
        by_product: byProduct,
        linked_trade_ids: linked.map((trade) => trade.id),
        pending_trade_ids: pending.map((trade) => trade.id),
        strategy_version: decision.strategy_version,
        target_annualized: decision.target_annualized,
      },
    };
  }

  function annualizedFrom(pnl, principal, days) {
    if (
      pnl === null ||
      !Number.isFinite(Number(pnl)) ||
      principal <= 0 ||
      days <= 0
    ) {
      return null;
    }
    return round((Number(pnl) / principal) * (365 / days) * 100, 3);
  }

  function hurdleFor(termDays, settings, targetAnnualized) {
    if (termDays === null || termDays === undefined) return targetAnnualized;
    if (termDays <= 30) return Number(settings.hurdle_short);
    if (termDays <= 100) return Number(settings.hurdle_medium);
    return Number(settings.hurdle_long);
  }

  function highImpactEvents(ctx, period) {
    return ctx.events.filter(
      (event) =>
        event.date.startsWith(period) &&
        event.impact === '高' &&
        event.status === '待复核',
    );
  }

  function tradeChanges(ctx, months) {
    const list = ctx.overview.trades.filter(
      (trade) =>
        months.some((month) => trade.trade_date.startsWith(month)) &&
        trade.status !== 'cancelled',
    );
    const confirmed = list.filter((trade) => trade.status === 'confirmed');
    const pending = list.filter((trade) => trade.status === 'pending');
    const buyAmount = round(
      confirmed
        .filter((trade) => trade.trade_type === 'buy')
        .reduce((sum, trade) => sum + trade.amount, 0),
    );
    const redeemAmount = round(
      confirmed
        .filter((trade) => trade.trade_type === 'redeem')
        .reduce((sum, trade) => sum + trade.amount, 0),
    );
    const switchAmount = round(
      confirmed
        .filter((trade) => trade.trade_type === 'switch')
        .reduce((sum, trade) => sum + trade.amount, 0),
    );
    return {
      buy_amount: buyAmount,
      redeem_amount: redeemAmount,
      switch_amount: switchAmount,
      net_principal_change: round(buyAmount - redeemAmount),
      pending_amount: round(
        pending.reduce(
          (sum, trade) =>
            sum +
            (trade.trade_type === 'buy' || trade.trade_type === 'switch'
              ? trade.amount
              : 0),
          0,
        ),
      ),
      trade_count: list.length,
      items: list.map((trade) => ({
        id: trade.id,
        trade_date: trade.trade_date,
        trade_type: trade.trade_type,
        product_code: trade.product_code,
        product_name: trade.product_name,
        amount: trade.amount,
        status: trade.status,
      })),
    };
  }

  function previousMonthEnd(today) {
    const [year, month] = today.slice(0, 7).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10);
  }

  function holdingsAsOf(ctx, date) {
    const sellDates = new Map(
      ctx.overview.trades.map((trade) => [trade.id, trade.trade_date]),
    );
    const buys = ctx.overview.trades.filter(
      (trade) =>
        ['buy', 'switch'].includes(trade.trade_type) &&
        trade.status === 'confirmed' &&
        trade.trade_date <= date,
    );
    return buys
      .map((trade) => {
        const amount = tradeBuyAmount(trade);
        const allocated = ctx.overview.allocations
          .filter(
            (item) =>
              item.buy_trade_id === trade.id &&
              sellDates.get(item.redeem_trade_id) <= date,
          )
          .reduce((sum, item) => sum + item.principal, 0);
        const remaining = round(amount - allocated);
        if (remaining <= 0.004) return null;
        const isSwitch = trade.trade_type === 'switch';
        return {
          id: trade.id,
          product_name: isSwitch
            ? trade.target_product_name || trade.product_name
            : trade.product_name,
          product_code: isSwitch
            ? trade.target_product_code || trade.product_code
            : trade.product_code,
          issuer: trade.issuer,
          risk_level: trade.risk_level,
          amount: remaining,
          purchase_date: trade.trade_date,
          term_days: tradeTermDays(trade),
          maturity_date: isSwitch
            ? trade.target_maturity_date
            : trade.maturity_date,
        };
      })
      .filter(Boolean);
  }

  function evaluateHolding(ctx, decision) {
    const buys = decisionBuys(ctx, decision.id, true);
    if (!buys.length) return null;
    const openIds = new Set(ctx.holdings.map((holding) => holding.source_trade_id));
    const hasOpen = buys.some((trade) => openIds.has(trade.id));
    if (!hasOpen) return null;
    const period = ctx.today.slice(0, 7);
    const row = ctx.review.monthly.find((item) => item.month === period);
    const recordDays = row?.record_days ?? 0;
    const annualized = row?.annualized_pct ?? null;
    const targetProgress = row?.target_progress_pct ?? null;
    const liquidity = ctx.holdingsSummary.liquidity_ratio_pct;
    const previousLiquidity =
      buildHoldingsSummary(
        holdingsAsOf(ctx, previousMonthEnd(ctx.today)),
        previousMonthEnd(ctx.today),
      ).liquidity_ratio_pct;
    const liquidityDelta =
      liquidity === null || previousLiquidity === null
        ? null
        : round(liquidity - previousLiquidity, 1);
    const events = highImpactEvents(ctx, period);
    const target = Number(decision.target_annualized ?? ctx.settings.target_annualized);
    const floor = Number(ctx.settings.liquidity_floor_pct);
    const processRun = latestBuyDayRun(decision.id);
    const processOk =
      processRun && processRun.process_ok !== null
        ? processRun.process_ok
        : null;
    const enoughData =
      recordDays >= Math.min(5, Math.max(1, row?.elapsed_days ?? 5)) &&
      Boolean(row?.sample_sufficient);
    const outcome =
      annualized === null || !enoughData
        ? 'unknown'
        : annualized >= target &&
            (liquidity === null || liquidity >= floor) &&
            events.length === 0
          ? 'good'
          : 'bad';
    let confidence = 82;
    if (!enoughData) confidence -= 30;
    if (annualized === null) confidence -= 20;
    if (processOk === null) confidence -= 20;
    if (liquidity === null) confidence -= 10;
    confidence = Math.max(0, Math.min(100, confidence));
    const rating = ratingFor(processOk, outcome);
    const summary = [
      `${period} 组合年化${
        annualized === null ? '暂无可比数据' : ` ${annualized.toFixed(2)}%`
      }`,
      `目标 ${target.toFixed(2)}%`,
      targetProgress === null ? '目标进度暂无数据' : `目标进度 ${targetProgress.toFixed(1)}%`,
      liquidity === null ? '流动性暂无数据' : `日开+30天 ${liquidity}%`,
      liquidityDelta === null
        ? '流动性变化暂无对比'
        : `较上月末 ${liquidityDelta >= 0 ? '+' : ''}${liquidityDelta}pp`,
      events.length ? `${events.length} 条高影响事件待复核` : '无高影响事件',
      `本月记录 ${recordDays} 天`,
    ].join('；');
    return {
      dedupe_key: `decision:${decision.id}:holding:${period}`,
      scope: 'decision',
      decision_id: decision.id,
      trade_id: null,
      stage: 'holding',
      period,
      evaluated_for: ctx.today,
      confidence,
      confidence_level: confidenceLevel(confidence),
      process_ok: processOk,
      outcome,
      rating,
      summary,
      evidence: {
        monthly: row || null,
        liquidity_ratio_pct: liquidity,
        previous_liquidity_ratio_pct: previousLiquidity,
        liquidity_delta_pp: liquidityDelta,
        high_impact_event_ids: events.map((event) => event.id),
        open_trade_ids: buys
          .filter((trade) => openIds.has(trade.id))
          .map((trade) => trade.id),
        target_annualized: target,
        target_progress_pct: targetProgress,
        hurdle: target,
      },
    };
  }

  function evaluateTradeMaturity(ctx, trade) {
    if (
      !['redeem', 'switch'].includes(trade.trade_type) ||
      trade.status !== 'confirmed'
    ) {
      return null;
    }
    const allocations = trade.allocations || [];
    if (!allocations.length) return null;
    const principal = round(
      allocations.reduce((sum, item) => sum + item.principal, 0),
    );
    const weightedDays =
      principal > 0
        ? allocations.reduce((sum, item) => sum + item.days * item.principal, 0) /
          principal
        : 0;
    const buyMap = new Map(ctx.overview.trades.map((item) => [item.id, item]));
    const weightedTerm =
      principal > 0
        ? allocations.reduce((sum, item) => {
            const buy = buyMap.get(item.buy_trade_id);
            return sum + (buy?.term_days ?? 0) * item.principal;
          }, 0) / principal
        : null;
    const pnl =
      trade.settlement_amount === null
        ? null
        : round(trade.settlement_amount - trade.amount);
    const annualized = annualizedFrom(pnl, principal, weightedDays);
    const decision = trade.decision_id
      ? ctx.decisions.find((item) => item.id === trade.decision_id)
      : null;
    const processRun = decision ? latestBuyDayRun(decision.id) : null;
    const processOk =
      processRun && processRun.process_ok !== null
        ? processRun.process_ok
        : null;
    const hurdle = hurdleFor(
      weightedTerm,
      ctx.settings,
      decision?.target_annualized ?? ctx.settings.target_annualized,
    );
    const outcome =
      annualized === null
        ? 'unknown'
        : annualized >= hurdle && trade.settlement_amount !== null
          ? 'good'
          : 'bad';
    let confidence = 92;
    if (trade.settlement_amount === null) confidence -= 40;
    if (!trade.screenshot_id) confidence -= 10;
    if (!decision) confidence -= 15;
    if (!processRun) confidence -= 10;
    confidence = Math.max(0, Math.min(100, confidence));
    const rating = ratingFor(processOk, outcome);
    const summary = [
      `${trade.product_name} 赎回本金 ¥${trade.amount.toLocaleString('zh-CN')}`,
      `持有约 ${weightedDays.toFixed(1)} 天`,
      pnl === null ? '到账金额未填，收益未知' : `已实现收益 ¥${pnl.toFixed(2)}`,
      annualized === null ? '实际年化未知' : `实际年化 ${annualized.toFixed(2)}%`,
      `期限 hurdle ${hurdle.toFixed(2)}%`,
    ].join('；');
    return {
      dedupe_key: `trade:${trade.id}:maturity`,
      scope: 'trade',
      decision_id: decision?.id ?? null,
      trade_id: trade.id,
      stage: 'maturity',
      period: trade.trade_date,
      evaluated_for: ctx.today,
      confidence,
      confidence_level: confidenceLevel(confidence),
      process_ok: processOk,
      outcome,
      rating,
      summary,
      evidence: {
        allocations,
        principal,
        weighted_days: round(weightedDays, 1),
        weighted_term_days: round(weightedTerm ?? 0, 1),
        realized_pnl: pnl,
        annualized_pct: annualized,
        hurdle_pct: hurdle,
        settlement_amount: trade.settlement_amount,
      },
    };
  }

  function evaluateDecisionMaturity(ctx, decision) {
    const buys = decisionBuys(ctx, decision.id, true);
    if (!buys.length) return null;
    const openIds = new Set(ctx.holdings.map((holding) => holding.source_trade_id));
    if (buys.some((trade) => openIds.has(trade.id))) return null;
    const buyIds = new Set(buys.map((trade) => trade.id));
    const sells = ctx.overview.trades.filter(
      (trade) =>
        trade.decision_id === decision.id &&
        ['redeem', 'switch'].includes(trade.trade_type) &&
        trade.status === 'confirmed',
    );
    if (!sells.length) return null;
    const allocations = ctx.overview.allocations.filter((item) =>
      buyIds.has(item.buy_trade_id),
    );
    if (!allocations.length) return null;
    const principal = round(
      allocations.reduce((sum, item) => sum + item.principal, 0),
    );
    const pnl = round(
      allocations.reduce((sum, item) => sum + item.realized_pnl, 0),
    );
    const weightedDays =
      principal > 0
        ? allocations.reduce((sum, item) => sum + item.days * item.principal, 0) /
          principal
        : 0;
    const annualized = annualizedFrom(pnl, principal, weightedDays);
    const processRun = latestBuyDayRun(decision.id);
    const processOk =
      processRun && processRun.process_ok !== null
        ? processRun.process_ok
        : null;
    const hurdle = hurdleFor(
      buys.reduce((sum, trade) => sum + (trade.term_days ?? 0), 0) / buys.length,
      ctx.settings,
      decision.target_annualized,
    );
    const allSettlementKnown = sells.every(
      (trade) => trade.settlement_amount !== null,
    );
    const outcome =
      !allSettlementKnown || annualized === null
        ? 'unknown'
        : annualized >= hurdle
          ? 'good'
          : 'bad';
    let confidence = 90;
    if (!allSettlementKnown) confidence -= 35;
    if (!processRun) confidence -= 10;
    confidence = Math.max(0, Math.min(100, confidence));
    const rating = ratingFor(processOk, outcome);
    const summary = [
      `组合已全部赎回`,
      `累计本金 ¥${principal.toLocaleString('zh-CN')}`,
      `已实现收益 ¥${pnl.toFixed(2)}`,
      `加权持有 ${weightedDays.toFixed(1)} 天`,
      annualized === null ? '实际年化未知' : `实际年化 ${annualized.toFixed(2)}%`,
      `hurdle ${hurdle.toFixed(2)}%`,
      allSettlementKnown ? '到账金额完整' : '部分到账金额未填',
    ].join('；');
    return {
      dedupe_key: `decision:${decision.id}:maturity:${sells
        .map((trade) => trade.id)
        .join('-')}`,
      scope: 'decision',
      decision_id: decision.id,
      trade_id: null,
      stage: 'maturity',
      period: sells.at(-1).trade_date,
      evaluated_for: ctx.today,
      confidence,
      confidence_level: confidenceLevel(confidence),
      process_ok: processOk,
      outcome,
      rating,
      summary,
      evidence: {
        allocations,
        principal,
        realized_pnl: pnl,
        weighted_days: round(weightedDays, 1),
        annualized_pct: annualized,
        hurdle_pct: hurdle,
        sell_trade_ids: sells.map((trade) => trade.id),
        all_settlement_known: allSettlementKnown,
      },
    };
  }

  function evaluateMaturedOpen(ctx, trade) {
    if (
      !['buy', 'switch'].includes(trade.trade_type) ||
      trade.status !== 'confirmed'
    ) {
      return null;
    }
    const term = tradeTermDays(trade);
    const maturity = trade.maturity_date || trade.target_maturity_date;
    if (!maturity || maturity >= ctx.today) return null;
    const open = ctx.holdings.find(
      (holding) => holding.source_trade_id === trade.id,
    );
    if (!open) return null;
    return {
      dedupe_key: `trade:${trade.id}:maturity-due:${maturity}`,
      scope: 'trade',
      decision_id: trade.decision_id,
      trade_id: trade.id,
      stage: 'maturity',
      period: maturity,
      evaluated_for: ctx.today,
      confidence: 35,
      confidence_level: 'low',
      process_ok: null,
      outcome: 'unknown',
      rating: '待评估',
      summary: `${trade.product_name} 已于 ${maturity} 到期，仍显示 ${open.amount.toFixed(
        2,
      )} 元本金未赎回；实际年化和资金可用性需要赎回/到账记录。`,
      evidence: {
        maturity_date: maturity,
        term_days: term,
        remaining_principal: open.amount,
      },
    };
  }

  function mergeActualResult(previous, summary, today) {
    const marker = new RegExp(
      `\\n?\\[自动评估 [^\\]]+\\][^\\n]*`,
      'g',
    );
    const base = String(previous || '').replace(marker, '').trim();
    const block = `${AUTO_MARK} ${today} ${summary}`;
    return base ? `${base}\n${block}` : block;
  }

  function applyDecisionRun(run, { force = false } = {}) {
    if (run.scope !== 'decision' || !run.decision_id) return false;
    const decision = reviewStore.listDecisions().find(
      (item) => item.id === run.decision_id,
    );
    if (!decision) return false;
    const applied = latestAppliedRun(decision.id);
    if (
      applied &&
      stagePriority(applied.stage) > stagePriority(run.stage) &&
      !force
    ) {
      return false;
    }
    if (!force && run.stage !== 'buy_day') {
      const autoChangedRating =
        applied &&
        applied.applied_rating !== applied.previous_rating;
      const manualAfterApply =
        decision.rating !== '待评估' &&
        (!autoChangedRating || decision.updated_at > applied.updated_at);
      if (manualAfterApply) {
        return false;
      }
    }
    const nextRating =
      run.stage === 'buy_day' || run.rating === '待评估'
        ? decision.rating
        : run.rating;
    const nextActual = mergeActualResult(
      decision.actual_result,
      run.summary,
      run.evaluated_for,
    );
    const updated = reviewStore.updateDecision(decision.id, {
      ...decision,
      rating: nextRating,
      actual_result: nextActual,
    });
    if (!updated) return false;
    const stamp = new Date().toISOString();
    updateRunStatus.run(
      force ? 'confirmed' : 'auto',
      decision.rating,
      decision.actual_result,
      nextRating,
      nextActual,
      stamp,
      null,
      stamp,
      run.id,
    );
    return true;
  }

  function recordEvaluation(run, ctx) {
    const ruleVersion = ctx.settings.rule_version || RULE_VERSION;
    run.dedupe_key = `${run.dedupe_key}|${ruleVersion}`;
    const existing = selectRunByKey.get(run.dedupe_key);
    if (existing) {
      const mapped = mapRun(existing);
      if (['auto', 'confirmed', 'undone'].includes(mapped.status)) {
        closeEvaluationJob(mapped.id, `评估已是 ${mapped.status} 状态`);
        return mapped;
      }
      const stamp = new Date().toISOString();
      updateRun.run(
        run.confidence,
        run.confidence_level,
        run.process_ok === null ? null : run.process_ok ? 1 : 0,
        run.outcome,
        run.rating,
        run.summary,
        JSON.stringify(run.evidence || {}),
        stamp,
        mapped.id,
      );
    } else {
      const stamp = new Date().toISOString();
      const result = insertRun.run(
        run.dedupe_key,
        run.scope,
        run.decision_id ?? null,
        run.trade_id ?? null,
        run.stage,
        run.period,
        run.evaluated_for,
        ctx.settings.rule_version || RULE_VERSION,
        'automation',
        run.confidence,
        run.confidence_level,
        run.process_ok === null ? null : run.process_ok ? 1 : 0,
        run.outcome,
        run.rating,
        run.summary,
        JSON.stringify(run.evidence || {}),
        stamp,
        stamp,
      );
      run.id = Number(result.lastInsertRowid);
    }
    const current = getRun(run.id || selectRunByKey.get(run.dedupe_key)?.id);
    if (!current) return null;
    const threshold = Number(ctx.settings.auto_confidence_threshold);
    let applied = false;
    let pending = false;
    if (current.confidence >= threshold && current.confidence_level === 'high') {
      if (current.scope === 'decision') {
        applied = applyDecisionRun(current);
        if (!applied) pending = true;
      } else {
        const stamp = new Date().toISOString();
        updateRunStatus.run(
          'auto',
          null,
          null,
          null,
          null,
          stamp,
          null,
          stamp,
          current.id,
        );
        applied = true;
      }
    } else {
      pending = true;
    }
    if (pending) {
      enqueueJob(
        'evaluation_review',
        `evaluation-job:${current.id}`,
        {
          evaluation_id: current.id,
          decision_id: current.decision_id,
          trade_id: current.trade_id,
          stage: current.stage,
          summary: current.summary,
          confidence: current.confidence,
        },
      );
      addNotification({
        dedupe_key: `evaluation-pending:${current.id}`,
        kind: 'evaluation',
        level: 'info',
        title: '评估需要人工确认',
        message: `${current.summary}（置信度 ${current.confidence}%）`,
        data: { evaluation_id: current.id, decision_id: current.decision_id },
      });
    } else if (applied) {
      closeEvaluationJob(current.id, '自动评估已写入，无需人工复核');
      addNotification({
        dedupe_key: `evaluation-applied:${current.id}`,
        kind: 'evaluation',
        level: 'info',
        title: '自动评估已写入',
        message: current.summary,
        data: { evaluation_id: current.id, decision_id: current.decision_id },
      });
    }
    return getRun(current.id);
  }

  function closeEvaluationJob(runId, note) {
    const job = selectJobByKey.get(`evaluation-job:${runId}`);
    if (job && job.status === 'pending') {
      resolveJob(job.id, {
        status: 'done',
        result: { applied: true },
        note,
      });
    }
    const notification = selectNotificationByKey.get(
      `evaluation-pending:${runId}`,
    );
    if (notification && !notification.resolved_at) {
      markNotification(notification.id, 'resolve');
    }
  }

  function forceApplyRun(id, { rating = null, summary = null } = {}) {
    const run = getRun(id);
    if (!run) return null;
    if (run.status === 'undone') throw new Error('已撤销的评估不能再次写入');
    if (run.scope === 'trade') {
      const stamp = new Date().toISOString();
      updateRunStatus.run(
        'confirmed',
        null,
        null,
        rating || run.rating,
        summary || run.summary,
        stamp,
        null,
        stamp,
        id,
      );
      const tradeJob = selectJobByKey.get(`evaluation-job:${id}`);
      if (tradeJob) {
        resolveJob(tradeJob.id, {
          status: 'done',
          result: { confirmed: true },
          note: '人工确认单产品评估',
        });
      }
      return getRun(id);
    }
    if (summary) {
      const stamp = new Date().toISOString();
      updateRun.run(
        run.confidence,
        run.confidence_level,
        run.process_ok === null ? null : run.process_ok ? 1 : 0,
        run.outcome,
        rating || run.rating,
        summary,
        JSON.stringify(run.evidence || {}),
        stamp,
        run.id,
      );
    }
    const next = getRun(id);
    if (rating) next.rating = rating;
    const ok = applyDecisionRun(next, { force: true });
    if (!ok) throw new Error('写入评估失败');
    const job = selectJobByKey.get(`evaluation-job:${id}`);
    if (job) {
      resolveJob(job.id, {
        status: 'done',
        result: { applied: true },
        note: '人工确认写入',
      });
    }
    return getRun(id);
  }

  function undoRun(id) {
    const run = getRun(id);
    if (!run) return null;
    if (!['auto', 'confirmed'].includes(run.status)) {
      throw new Error('只有已写入的评估可以撤销');
    }
    if (run.scope === 'trade') {
      const stamp = new Date().toISOString();
      updateRunStatus.run(
        'undone',
        null,
        null,
        run.applied_rating,
        run.applied_actual_result,
        run.applied_at,
        stamp,
        stamp,
        id,
      );
      return getRun(id);
    }
    if (run.scope !== 'decision' || !run.decision_id) {
      throw new Error('评估对象不正确');
    }
    const decision = reviewStore.listDecisions().find(
      (item) => item.id === run.decision_id,
    );
    if (!decision) throw new Error('决策不存在');
    if (
      decision.rating !== run.applied_rating ||
      decision.actual_result !== run.applied_actual_result
    ) {
      throw new Error('决策在评估后已被手工修改，不能自动回滚');
    }
    const updated = reviewStore.updateDecision(decision.id, {
      ...decision,
      rating: run.previous_rating || '待评估',
      actual_result: run.previous_actual_result || '',
    });
    if (!updated) throw new Error('回滚失败');
    const stamp = new Date().toISOString();
    updateRunStatus.run(
      'undone',
      run.previous_rating,
      run.previous_actual_result,
      run.applied_rating,
      run.applied_actual_result,
      run.applied_at,
      stamp,
      stamp,
      id,
    );
    return getRun(id);
  }

  function scanInbox(ctx, activeKeys) {
    let count = 0;
    for (const item of ctx.overview.inbox.filter((entry) => entry.status === 'pending')) {
      const age = daysBetween(item.received_at.slice(0, 10), ctx.today);
      if (item.parse_confidence < 50 || (item.parsed.warnings || []).length) {
        enqueueJob(
          'screenshot_review',
          `screenshot-job:${item.id}`,
          {
            inbox_id: item.id,
            original_name: item.original_name,
            confidence: item.parse_confidence,
            warnings: item.parsed.warnings || [],
          },
        );
        addNotification(
          {
            dedupe_key: `screenshot-review:${item.id}`,
            kind: 'inbox',
            level: 'info',
            title: '截图识别需要校正',
            message: `${item.original_name || `截图 #${item.id}`} 的识别置信度 ${item.parse_confidence}%，请核对后生成交易。`,
            data: { inbox_id: item.id },
          },
          activeKeys,
        );
        count += 1;
      }
      if (age >= 1) {
        addNotification(
          {
            dedupe_key: `inbox-unprocessed:${item.id}`,
            kind: 'inbox',
            level: 'info',
            title: '截图待处理',
            message: `${item.original_name || `截图 #${item.id}`} 已等待 ${age} 天。`,
            data: { inbox_id: item.id },
          },
          activeKeys,
        );
        count += 1;
      }
    }
    return count;
  }

  function scanMaturity(ctx, activeKeys) {
    let count = 0;
    for (const holding of ctx.holdings) {
      if (!holding.maturity_date) continue;
      const days = daysBetween(ctx.today, holding.maturity_date);
      if (days < 0) {
        addNotification(
          {
            dedupe_key: `maturity-overdue:${holding.lot_id}:${holding.maturity_date}`,
            kind: 'maturity',
            level: 'warn',
            title: '持仓已到期',
            message: `${holding.product_name} 已于 ${holding.maturity_date} 到期，剩余本金 ¥${holding.amount.toFixed(2)}，请核对赎回和到账。`,
            data: {
              lot_id: holding.lot_id,
              source_trade_id: holding.source_trade_id,
            },
          },
          activeKeys,
        );
        count += 1;
      } else if (days <= 7) {
        addNotification(
          {
            dedupe_key: `maturity-soon:${holding.lot_id}:${holding.maturity_date}`,
            kind: 'maturity',
            level: 'info',
            title: '7 天内到期',
            message: `${holding.product_name} 将在 ${holding.maturity_date} 到期，剩余本金 ¥${holding.amount.toFixed(2)}。`,
            data: {
              lot_id: holding.lot_id,
              source_trade_id: holding.source_trade_id,
            },
          },
          activeKeys,
        );
        count += 1;
      }
    }
    for (const trade of ctx.overview.trades.filter(
      (entry) => entry.status === 'pending',
    )) {
      const age = daysBetween(trade.trade_date, ctx.today);
      if (age < 3) continue;
      addNotification(
        {
          dedupe_key: `stale-pending:${trade.id}`,
          kind: 'pending',
          level: age >= 7 ? 'warn' : 'info',
          title: '交易待确认时间过长',
          message: `${trade.product_name} 自 ${trade.trade_date} 起待确认，已 ${age} 天。`,
          data: { trade_id: trade.id },
        },
        activeKeys,
      );
      count += 1;
    }
    for (const item of ctx.overview.reconciliation.items) {
      if (!['missing-screenshot', 'amount-mismatch', 'code-mismatch'].includes(item.code)) {
        continue;
      }
      addNotification(
        {
          dedupe_key: `reconcile:${item.code}:${item.trade_id}:${item.text}`,
          kind: 'reconciliation',
          level: 'warn',
          title: '交易对账异常',
          message: item.text,
          data: { trade_id: item.trade_id, code: item.code },
        },
        activeKeys,
      );
      count += 1;
    }
    return count;
  }

  function scanEvaluations(ctx) {
    let created = 0;
    let pending = 0;
    for (const decision of ctx.decisions) {
      const stages = decision.evaluation_at || ['buy_day', 'holding', 'maturity'];
      const candidates = [];
      if (stages.includes('buy_day')) {
        candidates.push(() => evaluateBuyDay(ctx, decision));
      }
      if (stages.includes('holding')) {
        candidates.push(() => evaluateHolding(ctx, decision));
      }
      if (stages.includes('maturity')) {
        candidates.push(() => evaluateDecisionMaturity(ctx, decision));
      }
      for (const evaluate of candidates) {
        const candidate = evaluate();
        if (!candidate) continue;
        const saved = recordEvaluation(candidate, ctx);
        if (saved) {
          created += 1;
          if (saved.status === 'pending') pending += 1;
        }
      }
    }
    for (const trade of ctx.overview.trades) {
      const candidate =
        evaluateTradeMaturity(ctx, trade) || evaluateMaturedOpen(ctx, trade);
      if (!candidate) continue;
      const saved = recordEvaluation(candidate, ctx);
      if (saved) {
        created += 1;
        if (saved.status === 'pending') pending += 1;
      }
    }
    return { created, pending };
  }

  function buildMonthlyDraft(ctx, month) {
    const row = ctx.review.monthly.find((item) => item.month === month) || null;
    const decisions = ctx.decisions.filter((item) => item.date.startsWith(month));
    const events = ctx.events.filter((item) => item.date.startsWith(month));
    const evaluations = listRuns(200).filter(
      (item) => item.evaluated_for.startsWith(month) || item.period.startsWith(month),
    );
    const pending = evaluations.filter((item) => item.status === 'pending');
    const processGood = evaluations.filter((item) => item.process_ok === true).length;
    const processBad = evaluations.filter((item) => item.process_ok === false).length;
    const matured = evaluations.filter(
      (item) => item.stage === 'maturity' && item.outcome !== 'unknown',
    );
    const best = [...matured].sort(
      (a, b) =>
        Number(b.evidence.realized_pnl || 0) - Number(a.evidence.realized_pnl || 0),
    )[0];
    const target = Number(ctx.settings.target_annualized);
    const annualized = row?.annualized_pct ?? null;
    const gap =
      annualized === null ? null : round(annualized - target, 2);
    const alerts = ctx.holdingsSummary.alerts;
    const highEvents = events.filter(
      (item) => item.impact === '高' && item.status === '待复核',
    );
    const changes = tradeChanges(ctx, [month]);
    const answers = [
      evaluations.length
        ? `自动评估共 ${evaluations.length} 条：流程通过 ${processGood} 条，流程未通过 ${processBad} 条，待确认 ${pending.length} 条。${
            processBad ? '存在流程偏离，需要逐条看原因。' : '已记录的流程检查未发现偏离。'
          }`
        : '本月没有可评估的决策或交易；先补齐决策与交易关联。',
      best
        ? `结果最明确的是 ${best.summary}`
        : '本月没有已完成的到期/赎回结果，单只产品收益暂无法定论。',
      annualized === null
        ? '本月收益记录不足，无法计算年化；先补每日收益，再比较 3% 目标。'
        : row && !row.sample_sufficient
          ? `本月只记录 ${row.record_days}/${row.elapsed_days} 天，年化参考 ${annualized.toFixed(
              2,
            )}% 但样本不足，暂不作为目标达成结论。`
          : `本月组合年化 ${annualized.toFixed(2)}%，目标 ${target.toFixed(
              2,
            )}%，缺口 ${gap >= 0 ? '+' : ''}${gap.toFixed(2)}pp。`,
      [
        alerts.length ? `${alerts.length} 条持仓提醒` : '无持仓红线',
        highEvents.length ? `${highEvents.length} 条高影响产品事件待复核` : '无高影响事件',
        `待确认交易 ${ctx.overview.summary.pending_count} 笔`,
        `本月买入 ¥${changes.buy_amount.toFixed(2)}、赎回 ¥${changes.redeem_amount.toFixed(
          2,
        )}、切换 ¥${changes.switch_amount.toFixed(2)}`,
      ].join('；'),
      pending.length
        ? `先处理 ${pending.length} 条待确认评估，再决定是否调整期限桶。`
        : '保持当前期限阶梯，优先补齐截图、确认日期和到账金额。',
    ];
    const anomalies = [
      ...alerts.map((item) => item.text),
      ...highEvents.map(
        (item) => `${item.product_name}：${item.event_type} - ${item.description}`,
      ),
      ...pending.map((item) => item.summary),
      ...ctx.overview.reconciliation.items
        .filter((item) => item.level === 'warn')
        .map((item) => item.text),
    ];
    return {
      title: `${month} 月度复盘草稿`,
      generated_for: month,
      metrics: row,
      target_annualized: target,
      annualized_pct: annualized,
      target_gap_pp: gap,
      process_good: processGood,
      process_bad: processBad,
      pending_evaluations: pending.map((item) => ({
        id: item.id,
        summary: item.summary,
        confidence: item.confidence,
      })),
      decisions: decisions.map((item) => ({
        id: item.id,
        product_name: item.product_name,
        action: item.action,
        rating: item.rating,
      })),
      events: events.map((item) => ({
        id: item.id,
        product_name: item.product_name,
        event_type: item.event_type,
        impact: item.impact,
        status: item.status,
      })),
      holdings_changes: changes,
      holdings: ctx.holdings.map((item) => ({
        product_name: item.product_name,
        product_code: item.product_code,
        amount: item.amount,
        maturity_date: item.maturity_date,
      })),
      answers,
      conclusion: `本月${row ? `记录 ${row.record_days}/${row.elapsed_days} 天，` : ''}${
        annualized === null || (row && !row.sample_sufficient)
          ? '年化样本不足'
          : `组合年化 ${annualized.toFixed(2)}%`
      }，本金净变化 ¥${changes.net_principal_change.toFixed(2)}；${
        pending.length ? `${pending.length} 条评估待确认` : '评估均已处理'
      }。`,
      anomalies,
      next_action: answers[4],
    };
  }

  function buildQuarterlyDraft(ctx, quarter) {
    const months = quarterMonths(quarter);
    const rows = months
      .map((month) => ctx.review.monthly.find((item) => item.month === month))
      .filter(Boolean);
    const decisions = ctx.decisions.filter((item) =>
      months.some((month) => item.date.startsWith(month)),
    );
    const events = ctx.events.filter((item) =>
      months.some((month) => item.date.startsWith(month)),
    );
    const evaluations = listRuns(300).filter((item) =>
      months.some(
        (month) =>
          item.evaluated_for.startsWith(month) || item.period.startsWith(month),
      ),
    );
    const pending = evaluations.filter((item) => item.status === 'pending');
    const changes = tradeChanges(ctx, months);
    const totalPnl = round(rows.reduce((sum, row) => sum + row.pnl, 0));
    const avgPrincipal = rows.length
      ? round(
          rows.reduce((sum, row) => sum + row.avg_principal, 0) / rows.length,
        )
      : 0;
    const quarterReturn =
      avgPrincipal > 0 ? round((totalPnl / avgPrincipal) * 100, 3) : null;
    const bucketPct = ctx.holdingsSummary.bucket_pct;
    const answers = [
      `当前期限桶：短 ${bucketPct.short ?? 0}%、中 ${bucketPct.medium ?? 0}%、长 ${
        bucketPct.long ?? 0
      }%（日开 ${bucketPct.liquid ?? 0}%）；策略目标以决策中的期限桶计划为准。`,
      ctx.holdingsSummary.max_product
        ? `单只最高 ${ctx.holdingsSummary.max_product.name} ${ctx.holdingsSummary.max_product.pct}%；${
            ctx.holdingsSummary.max_product.pct > 30 ? '已超 30% 参考上限' : '未超限'
          }。`
        : '当前没有已确认持仓。',
      `未来 12 个月到期阶梯已按剩余本金计算；${
        ctx.holdingsSummary.overdue_count
          ? `${ctx.holdingsSummary.overdue_count} 笔已到期未处理`
          : '暂无已到期持仓'
      }。`,
      `季度已实现收益 ¥${totalPnl.toFixed(2)}，季度收益率 ${
        quarterReturn === null ? '暂无法计算' : `${quarterReturn.toFixed(2)}%`
      }；费用与闲置拖累仍以产品费和实际到账为准。`,
      pending.length || ctx.holdingsSummary.alerts.length
        ? `先处理 ${pending.length} 条待确认评估和 ${ctx.holdingsSummary.alerts.length} 条持仓提醒，再判断是否替换产品。`
        : '暂未发现必须替换的产品，继续按月复核费率和流动性。',
      `本季度自动评估 ${evaluations.length} 条，决策 ${decisions.length} 条；复盘时间主要用于确认异常和调整下一季度一件事。`,
    ];
    return {
      title: `${quarter} 季度复盘草稿`,
      generated_for: quarter,
      months: rows,
      total_pnl: totalPnl,
      quarter_return_pct: quarterReturn,
      process_good: evaluations.filter((item) => item.process_ok === true).length,
      process_bad: evaluations.filter((item) => item.process_ok === false).length,
      pending_evaluations: pending.map((item) => ({
        id: item.id,
        summary: item.summary,
        confidence: item.confidence,
      })),
      decisions: decisions.map((item) => ({
        id: item.id,
        product_name: item.product_name,
        action: item.action,
        rating: item.rating,
      })),
      events,
      holdings_changes: changes,
      holdings: ctx.holdings,
      answers,
      conclusion: `${quarter} 已实现收益 ¥${totalPnl.toFixed(
        2,
      )}，本金净变化 ¥${changes.net_principal_change.toFixed(2)}；${
        pending.length ? `${pending.length} 条评估待确认` : '评估均已处理'
      }。`,
      anomalies: [
        ...ctx.holdingsSummary.alerts.map((item) => item.text),
        ...pending.map((item) => item.summary),
      ],
      next_action: answers[4],
    };
  }

  function saveDraft(periodType, period, content) {
    const existing = selectDraft.get(periodType, period);
    const stamp = new Date().toISOString();
    if (existing) {
      if (existing.status === 'confirmed') return mapDraft(existing);
      updateDraft.run(JSON.stringify(content), stamp, existing.id);
      return mapDraft(selectDraft.get(periodType, period));
    }
    const result = insertDraft.run(
      periodType,
      period,
      JSON.stringify(content),
      stamp,
      stamp,
    );
    const saved = getDraft(periodType, period);
    if (saved) return saved;
    return mapDraft({
      id: Number(result.lastInsertRowid),
      period_type: periodType,
      period,
      status: 'draft',
      content_json: JSON.stringify(content),
      generated_at: stamp,
      confirmed_at: null,
      updated_at: stamp,
    });
  }

  function generateDraft(periodType, period, ctx = getContext()) {
    const content =
      periodType === 'monthly'
        ? buildMonthlyDraft(ctx, period)
        : buildQuarterlyDraft(ctx, period);
    const draft = saveDraft(periodType, period, content);
    if (draft.status === 'draft') {
      enqueueJob(
        `${periodType}_summary`,
        `draft-job:${periodType}:${period}`,
        { period_type: periodType, period },
      );
      addNotification({
        dedupe_key: `draft-ready:${periodType}:${period}`,
        kind: 'draft',
        level: 'info',
        title: '复盘草稿已生成',
        message: `${content.title} 已生成，确认异常项和下一步动作即可保存。`,
        data: { period_type: periodType, period },
      });
    }
    return draft;
  }

  function confirmDraft(periodType, period, { answers, conclusion } = {}) {
    const draft = getDraft(periodType, period);
    if (!draft) throw new Error('复盘草稿不存在');
    const finalAnswers = Array.isArray(answers)
      ? answers.map((item) => String(item ?? ''))
      : draft.content.answers || [];
    const finalConclusion =
      conclusion !== undefined
        ? String(conclusion)
        : draft.content.conclusion || '';
    const note =
      periodType === 'monthly'
        ? reviewStore.saveReviewNote(period, {
            answers: finalAnswers,
            conclusion: finalConclusion,
          })
        : reviewStore.saveQuarterlyNote(period, {
            answers: finalAnswers,
            conclusion: finalConclusion,
          });
    const stamp = new Date().toISOString();
    confirmDraftStatement.run(stamp, stamp, draft.id);
    const notification = selectNotificationByKey.get(
      `draft-ready:${periodType}:${period}`,
    );
    if (notification) {
      markNotification(notification.id, 'resolve');
    }
    const job = selectJobByKey.get(`draft-job:${periodType}:${period}`);
    if (job) {
      resolveJob(job.id, {
        status: 'done',
        result: { confirmed: true },
        note: '用户确认复盘草稿',
      });
    }
    return { draft: getDraft(periodType, period), note };
  }

  function scanDrafts(ctx) {
    const day = Number(ctx.today.slice(8, 10));
    const currentMonth = ctx.today.slice(0, 7);
    let count = 0;
    if (day <= 7) {
      const previousMonth = shiftMonth(currentMonth, -1);
      const existing = getDraft('monthly', previousMonth);
      if (!existing) {
        generateDraft('monthly', previousMonth, ctx);
        count += 1;
      }
    }
    const monthNumber = Number(ctx.today.slice(5, 7));
    if ([1, 4, 7, 10].includes(monthNumber) && day <= 14) {
      const previousQuarter = shiftQuarter(quarterOf(ctx.today), -1);
      const existing = getDraft('quarterly', previousQuarter);
      if (!existing) {
        generateDraft('quarterly', previousQuarter, ctx);
        count += 1;
      }
    }
    return count;
  }

  function resolveStaleNotifications(activeKeys) {
    let count = 0;
    for (const row of selectOpenNotifications.all()) {
      if (
        ['maturity', 'pending', 'reconciliation', 'inbox'].includes(row.kind) &&
        !activeKeys.has(row.dedupe_key)
      ) {
        markNotification(row.id, 'resolve');
        count += 1;
      }
    }
    return count;
  }

  function runCycle({ today = todayShanghai(), trigger = 'manual' } = {}) {
    if (running) {
      return { ok: false, skipped: true, reason: '自动化任务正在运行' };
    }
    if (!getSetting('automation_enabled')) {
      return { ok: false, skipped: true, reason: '自动化已关闭' };
    }
    running = true;
    const startedAt = new Date().toISOString();
    const runId = Number(
      insertAutomationRun.run(trigger, startedAt).lastInsertRowid,
    );
    try {
      seedLegacyDecisionStrategy();
      const linked = linkLegacyDecision();
      const ctx = getContext(today);
      const activeKeys = new Set();
      const inbox = scanInbox(ctx, activeKeys);
      const maturity = scanMaturity(ctx, activeKeys);
      const evaluation = scanEvaluations(ctx);
      const drafts = scanDrafts(ctx);
      const resolved = resolveStaleNotifications(activeKeys);
      const summary = {
        linked_trades: linked,
        inbox_notifications: inbox,
        maturity_notifications: maturity,
        evaluations_created: evaluation.created,
        evaluations_pending: evaluation.pending,
        drafts_generated: drafts,
        notifications_resolved: resolved,
        open_notifications: listNotifications({ openOnly: true }).length,
        pending_jobs: listJobs({ status: 'pending' }).length,
      };
      const stamp = new Date().toISOString();
      finishAutomationRun.run(
        'done',
        stamp,
        JSON.stringify(summary),
        '',
        runId,
      );
      return { ok: true, run_id: runId, summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishAutomationRun.run(
        'failed',
        new Date().toISOString(),
        '{}',
        message,
        runId,
      );
      logger.warn?.(`自动化任务失败：${message}`);
      return { ok: false, run_id: runId, error: message };
    } finally {
      running = false;
    }
  }

  function getWorkspace(today = todayShanghai()) {
    const settings = getSettings();
    const lastRun = listAutomationRuns(1)[0] || null;
    const nextRun = lastRun
      ? new Date(
          Date.parse(lastRun.finished_at || lastRun.started_at) +
            Number(settings.scheduler_minutes) * 60 * 1000,
        ).toISOString()
      : null;
    return {
      settings,
      runs: listRuns(60),
      pending_evaluations: listPendingRuns(50),
      notifications: listNotifications({ openOnly: true }),
      all_notifications: listNotifications().slice(0, 80),
      drafts: listDrafts(),
      jobs: listJobs({ status: 'pending', limit: 50 }),
      automation_runs: listAutomationRuns(10),
      scheduler: {
        enabled: Boolean(settings.automation_enabled),
        last_run: lastRun,
        next_run: nextRun,
      },
    };
  }

  return {
    getSettings,
    updateSettings,
    listRuns,
    listPendingRuns,
    getRun,
    forceApplyRun,
    undoRun,
    listNotifications,
    markNotification,
    markAllNotificationsRead,
    listJobs,
    enqueueJob,
    resolveJob,
    listDrafts,
    getDraft,
    generateDraft,
    confirmDraft,
    listAutomationRuns,
    runCycle,
    getWorkspace,
    getContext,
  };
}

module.exports = {
  AUTO_MARK,
  AUTOMATION_SCHEMA,
  DEFAULT_SETTINGS,
  RULE_VERSION,
  bucketOf,
  createAutomationStore,
  ratingFor,
};
