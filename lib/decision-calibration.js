'use strict';

const crypto = require('node:crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const PREDICTION_SCHEMA_VERSION = 1;
const TERMINAL_RESULT_STATUSES = new Set([
  'hit',
  'miss',
  'invalidated',
  'not_executed',
]);

function parseYmd(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) ? stamp : null;
}

function daysBetween(from, to) {
  const start = parseYmd(from);
  const end = parseYmd(to);
  if (start === null || end === null) return null;
  return Math.round((end - start) / DAY_MS);
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value))
    .digest('hex')
    .slice(0, 20);
}

function confidenceBucket(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return 'unknown';
  if (confidence < 50) return 'low';
  if (confidence < 75) return 'medium';
  return 'high';
}

function normalizeTarget(input = {}) {
  const value = input.target || input.expected?.target || {};
  const point = Number(value.point);
  const min = Number(value.min);
  const max = Number(value.max);
  return {
    point: Number.isFinite(point) ? round(point, 4) : null,
    min: Number.isFinite(min) ? round(min, 4) : null,
    max: Number.isFinite(max) ? round(max, 4) : null,
    unit: String(value.unit || input.unit || '%').trim(),
  };
}

function buildPrediction(input = {}) {
  const sourceRef = String(input.source_ref || '').trim();
  const recommendationType = String(
    input.recommendation_type || '',
  ).trim();
  const action = String(input.action || '').trim();
  const createdAt = String(input.created_at || '').trim();
  const reviewDate = String(input.review_date || '').trim();
  const startDate = String(
    input.start_date || createdAt.slice(0, 10),
  ).trim();
  const target = normalizeTarget(input);
  if (
    !sourceRef ||
    !recommendationType ||
    !action ||
    !createdAt ||
    !parseYmd(startDate) ||
    !parseYmd(reviewDate) ||
    reviewDate < startDate ||
    (target.point === null && target.min === null && target.max === null)
  ) {
    return null;
  }
  const version = Math.max(1, Number(input.version) || 1);
  const seriesId =
    String(input.series_id || '').trim() ||
    `pred_${stableHash(`${sourceRef}|${recommendationType}|${action}`)}`;
  const id =
    String(input.id || '').trim() || `${seriesId}:v${version}`;
  const baseline = input.baseline || {};
  const expected = input.expected || {};
  const evaluation = input.evaluation || {};
  const horizonDays = daysBetween(startDate, reviewDate);
  return {
    schema_version: PREDICTION_SCHEMA_VERSION,
    series_id: seriesId,
    id,
    version,
    recommendation_type: recommendationType,
    action,
    source: String(input.source || 'platform'),
    source_ref: sourceRef,
    created_at: createdAt,
    data_cutoff_at: String(input.data_cutoff_at || createdAt),
    evidence_refs: Array.isArray(input.evidence_refs)
      ? input.evidence_refs
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({ ...item }))
      : [],
    confidence: Math.max(
      0,
      Math.min(100, Number(input.confidence) || 0),
    ),
    horizon: {
      start_date: startDate,
      end_date: reviewDate,
      days: horizonDays,
    },
    baseline: {
      metric: String(baseline.metric || input.metric || ''),
      value: Number.isFinite(Number(baseline.value))
        ? round(Number(baseline.value), 4)
        : null,
      label: String(baseline.label || ''),
      unit: String(baseline.unit || input.unit || '%'),
    },
    expected: {
      direction: String(expected.direction || 'at_least'),
      target,
    },
    evaluation: {
      metric: String(evaluation.metric || input.metric || ''),
      method: String(
        evaluation.method || 'confirmed_trade_personal_annualized',
      ),
      minimum_observations: Math.max(
        1,
        Number(evaluation.minimum_observations) || 3,
      ),
      minimum_coverage_ratio: Math.max(
        0,
        Math.min(1, Number(evaluation.minimum_coverage_ratio) || 0.5),
      ),
      tolerance_pp: Math.max(
        0,
        Number(evaluation.tolerance_pp) || 0.15,
      ),
      tolerance_abs: Math.max(
        0,
        Number(evaluation.tolerance_abs) || 0,
      ),
    },
    invalidation_condition: String(
      input.invalidation_condition || '',
    ),
    invalidation_triggers: Array.isArray(input.invalidation_triggers)
      ? input.invalidation_triggers.map(String)
      : [],
    review_date: reviewDate,
    original_text: String(input.original_text || ''),
  };
}

function appendPredictionVersion(existingPredictions, input = {}) {
  const predictions = Array.isArray(existingPredictions)
    ? existingPredictions
    : [];
  const latest = [...predictions].sort(
    (a, b) => Number(b.version || 0) - Number(a.version || 0),
  )[0];
  const version = latest ? Number(latest.version || 0) + 1 : 1;
  return buildPrediction({
    ...input,
    series_id: latest?.series_id || input.series_id,
    version,
  });
}

function latestPrediction(predictions) {
  return (
    (Array.isArray(predictions) ? predictions : [])
      .slice()
      .sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0] ||
    null
  );
}

function predictionFailure(status, reasonCode, detail = '') {
  return {
    status,
    classification: reasonCode,
    reason_code: reasonCode,
    detail,
    evaluated_for: '',
    data_as_of: '',
    actual: null,
    target: null,
    numeric_error: null,
    evidence: {},
  };
}

function annualizedFromValuations({
  prediction,
  trades,
  valuations,
  today,
}) {
  const reviewDate =
    prediction.review_date < today ? prediction.review_date : today;
  const confirmedBuys = trades.filter(
    (trade) =>
      trade.status === 'confirmed' &&
      ['buy', 'switch'].includes(trade.trade_type),
  );
  if (!confirmedBuys.length) {
    return { error: 'no_confirmed_trade' };
  }
  const startDates = confirmedBuys
    .map((trade) => trade.confirm_date || trade.trade_date)
    .filter(Boolean)
    .sort();
  const startDate = startDates[0] > prediction.horizon.start_date
    ? startDates[0]
    : prediction.horizon.start_date;
  const codes = new Set(
    confirmedBuys.map((trade) =>
      String(
        trade.trade_type === 'switch'
          ? trade.target_product_code || trade.product_code
          : trade.product_code,
      ).toUpperCase(),
    ),
  );
  const tradeAmount = confirmedBuys.reduce(
    (sum, trade) => sum + Number(trade.settlement_amount ?? trade.amount ?? 0),
    0,
  );
  const rows = valuations
    .filter(
      (row) =>
        codes.has(String(row.product_code || '').toUpperCase()) &&
        row.yield_date >= startDate &&
        row.yield_date <= reviewDate,
    )
    .sort((a, b) => a.yield_date.localeCompare(b.yield_date));
  if (!rows.length) {
    return {
      error: 'no_product_valuations',
      evidence: {
        start_date: startDate,
        review_date: reviewDate,
        product_codes: [...codes],
      },
    };
  }
  const byDate = new Map();
  for (const row of rows) {
    const day = byDate.get(row.yield_date) || {
      pnl: 0,
      amount: 0,
      valuation_ids: [],
      credit_delays: [],
    };
    day.pnl += Number(row.daily_pnl) || 0;
    const amount = Number(row.holding_amount);
    if (Number.isFinite(amount) && amount > 0) {
      day.amount += amount;
    }
    const creditDelay = daysBetween(
      row.yield_date,
      row.credit_date || row.yield_date,
    );
    if (creditDelay !== null) day.credit_delays.push(creditDelay);
    day.valuation_ids.push(row.id);
    byDate.set(row.yield_date, day);
  }
  const orderedDays = [...byDate.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  let nav = 1;
  const usableDays = [];
  for (const [date, day] of orderedDays) {
    const amount = day.amount || tradeAmount;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const dailyRate = day.pnl / amount;
    if (!Number.isFinite(dailyRate) || dailyRate <= -1) continue;
    nav *= 1 + dailyRate;
    usableDays.push({
      yield_date: date,
      credit_delay_days: day.credit_delays.length
        ? round(
            day.credit_delays.reduce((sum, value) => sum + value, 0) /
              day.credit_delays.length,
            2,
          )
        : null,
      daily_rate: round(dailyRate, 8),
      pnl: round(day.pnl, 2),
      amount: round(amount, 2),
      valuation_ids: day.valuation_ids,
    });
  }
  const observedDays = usableDays.length;
  if (!observedDays) {
    return {
      error: 'insufficient_product_data',
      evidence: {
        start_date: startDate,
        review_date: reviewDate,
        observed_days: 0,
        product_codes: [...codes],
      },
    };
  }
  const elapsedCalendarDays = Math.max(
    1,
    (parseYmd(usableDays.at(-1)?.yield_date) -
      parseYmd(usableDays[0]?.yield_date || startDate)) /
      DAY_MS +
      1,
  );
  const coverageRatio = elapsedCalendarDays
    ? observedDays / elapsedCalendarDays
    : 0;
  if (
    observedDays < prediction.evaluation.minimum_observations ||
    coverageRatio < prediction.evaluation.minimum_coverage_ratio
  ) {
    return {
      error: 'insufficient_product_data',
      evidence: {
        start_date: startDate,
        review_date: reviewDate,
        observed_days: observedDays,
        elapsed_calendar_days: elapsedCalendarDays,
        coverage_ratio: round(coverageRatio, 4),
        product_codes: [...codes],
        usable_days: usableDays,
      },
    };
  }
  const annualized =
    (nav ** (365 / Math.max(1, elapsedCalendarDays)) - 1) * 100;
  return {
    actual: round(annualized, 4),
    evidence: {
      start_date: startDate,
      review_date: reviewDate,
      observed_days: observedDays,
      elapsed_calendar_days: elapsedCalendarDays,
      coverage_ratio: round(coverageRatio, 4),
      product_codes: [...codes],
      trade_ids: confirmedBuys.map((trade) => trade.id),
      execution_wait_days: confirmedBuys.map((trade) => ({
        trade_id: trade.id,
        days:
          parseYmd(trade.confirm_date || trade.trade_date) -
          parseYmd(trade.trade_date) >= 0
            ? Math.round(
                (parseYmd(trade.confirm_date || trade.trade_date) -
                  parseYmd(trade.trade_date)) /
                  DAY_MS,
              )
            : null,
      })),
      max_credit_delay_days: usableDays.reduce(
        (max, item) =>
          item.credit_delay_days === null
            ? max
            : Math.max(max, item.credit_delay_days),
        0,
      ),
      usable_days: usableDays,
      assumptions: prediction.evidence_refs,
    },
  };
}

function targetHit(prediction, actual) {
  const expected = prediction.expected || {};
  const target = expected.target || {};
  const tolerance = Number(prediction.evaluation.tolerance_pp) || 0;
  if (expected.direction === 'within') {
    return (
      target.min !== null &&
      target.max !== null &&
      actual >= target.min - tolerance &&
      actual <= target.max + tolerance
    );
  }
  if (expected.direction === 'outside') {
    return (
      target.min !== null &&
      target.max !== null &&
      (actual < target.min - tolerance || actual > target.max + tolerance)
    );
  }
  if (expected.direction === 'at_most') {
    return target.point !== null && actual <= target.point + tolerance;
  }
  if (expected.direction === 'up') {
    const baseline = Number(prediction.baseline.value);
    return Number.isFinite(baseline) && actual > baseline;
  }
  return target.point !== null && actual >= target.point - tolerance;
}

function evaluatePrediction({
  prediction,
  decision,
  trades = [],
  valuations = [],
  today,
}) {
  if (!prediction) return predictionFailure('pending', 'pending');
  if (today < prediction.review_date) {
    return {
      ...predictionFailure('pending', 'pending', '尚未到复核日期'),
      evaluated_for: today,
      data_as_of: today,
      target: prediction.expected?.target || null,
    };
  }
  const lifecycle = String(decision?.review_meta?.lifecycle_status || '');
  const invalidationTriggers = new Set(
    prediction.invalidation_triggers || [],
  );
  if (
    ['cancelled', 'rejected'].includes(lifecycle) &&
    (invalidationTriggers.size === 0 ||
      invalidationTriggers.has('decision_cancelled'))
  ) {
    return {
      ...predictionFailure(
        'invalidated',
        'invalidated',
        '决策已取消或拒绝',
      ),
      evaluated_for: today,
      data_as_of: today,
      target: prediction.expected?.target || null,
      evidence: {
        lifecycle_status: lifecycle,
      },
    };
  }
  const linked = trades.filter(
    (trade) =>
      Number(trade.decision_id) === Number(decision?.id) &&
      trade.status !== 'cancelled',
  );
  const pending = linked.filter((trade) => trade.status === 'pending');
  if (pending.length) {
    return {
      ...predictionFailure(
        'insufficient_data',
        'insufficient_data',
        '交易尚未确认',
      ),
      evaluated_for: today,
      data_as_of: today,
      target: prediction.expected?.target || null,
      evidence: { pending_trade_ids: pending.map((trade) => trade.id) },
    };
  }
  if (!linked.length) {
    return {
      ...predictionFailure(
        'not_executed',
        'not_executed',
        '复核日前没有对应交易',
      ),
      evaluated_for: today,
      data_as_of: today,
      target: prediction.expected?.target || null,
    };
  }
  if (prediction.evaluation.metric === 'executed_amount') {
    const confirmed = linked.filter(
      (trade) =>
        trade.status === 'confirmed' &&
        ['buy', 'switch'].includes(trade.trade_type),
    );
    if (!confirmed.length) {
      return {
        ...predictionFailure(
          'insufficient_data',
          'insufficient_data',
          '没有已确认的目标交易',
        ),
        evaluated_for: today,
        data_as_of: today,
        target: prediction.expected?.target || null,
        evidence: {
          pending_trade_ids: linked
            .filter((trade) => trade.status === 'pending')
            .map((trade) => trade.id),
        },
      };
    }
    const actual = round(
      confirmed.reduce(
        (sum, trade) =>
          sum + Number(trade.settlement_amount ?? trade.amount ?? 0),
        0,
      ),
      2,
    );
    const targetPoint = Number(prediction.expected?.target?.point);
    const tolerance = Number(prediction.evaluation.tolerance_abs) || 0;
    const hit =
      Number.isFinite(targetPoint) &&
      Math.abs(actual - targetPoint) <= tolerance;
    return {
      status: hit ? 'hit' : 'miss',
      classification: hit ? 'direction_hit' : 'direction_error',
      reason_code: hit ? 'target_met' : 'target_missed',
      detail: hit
        ? '实际执行金额在预测容差内'
        : '实际执行金额偏离预测',
      evaluated_for: today,
      data_as_of: today,
      actual,
      target: prediction.expected?.target || null,
      numeric_error:
        Number.isFinite(targetPoint)
          ? round(actual - targetPoint, 2)
          : null,
      evidence: {
        trade_ids: confirmed.map((trade) => trade.id),
      },
    };
  }
  const calculated = annualizedFromValuations({
    prediction,
    trades: linked,
    valuations,
    today,
  });
  if (calculated.error) {
    return {
      ...predictionFailure(
        'insufficient_data',
        calculated.error === 'no_product_valuations'
          ? 'evidence_gap'
          : 'insufficient_data',
        calculated.error === 'no_product_valuations'
          ? '缺少可用产品收益事实'
          : calculated.error === 'no_confirmed_trade'
            ? '缺少已确认交易'
            : '产品收益样本不足',
      ),
      evaluated_for: today,
      data_as_of: today,
      target: prediction.expected?.target || null,
      evidence: calculated.evidence || {},
    };
  }
  const actual = calculated.actual;
  const hit = targetHit(prediction, actual);
  const targetPoint =
    prediction.expected?.target?.point ??
    prediction.expected?.target?.min ??
    null;
  return {
    status: hit ? 'hit' : 'miss',
    classification:
      prediction.expected?.direction === 'within' ||
      prediction.expected?.direction === 'outside'
        ? hit
          ? 'range_hit'
          : 'numeric_error'
        : hit
          ? 'direction_hit'
          : 'direction_error',
    reason_code: hit ? 'target_met' : 'target_missed',
    detail: hit
      ? '实际结果达到预测条件'
      : '实际结果未达到预测条件',
    evaluated_for: today,
    data_as_of: calculated.evidence?.review_date || today,
    actual,
    target: prediction.expected?.target || null,
    numeric_error:
      targetPoint === null ? null : round(actual - targetPoint, 4),
    evidence: {
      ...(calculated.evidence || {}),
      assumptions: prediction.evidence_refs,
    },
  };
}

function resultFromProposal(proposal) {
  if (!proposal?.payload?.prediction) return null;
  const status = String(proposal.status || '');
  if (['rejected', 'expired'].includes(status)) {
    return {
      ...predictionFailure(
        'not_executed',
        'not_executed',
        status === 'rejected' ? '用户拒绝提案' : '提案过期未采纳',
      ),
      evaluated_for: proposal.updated_at?.slice(0, 10) || '',
      data_as_of: proposal.updated_at?.slice(0, 10) || '',
      target: proposal.payload.prediction.expected?.target || null,
      evidence: { proposal_status: status },
    };
  }
  return null;
}

function summarizeCalibration(records) {
  const byType = new Map();
  const byBucket = new Map();
  const byAction = new Map();
  const byHorizon = new Map();
  const errorSources = new Map();
  const reasonCodes = new Map();
  const horizonBucket = (days) => {
    const value = Number(days) || 0;
    if (value <= 30) return '≤30天';
    if (value <= 90) return '31–90天';
    if (value <= 180) return '91–180天';
    return '>180天';
  };
  const errorCategory = (status, reason) => {
    if (status === 'hit') return '预测命中';
    if (status === 'miss') return '预测误差';
    if (status === 'invalidated') return '失效条件触发';
    if (status === 'not_executed') return '执行偏差';
    if (status === 'insufficient_data') {
      return reason === 'evidence_gap' ? '证据缺失' : '数据时滞或不足';
    }
    return '尚未到期';
  };
  for (const record of records) {
    const type = record.prediction.recommendation_type || 'unknown';
    const bucket = confidenceBucket(record.prediction.confidence);
    const action = record.prediction.action || 'unknown';
    const horizon = horizonBucket(record.prediction.horizon?.days);
    for (const [map, key] of [
      [byType, type],
      [byBucket, bucket],
      [byAction, action],
      [byHorizon, horizon],
    ]) {
      const row = map.get(key) || {
        key,
        total: 0,
        hit: 0,
        miss: 0,
        invalidated: 0,
        insufficient_data: 0,
        not_executed: 0,
        pending: 0,
        pending_confirmation: 0,
        numeric_errors: [],
      };
      row.total += 1;
      const status = record.result?.status || 'pending';
      if (row[status] !== undefined) row[status] += 1;
      if (
        ['hit', 'miss'].includes(status) &&
        Number.isFinite(Number(record.result?.numeric_error))
      ) {
        row.numeric_errors.push(Number(record.result.numeric_error));
      }
      map.set(key, row);
    }
    const source =
      record.result?.reason_code ||
      record.result?.status ||
      'pending';
    reasonCodes.set(source, (reasonCodes.get(source) || 0) + 1);
    const category = errorCategory(
      record.result?.status || 'pending',
      record.result?.reason_code,
    );
    errorSources.set(category, (errorSources.get(category) || 0) + 1);
  }
  const finish = (row) => {
    const evaluated = row.hit + row.miss;
    return {
      ...row,
      evaluated,
      hit_rate: evaluated ? round(row.hit / evaluated, 4) : null,
      mean_absolute_error: row.numeric_errors.length
        ? round(
            row.numeric_errors.reduce(
              (sum, value) => sum + Math.abs(value),
              0,
            ) / row.numeric_errors.length,
            4,
          )
        : null,
      numeric_errors: undefined,
    };
  };
  return {
    by_type: [...byType.values()].map(finish),
    by_confidence: [...byBucket.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(finish),
    by_action: [...byAction.values()]
      .sort((a, b) => a.key.localeCompare(b.key, 'zh-CN'))
      .map(finish),
    by_horizon: [...byHorizon.values()].map(finish),
    error_sources: [...errorSources.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count),
    reason_codes: [...reasonCodes.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count),
  };
}

function buildCalibrationReport({
  month,
  today,
  proposals = [],
  decisions = [],
  trades = [],
  valuations = [],
}) {
  const decisionByProposal = new Map(
    decisions
      .filter((decision) => decision.review_meta?.proposal_id)
      .map((decision) => [
        Number(decision.review_meta.proposal_id),
        decision,
      ]),
  );
  const records = [];
  const seenSeries = new Set();
  for (const decision of decisions) {
    const prediction = latestPrediction(
      decision.review_meta?.predictions,
    );
    if (!prediction || prediction.review_date.slice(0, 7) !== month) continue;
    const stored =
      decision.review_meta?.prediction_results?.[prediction.id] || null;
    const result =
      stored ||
      evaluatePrediction({
        prediction,
        decision,
        trades,
        valuations,
        today,
      });
    seenSeries.add(prediction.series_id);
    records.push({
      prediction,
      prediction_versions: decision.review_meta.predictions,
      result,
      decision: {
        id: decision.id,
        product_name: decision.product_name,
        action: decision.action,
        rating: decision.rating,
      },
      proposal: null,
    });
  }
  for (const proposal of proposals) {
    const prediction = proposal.payload?.prediction;
    if (
      !prediction ||
      prediction.review_date.slice(0, 7) !== month ||
      seenSeries.has(prediction.series_id) ||
      decisionByProposal.has(Number(proposal.id))
    ) {
      continue;
    }
    records.push({
      prediction,
      prediction_versions: [prediction],
      result:
        resultFromProposal(proposal) ||
        {
          ...predictionFailure(
            'pending',
            proposal.status === 'pending'
              ? 'pending_decision'
              : 'insufficient_data',
            proposal.status === 'pending'
              ? '等待用户采纳'
              : '提案尚未形成正式决策',
          ),
          evaluated_for: today,
          data_as_of: today,
          target: prediction.expected?.target || null,
          evidence: { proposal_status: proposal.status },
        },
      decision: null,
      proposal: {
        id: proposal.id,
        status: proposal.status,
        title: proposal.title,
        confidence: proposal.confidence,
      },
    });
  }
  records.sort((a, b) => {
    const dateA = a.prediction.review_date || '';
    const dateB = b.prediction.review_date || '';
    return dateB.localeCompare(dateA) ||
      String(a.prediction.id).localeCompare(String(b.prediction.id));
  });
  return {
    month,
    generated_for: today,
    total: records.length,
    ...summarizeCalibration(records),
    records,
  };
}

module.exports = {
  PREDICTION_SCHEMA_VERSION,
  TERMINAL_RESULT_STATUSES,
  appendPredictionVersion,
  buildCalibrationReport,
  buildPrediction,
  confidenceBucket,
  evaluatePrediction,
  latestPrediction,
  parseYmd,
};
