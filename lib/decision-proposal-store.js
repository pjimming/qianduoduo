'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_PROPOSAL_STATUSES = ['pending', 'accepted'];
const NO_AVAILABLE_CASH_REASON = '当前可分配资金为 0，自动作废';
const EXPIRED_REASON = '有效期已过，自动作废';
const SUPERSEDED_REASON = '已由新的同类提案替代';
const { buildPrediction } = require('./decision-calibration');

const PROPOSAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS decision_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    group_key TEXT NOT NULL,
    proposal_type TEXT NOT NULL CHECK (
      proposal_type IN ('holding_switch', 'cash_allocation')
    ),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('买入', '赎回', '切换', '观察')),
    product_name TEXT NOT NULL,
    product_code TEXT NOT NULL DEFAULT '',
    target_product_code TEXT NOT NULL DEFAULT '',
    target_product_name TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL DEFAULT 0,
    evidence_date TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL DEFAULT '',
    verify_date TEXT NOT NULL DEFAULT '',
    confidence INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
      status IN (
        'pending',
        'accepted',
        'executed',
        'confirmed',
        'rejected',
        'expired'
      )
    ),
    decision_id INTEGER,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    accepted_at TEXT,
    rejected_at TEXT,
    reject_reason TEXT NOT NULL DEFAULT '',
    executed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_decision_proposals_status
    ON decision_proposals(status, expires_at, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_decision_proposals_group
    ON decision_proposals(group_key, status, updated_at DESC);
`;

function parseYmd(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) ? stamp : null;
}

function addDays(date, days) {
  const stamp = parseYmd(date);
  if (stamp === null) return '';
  return new Date(stamp + days * DAY_MS).toISOString().slice(0, 10);
}

function parseObject(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function roundMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function buildExecutionPrediction({
  sourceRef,
  recommendationType,
  action,
  createdAt,
  startDate,
  reviewDate,
  confidence,
  amount,
  evidenceRefs,
  invalidationCondition,
  originalText,
}) {
  return buildPrediction({
    recommendation_type: recommendationType,
    action,
    source: 'platform-proposal',
    source_ref: sourceRef,
    created_at: createdAt,
    data_cutoff_at: createdAt,
    start_date: startDate,
    review_date: reviewDate,
    confidence,
    evidence_refs: evidenceRefs,
    baseline: {
      metric: 'executed_amount',
      value: 0,
      label: '未执行基线',
      unit: '元',
    },
    expected: {
      direction: 'at_least',
      target: { point: amount, unit: '元' },
    },
    metric: 'executed_amount',
    evaluation: {
      method: 'confirmed_trade_amount',
      tolerance_abs: 1,
    },
    invalidation_condition: invalidationCondition,
    invalidation_triggers: ['decision_cancelled'],
    original_text: originalText,
  });
}

function mapProposal(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    dedupe_key: row.dedupe_key,
    group_key: row.group_key,
    proposal_type: row.proposal_type,
    title: row.title,
    summary: row.summary,
    action: row.action,
    product_name: row.product_name,
    product_code: row.product_code || '',
    target_product_code: row.target_product_code || '',
    target_product_name: row.target_product_name || '',
    amount: Number(row.amount),
    evidence_date: row.evidence_date || '',
    expires_at: row.expires_at || '',
    verify_date: row.verify_date || '',
    confidence: Number(row.confidence),
    status: row.status,
    decision_id: row.decision_id === null ? null : Number(row.decision_id),
    payload: parseObject(row.payload_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    accepted_at: row.accepted_at || null,
    rejected_at: row.rejected_at || null,
    reject_reason: row.reject_reason || '',
    executed_at: row.executed_at || null,
  };
}

function createDecisionProposalStore(db, options = {}) {
  const { reviewStore, tradeStore, transactionManager } = options;
  if (!reviewStore || !tradeStore) {
    throw new Error('createDecisionProposalStore 需要 reviewStore 和 tradeStore');
  }
  const runTransaction =
    transactionManager?.run || ((callback) => callback());
  db.exec(PROPOSAL_SCHEMA);

  const selectAll = db.prepare(`
    SELECT * FROM decision_proposals ORDER BY updated_at DESC, id DESC
  `);
  const selectProposal = db.prepare('SELECT * FROM decision_proposals WHERE id = ?');
  const selectByKey = db.prepare(
    'SELECT * FROM decision_proposals WHERE dedupe_key = ?',
  );
  const selectGroup = db.prepare(`
    SELECT * FROM decision_proposals
    WHERE group_key = ?
    ORDER BY
      CASE status WHEN 'accepted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
      updated_at DESC,
      id DESC
  `);
  const insertProposal = db.prepare(`
    INSERT INTO decision_proposals (
      dedupe_key, group_key, proposal_type, title, summary, action,
      product_name, product_code, target_product_code, target_product_name,
      amount, evidence_date, expires_at, verify_date, confidence, status,
      decision_id, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)
  `);
  const updateProposal = db.prepare(`
    UPDATE decision_proposals
    SET title = ?, summary = ?, action = ?, product_name = ?, product_code = ?,
        target_product_code = ?, target_product_name = ?, amount = ?,
        evidence_date = ?, verify_date = ?, confidence = ?, payload_json = ?,
        updated_at = ?
    WHERE id = ? AND status = 'pending'
  `);
  const updateStatus = db.prepare(`
    UPDATE decision_proposals
    SET status = ?, decision_id = COALESCE(?, decision_id),
        accepted_at = COALESCE(?, accepted_at),
        rejected_at = COALESCE(?, rejected_at),
        reject_reason = CASE WHEN ? <> '' THEN ? ELSE reject_reason END,
        executed_at = COALESCE(?, executed_at),
        updated_at = ?
    WHERE id = ?
  `);
  const expireProposal = db.prepare(`
    UPDATE decision_proposals
    SET status = 'expired',
        reject_reason = CASE WHEN ? <> '' THEN ? ELSE reject_reason END,
        updated_at = ?
    WHERE id = ? AND status = 'pending'
  `);
  const detachDecisionStatement = db.prepare(`
    UPDATE decision_proposals
    SET status = 'rejected', decision_id = NULL, rejected_at = ?,
        reject_reason = ?, updated_at = ?
    WHERE id = ?
  `);

  const selectAcceptedWithDecision = db.prepare(`
    SELECT * FROM decision_proposals
    WHERE status IN ('accepted', 'executed', 'confirmed')
      AND decision_id IS NOT NULL
    ORDER BY accepted_at DESC, id DESC
  `);
  const selectByDecision = db.prepare(`
    SELECT * FROM decision_proposals WHERE decision_id = ?
    ORDER BY updated_at DESC, id DESC
  `);

  function expirePending(today) {
    let expired = 0;
    const stamp = new Date().toISOString();
    for (const row of selectAll.all()) {
      if (
        row.status === 'pending' &&
        row.expires_at &&
        row.expires_at < today
      ) {
        const result = expireProposal.run(
          EXPIRED_REASON,
          EXPIRED_REASON,
          stamp,
          row.id,
        );
        expired += Number(result.changes || 0);
      }
    }
    return expired;
  }

  function expireCashAllocationsWithoutFunding(availableCash) {
    const cash = Number(availableCash);
    if (!Number.isFinite(cash) || cash > 0.01) return 0;
    let expired = 0;
    const stamp = new Date().toISOString();
    for (const row of selectAll.all()) {
      if (row.status !== 'pending' || row.proposal_type !== 'cash_allocation') {
        continue;
      }
      const result = expireProposal.run(
        NO_AVAILABLE_CASH_REASON,
        NO_AVAILABLE_CASH_REASON,
        stamp,
        row.id,
      );
      expired += Number(result.changes || 0);
    }
    return expired;
  }

  function listProposals() {
    const decisionsById = new Map(
      reviewStore.listDecisions().map((decision) => [decision.id, decision]),
    );
    return selectAll.all().map((row) => {
      const proposal = mapProposal(row);
      const decision = proposal.decision_id
        ? decisionsById.get(proposal.decision_id)
        : null;
      return {
        ...proposal,
        decision_execution_status:
          decision?.review_meta?.execution_status || null,
        decision_audit_status: decision?.review_meta?.audit_status || null,
      };
    });
  }

  function getProposal(id) {
    return mapProposal(selectProposal.get(id));
  }

  function activeGroupProposal(groupKey) {
    return (
      selectGroup
        .all(groupKey)
        .map(mapProposal)
        .find((item) => ACTIVE_PROPOSAL_STATUSES.includes(item.status)) || null
    );
  }

  function expireOtherPending(groupKey, keepId, stamp) {
    for (const row of selectGroup.all(groupKey)) {
      if (row.status !== 'pending' || Number(row.id) === Number(keepId)) continue;
      expireProposal.run(
        SUPERSEDED_REASON,
        SUPERSEDED_REASON,
        stamp,
        row.id,
      );
    }
  }

  function upsertProposal(input) {
    const stamp = new Date().toISOString();
    const existingSame = mapProposal(selectByKey.get(input.dedupe_key));
    if (existingSame?.status === 'pending') {
      const preservedPrediction =
        existingSame.payload?.prediction || input.payload?.prediction || null;
      updateProposal.run(
        input.title,
        input.summary,
        input.action,
        input.product_name,
        input.product_code || '',
        input.target_product_code || '',
        input.target_product_name || '',
        roundMoney(input.amount),
        input.evidence_date || '',
        input.verify_date || '',
        Math.max(0, Math.min(100, Number(input.confidence) || 0)),
        JSON.stringify({
          ...(input.payload || {}),
          prediction: preservedPrediction,
          original_summary:
            existingSame.payload?.original_summary || input.summary,
        }),
        stamp,
        existingSame.id,
      );
      expireOtherPending(existingSame.group_key, existingSame.id, stamp);
      return getProposal(existingSame.id);
    }

    const active = activeGroupProposal(input.group_key);
    if (active) return active;

    let dedupeKey = input.dedupe_key;
    if (existingSame) {
      const canReissue =
        existingSame.status === 'expired' &&
        existingSame.reject_reason === NO_AVAILABLE_CASH_REASON;
      if (!canReissue) return existingSame;
      const latestId = Math.max(
        ...selectGroup.all(input.group_key).map((row) => Number(row.id)),
        existingSame.id,
      );
      dedupeKey = `${input.dedupe_key}:reissue:${latestId + 1}`;
    }

    const result = insertProposal.run(
      dedupeKey,
      input.group_key,
      input.proposal_type,
      input.title,
      input.summary,
      input.action,
      input.product_name,
      input.product_code || '',
      input.target_product_code || '',
      input.target_product_name || '',
      roundMoney(input.amount),
      input.evidence_date || '',
      input.expires_at || '',
      input.verify_date || '',
      Math.max(0, Math.min(100, Number(input.confidence) || 0)),
      JSON.stringify(input.payload || {}),
      stamp,
      stamp,
    );
    const proposal = getProposal(Number(result.lastInsertRowid));
    expireOtherPending(proposal.group_key, proposal.id, stamp);
    return proposal;
  }

  function holdingSwitchProposal(review, today) {
    const candidate =
      (review.candidates || []).find(
        (item) => item.code === review.top_candidate_code,
      ) || (review.candidates || [])[0];
    if (
      review.verdict !== 'replace' ||
      !candidate ||
      !review.redemption?.redeemable_now
    ) {
      return null;
    }
    const amount = roundMoney(review.amount);
    const difference = Number(candidate.switch?.difference || 0);
    const threshold = Number(
      candidate.min_gain_amount ?? review.thresholds?.min_gain_amount ?? 0,
    );
    const wait = Number(candidate.switch_wait_days);
    const summary =
      `比较 ${candidate.comparison_days} 天，切换等待 ${wait} 天` +
      `（${candidate.switch_wait_status === 'verified' ? '已核验' : '估算'}），` +
      `预计扣费后多赚 ¥${difference.toFixed(2)}，门槛 ¥${threshold.toFixed(2)}。`;
    const confidence =
      candidate.switch_wait_status === 'verified' &&
      candidate.execution_ready
        ? 92
        : candidate.switch_wait_status === 'verified'
          ? 82
          : 68;
    const reviewDate = review.verify_date || addDays(today, 30);
    const candidateYield = Number(candidate.yield_pct);
    const currentYield = Number(review.current?.yield_pct);
    const dedupeKey =
      `holding:${review.lot_id}:${candidate.code}:${review.evidence_date}:${amount}`;
    const createdAt = new Date().toISOString();
    const evidenceRefs = [
      {
        type: 'holding_lot',
        ref: String(review.lot_id),
        as_of: review.evidence_date || today,
      },
      {
        type: 'candidate_product',
        ref: candidate.code,
        as_of: review.evidence_date || today,
      },
      {
        type: 'execution_cost',
        ref: String(review.lot_id),
        as_of: review.evidence_date || today,
        switch_wait_days: candidate.switch_wait_days,
        switch_wait_status: candidate.switch_wait_status,
        effective_days: candidate.effective_days,
        redemption_fee_bps: review.redemption?.fee_bps ?? null,
        purchase_fee_bps: candidate.purchase_fee_bps ?? null,
      },
    ];
    const invalidationCondition =
      '若候选额度、期限、费率或赎回规则变化，决策取消，实际确认/到账未按计划，或目标产品没有足够正式收益事实，则预测失效或保持待验证。';
    const prediction = Number.isFinite(candidateYield)
      ? buildPrediction({
      recommendation_type: 'holding_switch',
      action: '切换',
      source: 'platform-proposal',
      source_ref: dedupeKey,
      created_at: createdAt,
      data_cutoff_at: createdAt,
      start_date: today,
      review_date: reviewDate,
      confidence,
      evidence_refs: evidenceRefs,
      baseline: {
        metric: 'personal_annualized_return_pct',
        value: Number.isFinite(currentYield) ? currentYield : null,
        label: '当前产品参考年化',
        unit: '%',
      },
      expected: {
        direction: 'at_least',
        target: { point: candidateYield, unit: '%' },
      },
      metric: 'personal_annualized_return_pct',
      evaluation: {
        method: 'confirmed_trade_personal_annualized',
        minimum_observations: 7,
        minimum_coverage_ratio: 0.5,
        tolerance_pp: 0.15,
      },
      invalidation_condition: invalidationCondition,
      invalidation_triggers: ['decision_cancelled'],
      original_text: summary,
      })
      : buildExecutionPrediction({
          sourceRef: dedupeKey,
          recommendationType: 'holding_switch',
          action: '切换',
          createdAt,
          startDate: today,
          reviewDate,
          confidence,
          amount,
          evidenceRefs,
          invalidationCondition,
          originalText: summary,
        });
    if (!prediction) return null;
    return upsertProposal({
      dedupe_key: dedupeKey,
      group_key: `holding:${review.lot_id}`,
      proposal_type: 'holding_switch',
      title: `换仓提案：${review.product_name} → ${candidate.name}`,
      summary,
      action: '切换',
      product_name: `${review.product_name} → ${candidate.name}`,
      product_code: review.product_code,
      target_product_code: candidate.code,
      target_product_name: candidate.name,
      amount,
      evidence_date: review.evidence_date || today,
      expires_at: addDays(today, 7),
      verify_date: reviewDate,
      confidence,
      payload: {
        prediction,
        original_summary: summary,
        decision: {
          reason:
            `持仓复核：${review.product_name}（${review.product_code}）与 ${candidate.name}` +
            `（${candidate.code}）按 ${candidate.comparison_days} 天统一比较，` +
            `扣费后预计多赚 ¥${difference.toFixed(2)}，达到 ¥${threshold.toFixed(2)} 门槛。`,
          expectation:
            `在 ${candidate.effective_days ?? '待核'} 天有效计息期达到测算收益；` +
            `执行前在招行 App 复核额度、费率与赎回规则。`,
          invalidation_condition:
            `若候选额度、期限、费率或赎回规则变化，实际确认/到账未按计划，` +
            `或扣费后净增益低于门槛，则取消或重做替换。`,
          bucket_plan: { short: 30, medium: 35, long: 35, max_single: 30 },
        },
        review_meta: {
          holding_lot_id: review.lot_id,
          holding_code: review.product_code,
          holding_name: review.product_name,
          candidate_code: candidate.code,
          candidate_name: candidate.name,
          snapshot_date: review.evidence_date,
          comparison_days: candidate.comparison_days,
          switch_wait_days: candidate.switch_wait_days,
          switch_wait_status: candidate.switch_wait_status,
          effective_days: candidate.effective_days,
          expected_difference: difference,
          min_gain_amount: threshold,
          break_even_yield_pct: candidate.switch?.break_even_yield_pct ?? null,
          planned_action: 'replace_now',
        },
        expected_legs: [
          {
            side: 'redeem',
            product_code: review.product_code,
            product_name: review.product_name,
            amount,
          },
          {
            side: 'buy',
            product_code: candidate.code,
            product_name: candidate.name,
            amount,
          },
        ],
      },
    });
  }

  function cashAllocationProposal(product, allocation, dashboard, today) {
    const amount = roundMoney(product.target_amount);
    if (amount <= 0 || allocation.available_cash <= 0.01) return null;
    const allocationMode =
      product.allocation_mode === 'top_up' ? 'top_up' : 'new';
    const meaningfulMinimum = roundMoney(product.meaningful_min_amount);
    if (
      allocationMode === 'new' &&
      meaningfulMinimum > 0 &&
      amount + 0.01 < meaningfulMinimum
    ) {
      return null;
    }
    const snapshot = dashboard.meta.product_snapshot_date || today;
    const modeLabel = allocationMode === 'top_up' ? '已确认持仓补仓' : '首次建仓';
    const confidence =
      product.quota_status === 'verified' ? 88 : 72;
    const summary =
      `当前可分配 ¥${allocation.available_cash.toFixed(2)}，` +
      `${modeLabel}目标买入 ¥${amount.toFixed(2)}；` +
      `${product.allocation_reason || '按当前期限桶与额度约束配置。'}`;
    const reviewDate = addDays(today, 30);
    const targetYield = Number(
      product.yield_pct ??
        product.reference_yield_pct ??
        product.return_3m ??
        product.return_6m ??
        product.return_1y,
    );
    const dedupeKey =
      `allocation:${product.code}:${snapshot}:${amount}`;
    const createdAt = new Date().toISOString();
    const evidenceRefs = [
      {
        type: 'product_snapshot',
        ref: product.code,
        as_of: snapshot,
      },
      {
        type: 'allocation_result',
        ref: product.allocation_bucket || 'unknown',
        as_of: snapshot,
      },
      {
        type: 'execution_cost',
        ref: product.code,
        as_of: snapshot,
        fee_bps: product.fee_bps ?? null,
        quota_status: product.quota_status,
        purchase_confirm_days: product.purchase_confirm_days ?? null,
      },
    ];
    const invalidationCondition =
      '若额度售罄、风险等级/费率/赎回规则变化、单只或底层策略上限超限、资金安排变化、决策取消，或缺少足够正式产品收益事实，则预测失效或保持待验证。';
    const prediction = Number.isFinite(targetYield)
      ? buildPrediction({
      recommendation_type: 'cash_allocation',
      action: '买入',
      source: 'platform-proposal',
      source_ref: dedupeKey,
      created_at: createdAt,
      data_cutoff_at: createdAt,
      start_date: today,
      review_date: reviewDate,
      confidence,
      evidence_refs: evidenceRefs,
      baseline: {
        metric: 'personal_annualized_return_pct',
        value: 0,
        label: '待配置资金机会成本基线',
        unit: '%',
      },
      expected: {
        direction: 'at_least',
        target: { point: targetYield, unit: '%' },
      },
      metric: 'personal_annualized_return_pct',
      evaluation: {
        method: 'confirmed_trade_personal_annualized',
        minimum_observations: 7,
        minimum_coverage_ratio: 0.5,
        tolerance_pp: 0.15,
      },
      invalidation_condition: invalidationCondition,
      invalidation_triggers: ['decision_cancelled'],
      original_text: summary,
      })
      : buildExecutionPrediction({
          sourceRef: dedupeKey,
          recommendationType: 'cash_allocation',
          action: '买入',
          createdAt,
          startDate: today,
          reviewDate,
          confidence,
          amount,
          evidenceRefs,
          invalidationCondition,
          originalText: summary,
        });
    if (!prediction) return null;
    return upsertProposal({
      dedupe_key: dedupeKey,
      group_key: `allocation:${product.code}`,
      proposal_type: 'cash_allocation',
      title: `${allocationMode === 'top_up' ? '持仓补仓' : '资金首次配置'}：${product.name}`,
      summary,
      action: '买入',
      product_name: product.name,
      product_code: product.code,
      amount,
      evidence_date: snapshot,
      expires_at: addDays(today, 3),
      verify_date: reviewDate,
      confidence,
      payload: {
        prediction,
        original_summary: summary,
        decision: {
          reason:
            `当前有 ¥${allocation.available_cash.toFixed(2)} 可分配资金，` +
            `${product.name}（${product.code}）${modeLabel}符合当前期限桶、单只/底层策略和额度约束。`,
          expectation:
            `按目标买入 ¥${amount.toFixed(2)}，买入前复核当日额度、费率和确认时间。`,
          invalidation_condition:
            `若额度售罄、风险等级/费率/赎回规则变化、单只/底层策略上限超限或用钱日期变化，则取消配置。`,
          bucket_plan: { short: 30, medium: 35, long: 35, max_single: 30 },
        },
        review_meta: {
          allocation_bucket: product.allocation_bucket,
          allocation_mode: allocationMode,
          snapshot_date: snapshot,
          target_amount: amount,
          target_pct: product.target_pct,
          existing_exposure: roundMoney(product.existing_exposure),
          meaningful_min_amount: meaningfulMinimum,
          meaningful_target_amount: roundMoney(product.meaningful_target_amount),
          selection_score: product.selection_score,
          quota_status: product.quota_status,
          quota_available: product.quota_available,
          quota_verified_at: product.quota_verified_at,
        },
        expected_legs: [
          {
            side: 'buy',
            product_code: product.code,
            product_name: product.name,
            amount,
          },
        ],
      },
    });
  }

  function sync(dashboard) {
    return runTransaction(() => {
      const today = dashboard.meta.today;
      expirePending(today);
      const existingDecisions = reviewStore.listDecisions();
      const decisionsByHolding = new Map();
      for (const decision of existingDecisions) {
        const holdingCode = decision.review_meta?.holding_code;
        if (holdingCode) decisionsByHolding.set(holdingCode, decision);
      }

      for (const review of dashboard.workspace?.holding_reviews || []) {
        if (decisionsByHolding.has(review.product_code)) continue;
        holdingSwitchProposal(review, today);
      }

      const allocation = dashboard.products?.allocation;
      const availableCash = Number(allocation?.available_cash ?? 0);
      expireCashAllocationsWithoutFunding(availableCash);
      if (availableCash > 0.01) {
        for (const product of dashboard.products?.watchlist || []) {
          if (!product.selected || product.target_amount <= 0) continue;
          cashAllocationProposal(product, allocation, dashboard, today);
        }
      }
      reconcileExecutionStatuses(today);
    });
  }

  function decisionForProposal(proposal, today) {
    const payload = proposal.payload || {};
    const decisionInput = payload.decision || {};
    const reviewMeta = payload.review_meta || {};
    const acceptedAt = new Date().toISOString();
    return {
      date: today,
      product_name: proposal.product_name,
      action: proposal.action,
      reason: decisionInput.reason || proposal.summary,
      expectation:
        decisionInput.expectation ||
        '按提案条件执行，并在验证日复核实际结果。',
      invalidation_condition:
        decisionInput.invalidation_condition ||
        '若额度、风险、费率、赎回规则或资金安排变化，则重新评估。',
      actual_result: '',
      strategy_version: 'r2-3pct-v1',
      target_annualized: 3,
      bucket_plan:
        decisionInput.bucket_plan ||
        { short: 30, medium: 35, long: 35, max_single: 30 },
      evaluation_at: ['buy_day', 'holding', 'maturity'],
      evidence_date: proposal.evidence_date || today,
      verify_date: proposal.verify_date || addDays(today, 30),
      review_meta: {
        ...reviewMeta,
        proposal_id: proposal.id,
        proposal_type: proposal.proposal_type,
        proposal_accepted_at: acceptedAt,
        prediction_decided_at: acceptedAt,
        proposal_expires_at: proposal.expires_at,
        lifecycle_status: 'accepted',
        execution_status: 'pending',
        audit_status: 'pending',
        expected_legs: payload.expected_legs || [],
        predictions: payload.prediction ? [payload.prediction] : [],
        prediction_results:
          reviewMeta.prediction_results &&
          typeof reviewMeta.prediction_results === 'object'
            ? reviewMeta.prediction_results
            : {},
        matched_trade_ids: [],
      },
      rating: '待评估',
    };
  }

  function adoptProposal(id, { today }) {
    const proposal = getProposal(id);
    if (!proposal) return null;
    if (proposal.status !== 'pending') {
      throw new Error('只有待采纳提案可以采纳');
    }
    if (proposal.expires_at && proposal.expires_at < today) {
      const stamp = new Date().toISOString();
      expireProposal.run('有效期已过，无法采纳', '有效期已过，无法采纳', stamp, id);
      throw new Error('提案已过期，请刷新后重新生成');
    }
    const decision = reviewStore.createDecision(
      decisionForProposal(proposal, today),
    );
    const stamp = new Date().toISOString();
    updateStatus.run(
      'accepted',
      decision.id,
      stamp,
      null,
      '',
      '',
      null,
      stamp,
      id,
    );
    return {
      proposal: getProposal(id),
      decision,
    };
  }

  function rejectProposal(id, { reason = '' } = {}) {
    const proposal = getProposal(id);
    if (!proposal) return null;
    if (!['pending', 'accepted'].includes(proposal.status)) {
      throw new Error('只有待采纳或待执行提案可以拒绝');
    }
    const stamp = new Date().toISOString();
    const note = String(reason || '').trim().slice(0, 500);
    if (proposal.status === 'accepted' && proposal.decision_id) {
      const linkedTrades = tradeStore
        .listTrades()
        .filter(
          (trade) =>
            trade.decision_id === proposal.decision_id &&
            trade.status !== 'cancelled',
        );
      if (linkedTrades.length) {
        throw new Error('该提案已有交易关联，不能直接取消');
      }
      const decision = reviewStore
        .listDecisions()
        .find((item) => item.id === proposal.decision_id);
      if (decision) {
        reviewStore.updateDecision(decision.id, {
          ...decision,
          actual_result: [
            decision.actual_result,
            `[提案取消] ${stamp.slice(0, 10)} ${note || '用户取消已采纳提案'}`,
          ]
            .filter(Boolean)
            .join('\n'),
          review_meta: {
            ...(decision.review_meta || {}),
            lifecycle_status: 'cancelled',
            execution_status: 'cancelled',
            audit_status: 'cancelled',
            proposal_cancelled_at: stamp,
          },
        });
      }
    }
    updateStatus.run(
      'rejected',
      proposal.decision_id,
      null,
      stamp,
      note,
      note,
      null,
      stamp,
      id,
    );
    return getProposal(id);
  }

  function detachDecision(decisionId, reason = '关联决策已删除') {
    let detached = 0;
    const stamp = new Date().toISOString();
    for (const proposal of selectByDecision.all(decisionId).map(mapProposal)) {
      if (!['accepted', 'executed', 'confirmed'].includes(proposal.status)) {
        continue;
      }
      const note = String(reason || '').trim().slice(0, 500);
      detachDecisionStatement.run(stamp, note, stamp, proposal.id);
      detached += 1;
    }
    return detached;
  }

  function legForTrade(trade, leg) {
    const side = String(leg.side || '');
    const directionMatches =
      (side === 'buy' && ['buy', 'switch'].includes(trade.trade_type)) ||
      (side === 'redeem' && ['redeem', 'switch'].includes(trade.trade_type));
    if (!directionMatches) return null;
    const tradeCode =
      side === 'buy' && trade.trade_type === 'switch'
        ? trade.target_product_code
        : trade.product_code;
    if (normalizeCode(tradeCode) !== normalizeCode(leg.product_code)) return null;
    const expectedAmount = roundMoney(leg.amount);
    const delta = roundMoney(Math.abs(Number(trade.amount) - expectedAmount));
    const tolerance = Math.max(1, expectedAmount * 0.2);
    if (delta > tolerance) return null;
    return {
      side,
      product_code: leg.product_code,
      expected_amount: expectedAmount,
      actual_amount: roundMoney(trade.amount),
      amount_delta: delta,
      status: delta <= 0.01 ? 'matched' : 'amount-adjustment',
      trade_id: trade.id,
    };
  }

  function executionState(decision, proposal) {
    const expectedLegs = Array.isArray(decision.review_meta?.expected_legs)
      ? decision.review_meta.expected_legs
      : proposal.payload?.expected_legs || [];
    const linkedTrades = tradeStore
      .listTrades()
      .filter(
        (trade) =>
          trade.decision_id === decision.id && trade.status !== 'cancelled',
      );
    const legMatches = [];
    for (const leg of expectedLegs) {
      const trade = linkedTrades.find((item) => legForTrade(item, leg));
      if (trade) legMatches.push(legForTrade(trade, leg));
    }
    const allMatched =
      expectedLegs.length > 0 && legMatches.length === expectedLegs.length;
    const allConfirmed =
      allMatched &&
      linkedTrades.length > 0 &&
      linkedTrades.every((trade) => trade.status === 'confirmed');
    const executionStatus = allConfirmed
      ? 'confirmed'
      : allMatched
        ? 'executed'
        : legMatches.length
          ? 'partial'
          : linkedTrades.length
            ? 'deviation'
            : 'pending';
    const checks = [
      {
        key: 'legs',
        label: '交易方向与产品',
        pass: allMatched,
      },
      {
        key: 'amount',
        label: '成交金额',
        pass:
          allMatched &&
          legMatches.every((item) => item.status === 'matched'),
      },
      {
        key: 'screenshot',
        label: '成交截图',
        pass:
          linkedTrades.length > 0 &&
          linkedTrades.every((trade) => Boolean(trade.screenshot_id)),
      },
      {
        key: 'risk',
        label: '风险等级',
        pass:
          linkedTrades.length > 0 &&
          linkedTrades.every((trade) => ['R2', 'PR2'].includes(trade.risk_level)),
      },
    ];
    const auditStatus = !linkedTrades.length
      ? 'pending'
      : !allMatched
        ? 'deviation'
        : checks.every((check) => check.pass)
          ? 'matched'
          : 'review';
    return {
      execution_status: executionStatus,
      audit_status: auditStatus,
      audit_checks: checks,
      leg_matches: legMatches,
      matched_trade_ids: linkedTrades.map((trade) => trade.id),
      confirmed_trade_ids: linkedTrades
        .filter((trade) => trade.status === 'confirmed')
        .map((trade) => trade.id),
    };
  }

  function updateExecution(proposal, decision, today) {
    const state = executionState(decision, proposal);
    const lifecycleStatus =
      state.execution_status === 'confirmed'
        ? 'confirmed'
        : state.execution_status === 'deviation'
          ? 'execution_deviation'
        : state.execution_status === 'pending'
          ? 'accepted'
          : 'executed';
    const currentMeta = decision.review_meta || {};
    const comparableKeys = [
      'lifecycle_status',
      'execution_status',
      'audit_status',
      'audit_checks',
      'leg_matches',
      'matched_trade_ids',
      'confirmed_trade_ids',
    ];
    const currentComparable = JSON.stringify(
      Object.fromEntries(
        comparableKeys.map((key) => [key, currentMeta[key] ?? null]),
      ),
    );
    const nextComparable = JSON.stringify({
      lifecycle_status: lifecycleStatus,
      execution_status: state.execution_status,
      audit_status: state.audit_status,
      audit_checks: state.audit_checks,
      leg_matches: state.leg_matches,
      matched_trade_ids: state.matched_trade_ids,
      confirmed_trade_ids: state.confirmed_trade_ids,
    });
    const reviewMeta = {
      ...currentMeta,
      ...state,
      lifecycle_status: lifecycleStatus,
      proposal_expires_at: proposal.expires_at,
    };
    let updatedDecision = decision;
    if (currentComparable !== nextComparable) {
      reviewMeta.execution_updated_at = new Date().toISOString();
      updatedDecision = reviewStore.updateDecision(decision.id, {
        ...decision,
        review_meta: reviewMeta,
      });
    }
    let proposalStatus = proposal.status;
    if (state.execution_status === 'confirmed') proposalStatus = 'confirmed';
    else if (state.execution_status === 'executed') proposalStatus = 'executed';
    else proposalStatus = 'accepted';
    if (proposalStatus !== proposal.status) {
      const stamp = new Date().toISOString();
      updateStatus.run(
        proposalStatus,
        proposal.decision_id,
        proposal.accepted_at,
        proposal.rejected_at,
        '',
        '',
        proposalStatus === 'executed' || proposalStatus === 'confirmed'
          ? proposal.executed_at || stamp
          : proposal.executed_at,
        stamp,
        proposal.id,
      );
    }
    return {
      decision: updatedDecision,
      audit: state,
    };
  }

  function reconcileExecutionStatuses(today) {
    const decisionsById = new Map(
      reviewStore.listDecisions().map((decision) => [decision.id, decision]),
    );
    let updated = 0;
    for (const proposal of selectAcceptedWithDecision.all().map(mapProposal)) {
      const decision = decisionsById.get(proposal.decision_id);
      if (!decision) continue;
      const before = JSON.stringify(decision.review_meta || {});
      const result = updateExecution(proposal, decision, today);
      if (JSON.stringify(result.decision.review_meta || {}) !== before) updated += 1;
    }
    return updated;
  }

  function matchTrade(trade, today) {
    if (!trade || trade.status === 'cancelled' || trade.decision_id) return null;
    const decisionsById = new Map(
      reviewStore.listDecisions().map((decision) => [decision.id, decision]),
    );
    const candidates = [];
    for (const proposal of selectAcceptedWithDecision.all().map(mapProposal)) {
      if (!ACTIVE_PROPOSAL_STATUSES.includes(proposal.status)) continue;
      if (proposal.expires_at && proposal.expires_at < today) continue;
      const decision = decisionsById.get(proposal.decision_id);
      if (!decision) continue;
      const legs = Array.isArray(decision.review_meta?.expected_legs)
        ? decision.review_meta.expected_legs
        : proposal.payload?.expected_legs || [];
      const match = legs.map((leg) => legForTrade(trade, leg)).find(Boolean);
      if (!match) continue;
      candidates.push({
        proposal,
        decision,
        match,
        score:
          (match.status === 'matched' ? 1000 : 500) -
          match.amount_delta +
          Number(proposal.confidence || 0) / 1000,
      });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const linkedTrade = tradeStore.updateTrade(
      trade.id,
      { ...trade, decision_id: best.decision.id },
      `匹配已采纳决策提案 #${best.proposal.id}`,
    );
    const result = updateExecution(best.proposal, best.decision, today);
    return {
      trade: linkedTrade,
      decision: result.decision,
      proposal: getProposal(best.proposal.id),
      audit: result.audit,
    };
  }

  function getWorkspace(today) {
    const proposals = listProposals();
    const pending = proposals.filter((item) => item.status === 'pending');
    const accepted = proposals.filter((item) => item.status === 'accepted');
    const executed = proposals.filter((item) =>
      ['executed', 'confirmed'].includes(item.status),
    );
    const history = proposals.filter((item) =>
      ['rejected', 'expired'].includes(item.status),
    );
    return {
      generated_for: today,
      proposals,
      pending,
      accepted,
      executed,
      history,
      summary: {
        pending: pending.length,
        accepted: accepted.length,
        executed: executed.length,
        rejected: proposals.filter((item) => item.status === 'rejected').length,
        expired: proposals.filter((item) => item.status === 'expired').length,
      },
    };
  }

  return {
    sync,
    getWorkspace,
    getProposal,
    listProposals,
    adoptProposal,
    rejectProposal,
    detachDecision,
    matchTrade,
    reconcileExecutionStatuses,
  };
}

module.exports = {
  PROPOSAL_SCHEMA,
  createDecisionProposalStore,
};
