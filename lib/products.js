'use strict';

const fs = require('node:fs');
const { DAILY_OPEN_TARGET_PCT } = require('./r2-policy');

const TARGET_ANNUALIZED = 3.0;
const SELECTION_VERSION = 'r2-dynamic-v2';
const MIN_HISTORY_MONTHS = 12;
const PRIVATE_PRODUCT_PATTERN = /私行|私银|私享|尊享|企享|专属|私募/;
const DEFAULT_ALLOCATION_SETTINGS = Object.freeze({
  principal_override: null,
  liquidity_floor_pct: 30,
  daily_open_target_pct: DAILY_OPEN_TARGET_PCT,
  max_single_pct: 30,
  max_issuer_pct: 50,
  target_slice_pct: 10,
  cashflow_0_3: 0,
  cashflow_3_6: 0,
  cashflow_6_12: 0,
  bucket_targets: Object.freeze({ short: 30, medium: 35, long: 35 }),
  quota_by_code: Object.freeze({}),
});

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => value.trim() !== ''));
}

function numberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(String(value).replaceAll(',', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function loadProductsFromCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows
    .slice(1)
    .map((values) => {
      const raw = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
      return {
        name: (raw.name || '').trim(),
        code: (raw.code || '').trim(),
        short_name: (raw.short_name || '').trim(),
        issuer: (raw.issuer || '').trim(),
        risk_level: (raw.risk_level || '').trim(),
        currency_code: (raw.currency_code || '').trim(),
        pub_prv: (raw.pub_prv || '').trim(),
        soc_tag: (raw.soc_tag || '').trim(),
        product_type: (raw.product_type || '').trim(),
        term_days: numberOrNull(raw.term_days),
        score: numberOrNull(raw.score),
        min_amount: numberOrNull(raw.min_amount),
        annualized_yield: numberOrNull(raw.annualized_yield),
        benchmark: (raw.benchmark || '').trim(),
        return_1m: numberOrNull(raw.return_1m_annualized),
        return_3m: numberOrNull(raw.return_3m_annualized),
        return_6m: numberOrNull(raw.return_6m_annualized),
        return_1y: numberOrNull(raw.return_1y_annualized),
        return_since_inception: numberOrNull(raw.return_since_inception_annualized),
        status: (raw.status || '').trim(),
        source: (raw.source || '').trim(),
        data_date: (raw.data_date || '').trim(),
        notes: (raw.notes || '').trim(),
        capacity: numberOrNull(raw.capacity),
        history_months: numberOrNull(raw.history_months),
        fee_bps: numberOrNull(raw.fee_bps),
        next_open_date: (raw.next_open_date || '').trim(),
      };
    })
    .filter((product) => product.name && product.code);
}

function bucketForTerm(termDays) {
  if (termDays === null) return 'unknown';
  if (termDays <= 1) return 'cash';
  if (termDays <= 30) return 'short';
  if (termDays <= 100) return 'medium';
  return 'long';
}

function observationScore(product) {
  const m3 = product.return_3m ?? 0;
  const m6 = product.return_6m ?? 0;
  const y1 = product.return_1y ?? 0;
  let score = m3 * 0.45 + m6 * 0.3 + y1 * 0.25;

  // A sharp one-month divergence is a signal to re-check, not extra yield.
  if (product.return_1m !== null && product.return_1m < m3 - 0.5) {
    score -= 0.08;
  }
  return score;
}

function isObservationReady(product) {
  const risk = String(product.risk_level || '').toUpperCase();
  const name = `${product.name || ''} ${product.short_name || ''}`;
  const historyMonths = product.history_months;
  return (
    /^(?:PR|R)2$/.test(risk) &&
    (!product.currency_code || product.currency_code === '10') &&
    (!product.pub_prv || product.pub_prv === 'A') &&
    !PRIVATE_PRODUCT_PATTERN.test(name) &&
    !String(product.code || '').includes('/') &&
    product.capacity !== 0 &&
    Number.isFinite(product.term_days) &&
    product.term_days >= 0 &&
    (historyMonths === null || historyMonths >= MIN_HISTORY_MONTHS) &&
    /开放中/.test(product.status || '') &&
    !/募集|新发|未开放/.test(product.status || '') &&
    !/募集|新发/i.test(product.status || '') &&
    Number.isFinite(product.return_1m) &&
    Number.isFinite(product.return_1y) &&
    Number.isFinite(product.return_3m) &&
    Number.isFinite(product.return_6m)
  );
}

function selectionScore(product) {
  let score = observationScore(product);

  // A large gap between 1Y and 6M often means the 1Y figure is carried by an
  // older, non-repeatable period. Penalise it instead of chasing the headline.
  if (Number.isFinite(product.return_1y) && Number.isFinite(product.return_6m)) {
    const frontLoadGap = product.return_1y - product.return_6m;
    if (frontLoadGap > 1) {
      score -= Math.min(0.25, (frontLoadGap - 1) * 0.15);
    }
  }

  // Prefer products that have survived at least one full credit cycle leg.
  if (Number.isFinite(product.history_months)) {
    if (product.history_months >= 24) score += 0.03;
    else if (product.history_months >= 18) score += 0.015;
  }
  return score;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundMoney(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeQuota(value) {
  if (value === null || value === undefined || value === '') {
    return { available: null, max_order: null, window: '', verified_at: '' };
  }
  if (typeof value === 'number' || typeof value === 'string') {
    const available = Number(value);
    return {
      available: Number.isFinite(available) && available >= 0 ? available : null,
      max_order: null,
      window: '',
      verified_at: '',
    };
  }
  const available =
    value.available === null || value.available === undefined || value.available === ''
      ? null
      : Number(value.available);
  const maxOrder =
    value.max_order === null || value.max_order === undefined || value.max_order === ''
      ? null
      : Number(value.max_order);
  return {
    available: Number.isFinite(available) && available >= 0 ? available : null,
    max_order: Number.isFinite(maxOrder) && maxOrder > 0 ? maxOrder : null,
    window: String(value.window || '').trim(),
    verified_at: String(value.verified_at || '').trim(),
  };
}

function normalizeAllocationSettings(input = {}, decisions = []) {
  const source =
    input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const latestPlan =
    decisions
      .map((item) => item.bucket_plan)
      .find(
        (plan) =>
          plan &&
          typeof plan === 'object' &&
          ['short', 'medium', 'long'].some((key) => Number.isFinite(Number(plan[key]))),
      ) || {};
  const rawTargets =
    source.bucket_targets && typeof source.bucket_targets === 'object'
      ? source.bucket_targets
      : latestPlan;
  const targetValue = (key, fallback) =>
    clampNumber(rawTargets[key], 0, 100, fallback);
  const quotas =
    source.quota_by_code &&
    typeof source.quota_by_code === 'object' &&
    !Array.isArray(source.quota_by_code)
      ? source.quota_by_code
      : {};
  return {
    principal_override:
      source.principal_override === null ||
      source.principal_override === undefined ||
      source.principal_override === ''
        ? null
        : clampNumber(source.principal_override, 0, 1e12, null),
    liquidity_floor_pct: clampNumber(
      source.liquidity_floor_pct,
      0,
      100,
      DEFAULT_ALLOCATION_SETTINGS.liquidity_floor_pct,
    ),
    daily_open_target_pct: DAILY_OPEN_TARGET_PCT,
    max_single_pct: clampNumber(
      source.max_single_pct,
      5,
      30,
      DEFAULT_ALLOCATION_SETTINGS.max_single_pct,
    ),
    max_issuer_pct: clampNumber(
      source.max_issuer_pct,
      40,
      100,
      DEFAULT_ALLOCATION_SETTINGS.max_issuer_pct,
    ),
    target_slice_pct: clampNumber(
      source.target_slice_pct,
      5,
      25,
      DEFAULT_ALLOCATION_SETTINGS.target_slice_pct,
    ),
    cashflow_0_3: clampNumber(source.cashflow_0_3, 0, 1e12, 0),
    cashflow_3_6: clampNumber(source.cashflow_3_6, 0, 1e12, 0),
    cashflow_6_12: clampNumber(source.cashflow_6_12, 0, 1e12, 0),
    bucket_targets: {
      short: targetValue(
        'short',
        Number.isFinite(Number(latestPlan.short))
          ? Number(latestPlan.short)
          : DEFAULT_ALLOCATION_SETTINGS.bucket_targets.short,
      ),
      medium: targetValue(
        'medium',
        Number.isFinite(Number(latestPlan.medium))
          ? Number(latestPlan.medium)
          : DEFAULT_ALLOCATION_SETTINGS.bucket_targets.medium,
      ),
      long: targetValue(
        'long',
        Number.isFinite(Number(latestPlan.long))
          ? Number(latestPlan.long)
          : DEFAULT_ALLOCATION_SETTINGS.bucket_targets.long,
      ),
    },
    quota_by_code: Object.fromEntries(
      Object.entries(quotas).map(([code, quota]) => [code, normalizeQuota(quota)]),
    ),
  };
}

function productFamilyKey(product) {
  const benchmark = String(product.benchmark || '')
    .replace(/\s+/g, '')
    .trim();
  if (benchmark) return `${product.issuer || '未知发行方'}|${benchmark}`;
  return `${product.issuer || '未知发行方'}|${product.bucket || 'unknown'}`;
}

function buildExposure(item, productByCode) {
  const code = String(item.product_code || item.code || '').trim();
  const product = productByCode.get(code);
  const termDays =
    item.term_days === null || item.term_days === undefined
      ? product?.term_days ?? null
      : Number(item.term_days);
  return {
    code,
    name: String(item.product_name || item.name || product?.name || code),
    issuer: String(item.issuer || product?.issuer || '').trim(),
    amount: Math.max(0, Number(item.amount) || 0),
    term_days: Number.isFinite(termDays) ? termDays : null,
    bucket: bucketForTerm(Number.isFinite(termDays) ? termDays : null),
    source: item.source || 'holding',
  };
}

function sumBy(items, key, amountKey = 'amount') {
  const result = new Map();
  for (const item of items) {
    const value = item[key] || '';
    result.set(value, (result.get(value) || 0) + Number(item[amountKey] || 0));
  }
  return result;
}

function topObservationList(candidates, limitPerBucket = 3) {
  const result = [];
  for (const bucket of ['short', 'medium', 'long']) {
    const peers = candidates
      .filter((product) => product.bucket === bucket)
      .sort(
        (a, b) =>
          b.selection_score - a.selection_score ||
          b.return_3m - a.return_3m ||
          b.return_6m - a.return_6m ||
          a.code.localeCompare(b.code),
      )
      .slice(0, limitPerBucket);
    result.push(...peers);
  }
  return result;
}

function buildAllocation(candidates, options = {}) {
  const decisions = Array.isArray(options.decisions) ? options.decisions : [];
  const settings = normalizeAllocationSettings(options.settings || {}, decisions);
  const productByCode = new Map(candidates.map((product) => [product.code, product]));
  const holdings = (Array.isArray(options.holdings) ? options.holdings : [])
    .map((item) => buildExposure({ ...item, source: 'holding' }, productByCode))
    .filter((item) => item.amount > 0);
  const pendingTrades = (Array.isArray(options.pending_trades) ? options.pending_trades : [])
    .filter(
      (item) =>
        item.status === 'pending' &&
        (item.trade_type === 'buy' || item.trade_type === 'switch'),
    )
    .map((item) => buildExposure({ ...item, source: 'pending' }, productByCode))
    .filter((item) => item.amount > 0);
  const exposures = [...holdings, ...pendingTrades];
  const principal = clampNumber(
    options.principal ?? settings.principal_override,
    0,
    1e12,
    0,
  );
  const committed = exposures.reduce((sum, item) => sum + item.amount, 0);
  const availableCash = roundMoney(Math.max(0, principal - committed));
  const overcommitted = committed > principal + 0.01;
  const byBucket = sumBy(exposures, 'bucket');
  const byProduct = sumBy(exposures, 'code');
  const byIssuer = sumBy(exposures, 'issuer');
  const uniqueIssuers = new Set(candidates.map((product) => product.issuer).filter(Boolean));
  const effectiveIssuerCapPct =
    uniqueIssuers.size <= 1
      ? 100
      : Math.min(50, Math.max(40, settings.max_issuer_pct));
  const familyKeys = new Set(candidates.map(productFamilyKey));
  const effectiveFamilyCapPct = familyKeys.size <= 1 ? 100 : 50;
  const familyExposure = new Map();
  for (const item of exposures) {
    const product = productByCode.get(item.code);
    const family = product
      ? productFamilyKey(product)
      : `${item.issuer || '未知发行方'}|${item.bucket}`;
    familyExposure.set(family, (familyExposure.get(family) || 0) + item.amount);
  }
  const targetAmount = (key) =>
    roundMoney(principal * (settings.bucket_targets[key] / 100));
  const targets = {
    short: targetAmount('short'),
    medium: targetAmount('medium'),
    long: targetAmount('long'),
  };
  const existingAmount = {
    short: roundMoney(byBucket.get('short') || 0),
    medium: roundMoney(byBucket.get('medium') || 0),
    long: roundMoney(byBucket.get('long') || 0),
    cash: roundMoney(byBucket.get('cash') || 0),
  };
  const liquidityTarget = roundMoney(
    Math.max(
      principal * (settings.liquidity_floor_pct / 100),
      settings.cashflow_0_3,
    ),
  );
  const dailyOpenTargetAmount = roundMoney(
    principal * (DAILY_OPEN_TARGET_PCT / 100),
  );
  const shortExposure = existingAmount.short;
  const liquidityDeficit = roundMoney(Math.max(0, liquidityTarget - shortExposure));
  const bucketOrder = ['short', 'medium', 'long'];
  const bucketBudgets = { short: 0, medium: 0, long: 0 };
  let remaining = availableCash;
  bucketBudgets.short = roundMoney(
    Math.min(
      remaining,
      Math.max(liquidityDeficit, Math.max(0, targets.short - existingAmount.short)),
    ),
  );
  remaining = roundMoney(remaining - bucketBudgets.short);
  bucketBudgets.medium = roundMoney(
    Math.min(remaining, Math.max(0, targets.medium - existingAmount.medium)),
  );
  remaining = roundMoney(remaining - bucketBudgets.medium);
  bucketBudgets.long = roundMoney(
    Math.min(remaining, Math.max(0, targets.long - existingAmount.long)),
  );

  const watchlist = [];
  const bucketRows = [];
  const allocationByCode = new Map();
  const reasons = [];
  let quotaUnverified = 0;
  const targetSliceAmount = Math.min(
    250000,
    Math.max(10000, principal * (settings.target_slice_pct / 100)),
  );

  function allocateBucket(bucket) {
    const budget = bucketBudgets[bucket];
    const peers = candidates
      .filter((product) => product.bucket === bucket)
      .sort(
        (a, b) =>
          b.selection_score - a.selection_score ||
          b.return_3m - a.return_3m ||
          b.return_6m - a.return_6m ||
          a.code.localeCompare(b.code),
      );
    let unallocated = budget;
    let quotaBlocked = 0;
    let capBlocked = 0;
    let minimumBlocked = 0;
    for (const product of peers) {
      if (unallocated < 0.01) break;
      const minAmount = Number.isFinite(product.min_amount)
        ? Math.max(0.01, product.min_amount)
        : 0.01;
      const productRoom = roundMoney(
        Math.max(
          0,
          principal * (settings.max_single_pct / 100) -
            (byProduct.get(product.code) || 0),
        ),
      );
      const issuerRoom = roundMoney(
        Math.max(
          0,
          principal * (effectiveIssuerCapPct / 100) -
            (byIssuer.get(product.issuer) || 0),
        ),
      );
      const family = productFamilyKey(product);
      const familyRoom = roundMoney(
        Math.max(
          0,
          principal * (effectiveFamilyCapPct / 100) -
            (familyExposure.get(family) || 0),
        ),
      );
      const quota =
        settings.quota_by_code[product.code] || normalizeQuota(product.capacity);
      const quotaRoom =
        quota.available === null ? Number.POSITIVE_INFINITY : quota.available;
      const orderRoom =
        quota.max_order === null ? Number.POSITIVE_INFINITY : quota.max_order;
      const room = Math.min(
        unallocated,
        targetSliceAmount,
        productRoom,
        issuerRoom,
        familyRoom,
        quotaRoom,
        orderRoom,
      );
      if (!Number.isFinite(room) || room < minAmount) {
        if (quota.available !== null && quota.available < minAmount) quotaBlocked += 1;
        else if (productRoom < minAmount || issuerRoom < minAmount || familyRoom < minAmount) {
          capBlocked += 1;
        } else {
          minimumBlocked += 1;
        }
        continue;
      }
      const amount = roundMoney(room);
      if (amount < minAmount) {
        minimumBlocked += 1;
        continue;
      }
      product.selected = true;
      product.selection_rank = watchlist.length + 1;
      product.target_amount = amount;
      product.target_pct = principal > 0 ? Number(((amount / principal) * 100).toFixed(4)) : 0;
      product.allocation_bucket = bucket;
      product.existing_exposure = roundMoney(byProduct.get(product.code) || 0);
      product.issuer_exposure = roundMoney(byIssuer.get(product.issuer) || 0);
      product.quota_status =
        quota.available === null ? 'unverified' : quota.available < amount + 0.01 ? 'limited' : 'verified';
      product.quota_available = quota.available;
      product.quota_max_order = quota.max_order;
      product.quota_window = quota.window;
      product.quota_verified_at = quota.verified_at;
      product.allocation_reason = [
        `${bucket === 'short' ? '短期' : bucket === 'medium' ? '中期' : '长期'}桶待配 ¥${budget.toFixed(2)}`,
        `目标单只约 ¥${targetSliceAmount.toFixed(2)}`,
        `单只上限 ¥${(principal * (settings.max_single_pct / 100)).toFixed(2)}`,
        `单发行方上限 ${effectiveIssuerCapPct}%`,
        quota.available === null
          ? '额度未核验，买入前需在招行 App 确认'
          : `可用额度 ¥${quota.available.toFixed(2)}`,
        quota.max_order ? `单笔上限 ¥${quota.max_order.toFixed(2)}` : '',
        quota.window ? `额度窗口 ${quota.window}` : '',
      ]
        .filter(Boolean)
        .join('；');
      if (quota.available === null) quotaUnverified += 1;
      watchlist.push(product);
      allocationByCode.set(product.code, amount);
      byProduct.set(product.code, (byProduct.get(product.code) || 0) + amount);
      byIssuer.set(product.issuer, (byIssuer.get(product.issuer) || 0) + amount);
      familyExposure.set(family, (familyExposure.get(family) || 0) + amount);
      unallocated = roundMoney(unallocated - amount);
    }
    const rowReasons = [];
    if (budget > 0 && unallocated > 0.01) {
      if (quotaBlocked) rowReasons.push(`${quotaBlocked} 只产品额度不足或为 0`);
      if (capBlocked) rowReasons.push(`${capBlocked} 只触发单只/发行方/策略上限`);
      if (minimumBlocked) rowReasons.push(`${minimumBlocked} 只低于起购金额或剩余额度过小`);
      if (!rowReasons.length) rowReasons.push('没有满足条件的可买产品');
    }
    if (budget <= 0.01) {
      rowReasons.push(
        existingAmount[bucket] >= targets[bucket]
          ? '当前金额已达到目标'
          : '没有可分配的新增资金',
      );
    }
    return {
      key: bucket,
      label: bucket === 'short' ? '短期 7–30 天' : bucket === 'medium' ? '中期 31–100 天' : '长期 100 天以上',
      target_amount: targets[bucket],
      target_pct: settings.bucket_targets[bucket],
      existing_amount: existingAmount[bucket],
      budget_amount: budget,
      new_amount: roundMoney(budget - unallocated),
      unallocated_amount: roundMoney(unallocated),
      final_amount: roundMoney(existingAmount[bucket] + budget - unallocated),
      final_pct:
        principal > 0
          ? Number((((existingAmount[bucket] + budget - unallocated) / principal) * 100).toFixed(2))
          : 0,
      status:
        budget <= 0.01
          ? 'no_budget'
          : unallocated <= 0.01
            ? 'filled'
            : 'partial',
      reasons: rowReasons,
    };
  }

  for (const bucket of bucketOrder) bucketRows.push(allocateBucket(bucket));
  const allocated = roundMoney(
    bucketRows.reduce((sum, row) => sum + row.new_amount, 0),
  );
  const unallocated = roundMoney(Math.max(0, availableCash - allocated));
  if (availableCash <= 0.01) {
    reasons.push(
      overcommitted
        ? '已确认持仓与待确认买入超过当前本金，先核对本金或交易金额。'
        : '当前本金已被持仓和待确认买入占用，没有新增可分配资金。',
    );
  }
  if (quotaUnverified > 0) {
    reasons.push(`${quotaUnverified} 只产品额度未核验；目标金额只是分配上限，买入前需在招行 App 确认。`);
  }
  if (existingAmount.cash > 0.01) {
    reasons.push(
      `现有日开持仓 ¥${existingAmount.cash.toFixed(2)} 保留为真实持仓；本项目新增日开额度固定 ${DAILY_OPEN_TARGET_PCT}%，后续按到期、赎回空档与同期限候选迁入短/中/长期桶。`,
    );
  }
  if (unallocated > 0.01 && availableCash > 0.01) {
    reasons.push(`仍有 ¥${unallocated.toFixed(2)} 未分配，主要受期限桶目标、起购金额、额度或集中度限制。`);
  }
  if (principal <= 0) reasons.push('尚未初始化本金，无法生成目标金额。');
  if (targets.short + targets.medium + targets.long > principal + 0.01) {
    reasons.push('期限桶目标合计超过本金，按流动性优先顺序分配。');
  }
  const status =
    principal <= 0
      ? 'no_principal'
      : availableCash <= 0.01
        ? 'no_cash'
        : allocated <= 0.01
          ? 'no_allocation'
          : quotaUnverified > 0
            ? 'quota_unverified'
            : unallocated > 0.01
              ? 'partial'
              : 'ready';

  const finalExposures = [
    ...exposures,
    ...watchlist.map((product) => ({
      code: product.code,
      name: product.name,
      issuer: product.issuer,
      amount: allocationByCode.get(product.code) || 0,
      term_days: product.term_days,
      bucket: product.bucket,
      source: 'new',
    })),
  ];
  const coverageFor = (days) =>
    roundMoney(
      finalExposures
        .filter((item) => Number.isFinite(item.term_days) && item.term_days <= days)
        .reduce((sum, item) => sum + item.amount, 0),
    );
  const required03 = roundMoney(settings.cashflow_0_3);
  const required06 = roundMoney(settings.cashflow_0_3 + settings.cashflow_3_6);
  const required12 = roundMoney(
    settings.cashflow_0_3 + settings.cashflow_3_6 + settings.cashflow_6_12,
  );
  const cashflow = [
    {
      key: '0-3',
      label: '未来 0–3 个月',
      required_amount: required03,
      covered_amount: coverageFor(90),
      status: coverageFor(90) + 0.01 >= required03 ? 'covered' : 'shortfall',
    },
    {
      key: '3-6',
      label: '未来 0–6 个月',
      required_amount: required06,
      covered_amount: coverageFor(180),
      status: coverageFor(180) + 0.01 >= required06 ? 'covered' : 'shortfall',
    },
    {
      key: '6-12',
      label: '未来 0–12 个月',
      required_amount: required12,
      covered_amount: coverageFor(365),
      status: coverageFor(365) + 0.01 >= required12 ? 'covered' : 'shortfall',
    },
  ];
  const cashflowShortfall = cashflow.some((item) => item.status === 'shortfall');
  if (cashflowShortfall) reasons.push('未来现金流覆盖不足，优先补短期 7–30 天桶；不新增日开仓位。');
  const finalLiquid = roundMoney(shortExposure + (bucketRows[0]?.new_amount || 0));
  const liquidityShortfall = roundMoney(Math.max(0, liquidityTarget - finalLiquid));

  return {
    version: SELECTION_VERSION,
    status,
    principal: roundMoney(principal),
    committed_amount: roundMoney(committed),
    available_cash: availableCash,
    allocated_amount: allocated,
    unallocated_amount: unallocated,
    overcommitted,
    liquidity: {
      floor_pct: settings.liquidity_floor_pct,
      target_amount: liquidityTarget,
      existing_amount: roundMoney(shortExposure),
      final_amount: finalLiquid,
      shortfall_amount: liquidityShortfall,
      status: finalLiquid + 0.01 >= liquidityTarget ? 'covered' : 'shortfall',
    },
    daily_open: {
      target_pct: DAILY_OPEN_TARGET_PCT,
      target_amount: dailyOpenTargetAmount,
      existing_amount: existingAmount.cash,
      migration_required: existingAmount.cash > 0.01,
      status: existingAmount.cash > 0.01 ? 'migration_required' : 'zero',
      note:
        existingAmount.cash > 0.01
          ? '现有日开持仓只作为真实持仓保留，不再作为常规流动性仓；迁移前核对赎回规则、到账空档和同期限候选。'
          : '新增日开额度固定为 0%，短桶承担流动性。',
    },
    cashflow,
    pending: {
      count: pendingTrades.length,
      amount: roundMoney(pendingTrades.reduce((sum, item) => sum + item.amount, 0)),
      items: pendingTrades,
    },
    holdings: {
      count: holdings.length,
      amount: roundMoney(holdings.reduce((sum, item) => sum + item.amount, 0)),
    },
    settings,
    effective_issuer_cap_pct: effectiveIssuerCapPct,
    buckets: bucketRows,
    reasons,
    quota_unverified_count: quotaUnverified,
  };
}

function buildProductView(products, options = {}) {
  const decorated = products
    .map((product) => ({
      ...product,
      bucket: bucketForTerm(product.term_days),
      observation_score: Number(observationScore(product).toFixed(4)),
      selection_score: Number(selectionScore(product).toFixed(4)),
      observation_ready: isObservationReady(product),
      selected: false,
      selection_rank: null,
      target_amount: 0,
      target_pct: 0,
      allocation_bucket: null,
      existing_exposure: 0,
      issuer_exposure: 0,
      quota_status: null,
      quota_available: null,
      quota_max_order: null,
      quota_window: '',
      quota_verified_at: '',
      allocation_reason: '',
      target_gap_pct:
        product.return_1y === null ? null : Number((product.return_1y - TARGET_ANNUALIZED).toFixed(4)),
    }))
    .filter((product) => product.observation_ready)
    .sort((a, b) => {
      const termA = a.term_days ?? 9999;
      const termB = b.term_days ?? 9999;
      return termA - termB || a.name.localeCompare(b.name, 'zh-CN');
    });

  const candidates = decorated;
  const allocation = buildAllocation(candidates, options);
  const watchlist = candidates
    .filter((product) => product.selected)
    .sort((a, b) => a.selection_rank - b.selection_rank);
  const observationList = topObservationList(candidates, 3);
  const metricProducts = watchlist.length ? watchlist : observationList;
  const metricValues = (key) =>
    metricProducts.map((product) => product[key]).filter((value) => Number.isFinite(value));
  const universeValues = (key) =>
    candidates.map((product) => product[key]).filter((value) => Number.isFinite(value));
  const median1y = median(metricValues('return_1y'));
  const median3m = median(metricValues('return_3m'));
  const median6m = median(metricValues('return_6m'));
  const universeMedian1y = median(universeValues('return_1y'));
  const universeMedian3m = median(universeValues('return_3m'));
  const universeMedian6m = median(universeValues('return_6m'));
  const bucketCounts = decorated.reduce((counts, product) => {
    if (product.bucket in counts) counts[product.bucket] += 1;
    return counts;
  }, { cash: 0, short: 0, medium: 0, long: 0 });

  return {
    all: decorated,
    watchlist,
    observation_list: observationList,
    allocation,
    selection: {
      version: SELECTION_VERSION,
      per_bucket: null,
      max_per_issuer: allocation.effective_issuer_cap_pct,
      max_single_pct: allocation.settings.max_single_pct,
      min_history_months: MIN_HISTORY_MONTHS,
      selected_count: watchlist.length,
      rules: [
        '仅保留人民币、公募、R2/PR2、开放中的普通可买产品',
        '剔除私行/私银/私享/尊享/企享/专属/私募产品',
        '要求 1M/3M/6M/1Y 完整且成立满 12 个月',
        '按本金、持仓、待确认买入、期限桶目标、流动性和未来现金流动态决定产品数量与金额',
        '本项目新增日开额度固定为 0%；现有日开持仓只保留事实并提示迁移',
        '单只不超过 30%，多发行方时单发行方不超过 40%–50%，同一底层策略不超过 50%',
        '额度缺失时不假装可买，目标金额标记为额度未核验',
        '待确认买入不计入已确认持仓，但占用单只、发行方和流动性上限',
      ],
    },
    stats: {
      total: decorated.length,
      observation_ready: candidates.length,
      selected_count: watchlist.length,
      observation_count: observationList.length,
      median_1y: median1y === null ? null : Number(median1y.toFixed(4)),
      median_3m: median3m === null ? null : Number(median3m.toFixed(4)),
      median_6m: median6m === null ? null : Number(median6m.toFixed(4)),
      universe_median_1y:
        universeMedian1y === null ? null : Number(universeMedian1y.toFixed(4)),
      universe_median_3m:
        universeMedian3m === null ? null : Number(universeMedian3m.toFixed(4)),
      universe_median_6m:
        universeMedian6m === null ? null : Number(universeMedian6m.toFixed(4)),
      bucket_counts: bucketCounts,
      target_annualized: TARGET_ANNUALIZED,
      target_gap_pct:
        median1y === null ? null : Number((median1y - TARGET_ANNUALIZED).toFixed(4)),
      target_coverage_pct:
        median1y === null ? null : Number(((median1y / TARGET_ANNUALIZED) * 100).toFixed(1)),
    },
  };
}

module.exports = {
  DEFAULT_ALLOCATION_SETTINGS,
  bucketForTerm,
  buildAllocation,
  buildProductView,
  isObservationReady,
  loadProductsFromCsv,
  normalizeAllocationSettings,
  observationScore,
  parseCsv,
  selectionScore,
  SELECTION_VERSION,
};
