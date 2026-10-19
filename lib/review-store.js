'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

const REVIEW_SCHEMA = `
  CREATE TABLE IF NOT EXISTS decision_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_date TEXT NOT NULL,
    product_name TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('买入', '赎回', '切换', '观察')),
    reason TEXT NOT NULL DEFAULT '',
    expectation TEXT NOT NULL DEFAULT '',
    actual_result TEXT NOT NULL DEFAULT '',
    strategy_version TEXT NOT NULL DEFAULT 'r2-3pct-v1',
    target_annualized REAL NOT NULL DEFAULT 3.0,
    bucket_plan TEXT NOT NULL DEFAULT '{}',
    evaluation_at TEXT NOT NULL DEFAULT 'buy_day,holding,maturity',
    rating TEXT NOT NULL DEFAULT '待评估' CHECK (
      rating IN (
        '待评估',
        '流程正确，结果好',
        '流程正确，结果差',
        '流程错误，结果好',
        '流程错误，结果差'
      )
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_decision_log_date
    ON decision_log(decision_date DESC, id DESC);

  CREATE TABLE IF NOT EXISTS holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_name TEXT NOT NULL,
    product_code TEXT NOT NULL DEFAULT '',
    issuer TEXT NOT NULL DEFAULT '',
    risk_level TEXT NOT NULL DEFAULT 'R2',
    amount REAL NOT NULL CHECK (amount > 0),
    purchase_date TEXT NOT NULL,
    term_days INTEGER,
    maturity_date TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_holdings_maturity
    ON holdings(maturity_date ASC, id ASC);

  CREATE TABLE IF NOT EXISTS product_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_date TEXT NOT NULL,
    product_name TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (
      event_type IN ('费率', '经理', '底层', '赎回规则', '额度', '其他')
    ),
    description TEXT NOT NULL DEFAULT '',
    impact TEXT NOT NULL DEFAULT '中' CHECK (impact IN ('低', '中', '高')),
    status TEXT NOT NULL DEFAULT '待复核' CHECK (status IN ('待复核', '已处理')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_product_events_date
    ON product_events(event_date DESC, id DESC);

  CREATE TABLE IF NOT EXISTS review_notes (
    month TEXT PRIMARY KEY,
    answers TEXT NOT NULL DEFAULT '[]',
    conclusion TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS quarterly_notes (
    quarter TEXT PRIMARY KEY,
    answers TEXT NOT NULL DEFAULT '[]',
    conclusion TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

function round(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return 0;
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function parseYmd(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
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
  if (stamp === null || !Number.isInteger(days)) return null;
  return new Date(stamp + days * DAY_MS).toISOString().slice(0, 10);
}

function monthLabel(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) return month;
  return `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`;
}

function shiftMonth(month, delta) {
  const [year, monthNumber] = month.split('-').map(Number);
  const stamp = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${stamp.getUTCFullYear()}-${String(stamp.getUTCMonth() + 1).padStart(2, '0')}`;
}

function quarterOf(date) {
  const year = date.slice(0, 4);
  const quarter = Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1;
  return `${year}-Q${quarter}`;
}

function shiftQuarter(quarter, delta) {
  const year = Number(quarter.slice(0, 4));
  const quarterNumber = Number(quarter.slice(6, 7));
  const stamp = new Date(Date.UTC(year, (quarterNumber - 1 + delta) * 3, 1));
  return `${stamp.getUTCFullYear()}-Q${Math.floor(stamp.getUTCMonth() / 3) + 1}`;
}

function quarterLabel(quarter) {
  if (!/^\d{4}-Q[1-4]$/.test(quarter)) return quarter;
  return `${quarter.slice(0, 4)}年第${quarter.slice(6, 7)}季度`;
}

function parseAnswers(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map((item) => String(item ?? '')) : [];
  } catch {
    return [];
  }
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function parseEvaluationAt(value) {
  if (Array.isArray(value)) return value.map(String);
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function mapDecision(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    date: row.decision_date,
    product_name: row.product_name,
    action: row.action,
    reason: row.reason || '',
    expectation: row.expectation || '',
    actual_result: row.actual_result || '',
    strategy_version: row.strategy_version || 'r2-3pct-v1',
    target_annualized:
      row.target_annualized === null || row.target_annualized === undefined
        ? 3
        : Number(row.target_annualized),
    bucket_plan: parseObject(row.bucket_plan),
    evaluation_at: parseEvaluationAt(row.evaluation_at),
    rating: row.rating,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapHolding(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    product_name: row.product_name,
    product_code: row.product_code || '',
    issuer: row.issuer || '',
    risk_level: row.risk_level || 'R2',
    amount: Number(row.amount),
    purchase_date: row.purchase_date,
    term_days: row.term_days === null ? null : Number(row.term_days),
    maturity_date: row.maturity_date || null,
    notes: row.notes || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapProductEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    date: row.event_date,
    product_name: row.product_name,
    event_type: row.event_type,
    description: row.description || '',
    impact: row.impact,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapReviewNote(row) {
  if (!row) return null;
  return {
    month: row.month,
    answers: parseAnswers(row.answers),
    conclusion: row.conclusion || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapQuarterlyNote(row) {
  if (!row) return null;
  return {
    quarter: row.quarter,
    answers: parseAnswers(row.answers),
    conclusion: row.conclusion || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function bucketOf(termDays) {
  if (termDays === 0) return 'liquid';
  if (termDays === null || termDays === undefined) return 'unknown';
  if (termDays <= 30) return 'short';
  if (termDays <= 100) return 'medium';
  return 'long';
}

function buildHoldingsSummary(holdings, today) {
  const total = holdings.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const buckets = { liquid: 0, short: 0, medium: 0, long: 0, unknown: 0 };
  const productMap = new Map();
  const issuerMap = new Map();
  const ladderMap = new Map();
  const startMonth = today.slice(0, 7);
  for (let index = 0; index < 12; index += 1) {
    const month = shiftMonth(startMonth, index);
    ladderMap.set(month, { month, amount: 0, count: 0 });
  }

  let overdueCount = 0;
  let overdueAmount = 0;
  let beyondAmount = 0;

  for (const holding of holdings) {
    const amount = Number(holding.amount || 0);
    const bucket = bucketOf(holding.term_days);
    buckets[bucket] += amount;

    const productKey = holding.product_code || holding.product_name;
    const product = productMap.get(productKey) || {
      name: holding.product_name,
      code: holding.product_code || '',
      amount: 0,
      count: 0,
    };
    product.amount += amount;
    product.count += 1;
    productMap.set(productKey, product);

    const issuerKey = holding.issuer || '未填写';
    const issuer = issuerMap.get(issuerKey) || { name: issuerKey, amount: 0, count: 0 };
    issuer.amount += amount;
    issuer.count += 1;
    issuerMap.set(issuerKey, issuer);

    if (holding.maturity_date) {
      if (holding.maturity_date < today) {
        overdueCount += 1;
        overdueAmount += amount;
      } else {
        const month = holding.maturity_date.slice(0, 7);
        const ladderItem = ladderMap.get(month);
        if (ladderItem) {
          ladderItem.amount += amount;
          ladderItem.count += 1;
        } else {
          beyondAmount += amount;
        }
      }
    }
  }

  const percent = (value) => (total > 0 ? round((value / total) * 100, 2) : null);
  const byProduct = [...productMap.values()]
    .map((item) => ({ ...item, amount: round(item.amount, 2), pct: percent(item.amount) }))
    .sort((a, b) => b.amount - a.amount);
  const byIssuer = [...issuerMap.values()]
    .map((item) => ({ ...item, amount: round(item.amount, 2), pct: percent(item.amount) }))
    .sort((a, b) => b.amount - a.amount);
  const maxProduct = byProduct[0] || null;
  const maxIssuer = byIssuer[0] || null;
  const liquidityAmount = buckets.liquid + buckets.short;
  const liquidityRatio = percent(liquidityAmount);

  const alerts = [];
  if (!holdings.length) {
    alerts.push({
      level: 'info',
      code: 'no-holdings',
      text: '还没有已确认持仓，先在交易流水里登记买入并确认。',
    });
  }
  if (maxProduct && maxProduct.pct > 30) {
    alerts.push({
      level: 'warn',
      code: 'single-product',
      text: `单只产品 ${maxProduct.name} 占比 ${maxProduct.pct}%，超过 30% 上限。`,
    });
  }
  if (maxIssuer && maxIssuer.pct > 50 && byIssuer.length > 1) {
    alerts.push({
      level: 'warn',
      code: 'issuer-concentration',
      text: `单发行方 ${maxIssuer.name} 占比 ${maxIssuer.pct}%，超过 50% 参考上限。`,
    });
  }
  if (total > 0 && liquidityRatio !== null && liquidityRatio < 30) {
    alerts.push({
      level: 'warn',
      code: 'liquidity-low',
      text: `日开 + 30 天内占比 ${liquidityRatio}%，低于 30% 下限。`,
    });
  }
  if (overdueCount > 0) {
    alerts.push({
      level: 'warn',
      code: 'matured',
      text: `${overdueCount} 笔持仓已到期或已过到期日，金额 ¥${round(overdueAmount).toLocaleString('zh-CN')}。`,
    });
  }
  if (buckets.unknown > 0) {
    alerts.push({
      level: 'info',
      code: 'unknown-term',
      text: `有 ¥${round(buckets.unknown).toLocaleString('zh-CN')} 持仓未填期限，无法归入期限桶。`,
    });
  }

  return {
    total_amount: round(total),
    count: holdings.length,
    buckets: {
      liquid: round(buckets.liquid),
      short: round(buckets.short),
      medium: round(buckets.medium),
      long: round(buckets.long),
      unknown: round(buckets.unknown),
    },
    bucket_pct: {
      liquid: percent(buckets.liquid),
      short: percent(buckets.short),
      medium: percent(buckets.medium),
      long: percent(buckets.long),
      unknown: percent(buckets.unknown),
    },
    liquidity_amount: round(liquidityAmount),
    liquidity_ratio_pct: liquidityRatio,
    max_product: maxProduct,
    max_issuer: maxIssuer,
    by_product: byProduct,
    by_issuer: byIssuer,
    ladder: [...ladderMap.values()].map((item) => ({
      ...item,
      amount: round(item.amount),
    })),
    overdue_count: overdueCount,
    overdue_amount: round(overdueAmount),
    beyond_12m_amount: round(beyondAmount),
    alerts,
  };
}

function buildTimeline({ today, records, review, notes, quarterlyNotes }) {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const day = Number(today.slice(8, 10));
  const currentMonth = today.slice(0, 7);
  const previousMonth = shiftMonth(currentMonth, -1);
  const previousQuarter = shiftQuarter(quarterOf(today), -1);
  const monthNote = notes.find((item) => item.month === previousMonth) || null;
  const quarterNote =
    quarterlyNotes.find((item) => item.quarter === previousQuarter) || null;
  const todayRecord = records.find((item) => item.date === today) || null;
  const weekly = review?.weekly || null;
  const weeklyDue = weekday === 0 || weekday === 5 || weekday === 6;
  const monthlyDue = day <= 5;
  const quarterlyDue =
    ['01', '04', '07', '10'].includes(today.slice(5, 7)) && day <= 7;
  const todayPnl = todayRecord ? Number(todayRecord.daily_pnl) : 0;

  const nodes = [
    {
      key: 'daily',
      label: '每日',
      cadence: '1 分钟',
      status: todayRecord ? 'done' : 'due',
      title: todayRecord ? '今天已记账' : '今天还没记账',
      detail: todayRecord
        ? `当日收益 ${todayPnl < 0 ? '−' : todayPnl > 0 ? '+' : ''}¥${Math.abs(
            todayPnl,
          ).toFixed(2)}`
        : '先补今天的本金收益、操作和备注',
    },
    {
      key: 'weekly',
      label: '每周',
      cadence: '10 分钟',
      status: weeklyDue ? 'due' : 'upcoming',
      title: weeklyDue ? '本周检查待做' : '周五开始周检查',
      detail: weekly
        ? `本周 ${weekly.record_days}/${weekly.elapsed_days} 天，连续负收益 ${weekly.consecutive_negative_days} 天`
        : '本周暂无记录',
    },
    {
      key: 'monthly',
      label: '每月',
      cadence: '10 分钟',
      status: monthNote ? 'done' : monthlyDue ? 'due' : 'overdue',
      title: monthNote
        ? `${monthLabel(previousMonth)}五问已保存`
        : `${monthLabel(previousMonth)}五问待补`,
      detail: monthNote
        ? '结论和下月只改一件事已留痕'
        : '补上月五问、当月结论和下月只改一件事',
    },
    {
      key: 'quarterly',
      label: '每季',
      cadence: '30 分钟',
      status: quarterNote ? 'done' : quarterlyDue ? 'due' : 'overdue',
      title: quarterNote
        ? `${quarterLabel(previousQuarter)}清单已保存`
        : `${quarterLabel(previousQuarter)}清单待补`,
      detail: quarterNote
        ? '桶比例、集中度和期限阶梯已复核'
        : '补桶比例、集中度、期限阶梯和替换清单',
    },
  ];
  const focus = nodes.find((node) => node.status === 'due' || node.status === 'overdue')?.key || null;
  return { today, focus, nodes };
}

function migrateDecisionColumns(db) {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(decision_log)')
      .all()
      .map((column) => column.name),
  );
  const additions = [
    ['strategy_version', "TEXT NOT NULL DEFAULT 'r2-3pct-v1'"],
    ['target_annualized', 'REAL NOT NULL DEFAULT 3.0'],
    ['bucket_plan', "TEXT NOT NULL DEFAULT '{}'"],
    ['evaluation_at', "TEXT NOT NULL DEFAULT 'buy_day,holding,maturity'"],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE decision_log ADD COLUMN ${name} ${definition}`);
    }
  }
}

function createReviewStore(db) {
  db.exec(REVIEW_SCHEMA);
  migrateDecisionColumns(db);

  const selectDecisions = db.prepare(`
    SELECT * FROM decision_log ORDER BY decision_date DESC, id DESC
  `);
  const selectDecision = db.prepare('SELECT * FROM decision_log WHERE id = ?');
  const insertDecision = db.prepare(`
    INSERT INTO decision_log (
      decision_date, product_name, action, reason, expectation, actual_result,
      strategy_version, target_annualized, bucket_plan, evaluation_at,
      rating, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateDecisionStatement = db.prepare(`
    UPDATE decision_log
    SET decision_date = ?, product_name = ?, action = ?, reason = ?, expectation = ?,
        actual_result = ?, strategy_version = ?, target_annualized = ?,
        bucket_plan = ?, evaluation_at = ?, rating = ?, updated_at = ?
    WHERE id = ?
  `);
  const deleteDecisionStatement = db.prepare('DELETE FROM decision_log WHERE id = ?');

  const selectHoldings = db.prepare('SELECT * FROM holdings ORDER BY purchase_date DESC, id DESC');
  const selectHolding = db.prepare('SELECT * FROM holdings WHERE id = ?');
  const insertHolding = db.prepare(`
    INSERT INTO holdings (
      product_name, product_code, issuer, risk_level, amount, purchase_date,
      term_days, maturity_date, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateHoldingStatement = db.prepare(`
    UPDATE holdings
    SET product_name = ?, product_code = ?, issuer = ?, risk_level = ?, amount = ?,
        purchase_date = ?, term_days = ?, maturity_date = ?, notes = ?, updated_at = ?
    WHERE id = ?
  `);
  const deleteHoldingStatement = db.prepare('DELETE FROM holdings WHERE id = ?');

  const selectEvents = db.prepare(`
    SELECT * FROM product_events ORDER BY event_date DESC, id DESC
  `);
  const selectEvent = db.prepare('SELECT * FROM product_events WHERE id = ?');
  const insertEvent = db.prepare(`
    INSERT INTO product_events (
      event_date, product_name, event_type, description, impact, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateEventStatement = db.prepare(`
    UPDATE product_events
    SET event_date = ?, product_name = ?, event_type = ?, description = ?,
        impact = ?, status = ?, updated_at = ?
    WHERE id = ?
  `);
  const deleteEventStatement = db.prepare('DELETE FROM product_events WHERE id = ?');

  const selectNotes = db.prepare('SELECT * FROM review_notes ORDER BY month DESC');
  const selectNote = db.prepare('SELECT * FROM review_notes WHERE month = ?');
  const upsertNote = db.prepare(`
    INSERT INTO review_notes (month, answers, conclusion, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(month) DO UPDATE SET
      answers = excluded.answers,
      conclusion = excluded.conclusion,
      updated_at = excluded.updated_at
  `);

  const selectQuarterlyNotes = db.prepare(
    'SELECT * FROM quarterly_notes ORDER BY quarter DESC',
  );
  const selectQuarterly = db.prepare('SELECT * FROM quarterly_notes WHERE quarter = ?');
  const upsertQuarterly = db.prepare(`
    INSERT INTO quarterly_notes (quarter, answers, conclusion, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(quarter) DO UPDATE SET
      answers = excluded.answers,
      conclusion = excluded.conclusion,
      updated_at = excluded.updated_at
  `);

  function listDecisions() {
    return selectDecisions.all().map(mapDecision);
  }

  function createDecision(decision) {
    const stamp = new Date().toISOString();
    const result = insertDecision.run(
      decision.date,
      decision.product_name,
      decision.action,
      decision.reason || '',
      decision.expectation || '',
      decision.actual_result || '',
      decision.strategy_version || 'r2-3pct-v1',
      Number(decision.target_annualized ?? 3),
      JSON.stringify(decision.bucket_plan || {}),
      parseEvaluationAt(decision.evaluation_at).join(',') ||
        'buy_day,holding,maturity',
      decision.rating || '待评估',
      stamp,
      stamp,
    );
    return mapDecision(selectDecision.get(Number(result.lastInsertRowid)));
  }

  function updateDecision(id, decision) {
    const stamp = new Date().toISOString();
    const result = updateDecisionStatement.run(
      decision.date,
      decision.product_name,
      decision.action,
      decision.reason || '',
      decision.expectation || '',
      decision.actual_result || '',
      decision.strategy_version || 'r2-3pct-v1',
      Number(decision.target_annualized ?? 3),
      JSON.stringify(decision.bucket_plan || {}),
      parseEvaluationAt(decision.evaluation_at).join(',') ||
        'buy_day,holding,maturity',
      decision.rating || '待评估',
      stamp,
      id,
    );
    if (Number(result.changes) === 0) return null;
    return mapDecision(selectDecision.get(id));
  }

  function deleteDecision(id) {
    return Number(deleteDecisionStatement.run(id).changes) > 0;
  }

  function listHoldings() {
    return selectHoldings.all().map(mapHolding);
  }

  function createHolding(holding) {
    const stamp = new Date().toISOString();
    const computedMaturity =
      holding.term_days !== null && holding.term_days > 0
        ? addDays(holding.purchase_date, holding.term_days)
        : null;
    const maturity = holding.maturity_date || computedMaturity || null;
    const result = insertHolding.run(
      holding.product_name,
      holding.product_code || '',
      holding.issuer || '',
      holding.risk_level || 'R2',
      holding.amount,
      holding.purchase_date,
      holding.term_days,
      maturity,
      holding.notes || '',
      stamp,
      stamp,
    );
    return mapHolding(selectHolding.get(Number(result.lastInsertRowid)));
  }

  function updateHolding(id, holding) {
    const stamp = new Date().toISOString();
    const computedMaturity =
      holding.term_days !== null && holding.term_days > 0
        ? addDays(holding.purchase_date, holding.term_days)
        : null;
    const maturity = holding.maturity_date || computedMaturity || null;
    const result = updateHoldingStatement.run(
      holding.product_name,
      holding.product_code || '',
      holding.issuer || '',
      holding.risk_level || 'R2',
      holding.amount,
      holding.purchase_date,
      holding.term_days,
      maturity,
      holding.notes || '',
      stamp,
      id,
    );
    if (Number(result.changes) === 0) return null;
    return mapHolding(selectHolding.get(id));
  }

  function deleteHolding(id) {
    return Number(deleteHoldingStatement.run(id).changes) > 0;
  }

  function listProductEvents() {
    return selectEvents.all().map(mapProductEvent);
  }

  function createProductEvent(event) {
    const stamp = new Date().toISOString();
    const result = insertEvent.run(
      event.date,
      event.product_name,
      event.event_type,
      event.description || '',
      event.impact || '中',
      event.status || '待复核',
      stamp,
      stamp,
    );
    return mapProductEvent(selectEvent.get(Number(result.lastInsertRowid)));
  }

  function updateProductEvent(id, event) {
    const stamp = new Date().toISOString();
    const result = updateEventStatement.run(
      event.date,
      event.product_name,
      event.event_type,
      event.description || '',
      event.impact || '中',
      event.status || '待复核',
      stamp,
      id,
    );
    if (Number(result.changes) === 0) return null;
    return mapProductEvent(selectEvent.get(id));
  }

  function deleteProductEvent(id) {
    return Number(deleteEventStatement.run(id).changes) > 0;
  }

  function listReviewNotes() {
    return selectNotes.all().map(mapReviewNote);
  }

  function getReviewNote(month) {
    return mapReviewNote(selectNote.get(month));
  }

  function saveReviewNote(month, note) {
    const stamp = new Date().toISOString();
    upsertNote.run(
      month,
      JSON.stringify(note.answers || []),
      note.conclusion || '',
      stamp,
      stamp,
    );
    return mapReviewNote(selectNote.get(month));
  }

  function listQuarterlyNotes() {
    return selectQuarterlyNotes.all().map(mapQuarterlyNote);
  }

  function getQuarterlyNote(quarter) {
    return mapQuarterlyNote(selectQuarterly.get(quarter));
  }

  function saveQuarterlyNote(quarter, note) {
    const stamp = new Date().toISOString();
    upsertQuarterly.run(
      quarter,
      JSON.stringify(note.answers || []),
      note.conclusion || '',
      stamp,
      stamp,
    );
    return mapQuarterlyNote(selectQuarterly.get(quarter));
  }

  function getReviewWorkspace({
    today,
    records = [],
    review = null,
    holdings: holdingsOverride = null,
    trades = null,
  }) {
    const notes = listReviewNotes();
    const quarterly = listQuarterlyNotes();
    const holdings = holdingsOverride || listHoldings();
    return {
      decisions: listDecisions(),
      holdings,
      trades,
      events: listProductEvents(),
      notes,
      quarterly,
      holdings_summary: buildHoldingsSummary(holdings, today),
      timeline: buildTimeline({
        today,
        records,
        review,
        notes,
        quarterlyNotes: quarterly,
      }),
    };
  }

  return {
    listDecisions,
    createDecision,
    updateDecision,
    deleteDecision,
    listHoldings,
    createHolding,
    updateHolding,
    deleteHolding,
    listProductEvents,
    createProductEvent,
    updateProductEvent,
    deleteProductEvent,
    listReviewNotes,
    getReviewNote,
    saveReviewNote,
    listQuarterlyNotes,
    getQuarterlyNote,
    saveQuarterlyNote,
    getReviewWorkspace,
  };
}

module.exports = {
  REVIEW_SCHEMA,
  buildHoldingsSummary,
  buildTimeline,
  createReviewStore,
  migrateDecisionColumns,
  monthLabel,
  quarterLabel,
  shiftMonth,
  shiftQuarter,
};
