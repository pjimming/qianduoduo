'use strict';

const {
  POLICY_VERSION,
  calculateYieldMetrics,
} = require('./yield-policy');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TARGET_ANNUALIZED = 3;
const DEFAULT_WINDOW_DAYS = 30;
const EPSILON = 0.005;

function round(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function asNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

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
  if (start === null || end === null) return 0;
  return Math.max(0, Math.round((end - start) / DAY_MS));
}

function shiftDate(date, days) {
  const stamp = parseYmd(date);
  if (stamp === null || !Number.isFinite(Number(days))) return null;
  return new Date(stamp + Number(days) * DAY_MS).toISOString().slice(0, 10);
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function productReferenceYield(product) {
  if (!product) {
    return {
      value_pct: null,
      status: 'unavailable',
      reason: 'no_product_snapshot',
      available_horizons: [],
      normalized_weights: {},
      policy_version: null,
    };
  }
  const hasExplicitReference = Object.prototype.hasOwnProperty.call(
    product,
    'reference_yield_pct',
  );
  const computed = hasExplicitReference
    ? null
    : calculateYieldMetrics(product);
  const value = asNumber(
    hasExplicitReference
      ? product.reference_yield_pct
      : computed?.reference_yield_pct,
    NaN,
  );
  const available = Number.isFinite(value);
  return {
    value_pct: available ? value : null,
    status:
      product.reference_yield_status ||
      computed?.reference_yield_status ||
      (available ? 'available' : 'unavailable'),
    reason:
      product.reference_yield_reason ??
      computed?.reference_yield_reason ??
      (available ? null : 'no_available_horizons'),
    available_horizons: Array.isArray(
      product.reference_available_horizons,
    )
      ? product.reference_available_horizons
      : computed?.reference_available_horizons || [],
    normalized_weights:
      product.reference_normalized_weights &&
      typeof product.reference_normalized_weights === 'object'
        ? product.reference_normalized_weights
        : computed?.reference_normalized_weights || {},
    policy_version:
      product.yield_policy_version ||
      computed?.yield_policy_version ||
      POLICY_VERSION,
  };
}

function tradeEffectiveDate(trade) {
  return trade.confirm_date || trade.trade_date;
}

function buildCurrentHoldingAmounts(input, trades, asOfDate) {
  const amounts = new Map();
  if (Array.isArray(input)) {
    for (const holding of input) {
      const code = normalizeCode(holding?.product_code || holding?.code);
      if (!code) continue;
      amounts.set(
        code,
        round((amounts.get(code) || 0) + asNumber(holding?.amount), 2),
      );
    }
    return amounts;
  }

  const cutoff = parseYmd(asOfDate);
  for (const trade of trades) {
    if (trade?.status !== 'confirmed') continue;
    const effectiveDate = tradeEffectiveDate(trade);
    const stamp = parseYmd(effectiveDate);
    if (cutoff !== null && (stamp === null || stamp > cutoff)) continue;
    const code = normalizeCode(trade.product_code);
    const amount = asNumber(trade.amount);
    if (!code) continue;
    if (trade.trade_type === 'buy') {
      amounts.set(code, round((amounts.get(code) || 0) + amount, 2));
    } else if (trade.trade_type === 'redeem') {
      amounts.set(code, round((amounts.get(code) || 0) - amount, 2));
    } else if (trade.trade_type === 'switch') {
      amounts.set(code, round((amounts.get(code) || 0) - amount, 2));
      const targetCode = normalizeCode(trade.target_product_code);
      if (targetCode) {
        const targetAmount = asNumber(
          trade.settlement_amount ?? trade.amount,
        );
        amounts.set(
          targetCode,
          round((amounts.get(targetCode) || 0) + targetAmount, 2),
        );
      }
    }
  }
  for (const [code, amount] of amounts) {
    amounts.set(code, round(Math.max(0, amount), 2));
  }
  return amounts;
}

function emptyAttribution(today = null) {
  return {
    schema_version: 1,
    status: 'insufficient',
    quality: 'insufficient',
    available: false,
    as_of_date: today,
    period: {
      window_days: DEFAULT_WINDOW_DAYS,
      start_date: null,
      end_date: null,
      calendar_days: 0,
      record_days: 0,
      missing_record_days: 0,
      coverage_pct: 0,
    },
    target: {
      annualized_pct: DEFAULT_TARGET_ANNUALIZED,
      observed_period_return_pct: null,
      observed_period_pnl: null,
      pnl_on_observed_principal: null,
      pnl_on_observed_holdings: null,
    },
    actual: {
      annualized_pct: null,
      observed_period_return_pct: null,
      observed_period_pnl: null,
      average_principal: 0,
      average_holding_amount: 0,
      sample_sufficient: false,
    },
    gap: {
      annualized_pct: null,
      observed_period_pnl: null,
    },
    bridge: {
      start_value: null,
      included_net_amount: 0,
      end_value: null,
      reconciliation_difference: null,
      reconciled: false,
    },
    components: [],
    main_drags: [],
    deployment: {
      purchase_wait_pnl: 0,
      redemption_wait_pnl: 0,
      cash_unclassified_pnl: 0,
      residual_pnl: 0,
    },
    fee_estimate: {
      available: false,
      amount: null,
      quality: 'unavailable',
      included_in_bridge: false,
      matched_trade_count: 0,
      trade_count: 0,
      verified_rule_count: 0,
      note: '没有可核验的交易费率设置。',
    },
    tplus_evidence: {
      available: false,
      product_count: 0,
      verified_product_count: 0,
      unverified_product_codes: [],
      products: [],
    },
    product_evidence: {
      available: false,
      account_pnl: 0,
      recorded_product_pnl: 0,
      difference: 0,
      reference_yield_coverage_pct: 0,
      reference_yield_complete: false,
      products: [],
    },
    headline: '还需要至少两条收益记录，才能建立可核对的 3% 目标差距归因。',
    disclosures: [
      '账户收益始终以账本 daily_pnl 为准；逐产品收益仅用于覆盖度与下钻核对。',
      '3% 是阶段对照目标，不是收益承诺或未来收益预测。',
    ],
  };
}

function buildHoldingEventsByDate(records, trades) {
  const events = trades
    .filter((trade) => trade.status === 'confirmed')
    .map((trade) => ({
      date: tradeEffectiveDate(trade),
      type: trade.trade_type,
      code: normalizeCode(trade.product_code),
      targetCode: normalizeCode(trade.target_product_code),
      amount: asNumber(trade.amount),
      targetAmount: asNumber(trade.settlement_amount ?? trade.amount),
      name: trade.product_name || '',
      targetName: trade.target_product_name || '',
    }))
    .filter((trade) => parseYmd(trade.date) !== null)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.code.localeCompare(b.code) ||
        a.type.localeCompare(b.type),
    );
  const holdings = new Map();
  const names = new Map();
  let eventIndex = 0;
  const snapshots = new Map();

  for (const record of records) {
    while (
      eventIndex < events.length &&
      events[eventIndex].date <= record.date
    ) {
      const event = events[eventIndex];
      if (event.code && event.name) names.set(event.code, event.name);
      if (event.targetCode && event.targetName) {
        names.set(event.targetCode, event.targetName);
      }
      if (event.type === 'buy') {
        holdings.set(
          event.code,
          round((holdings.get(event.code) || 0) + event.amount),
        );
      } else if (event.type === 'redeem') {
        holdings.set(
          event.code,
          round(Math.max(0, (holdings.get(event.code) || 0) - event.amount)),
        );
      } else if (event.type === 'switch') {
        holdings.set(
          event.code,
          round(Math.max(0, (holdings.get(event.code) || 0) - event.amount)),
        );
        holdings.set(
          event.targetCode || event.code,
          round(
            (holdings.get(event.targetCode || event.code) || 0) +
              event.targetAmount,
          ),
        );
      }
      eventIndex += 1;
    }
    snapshots.set(
      record.date,
      Object.fromEntries(
        [...holdings.entries()].filter(([, amount]) => amount > EPSILON),
      ),
    );
  }
  return { snapshots, names, events };
}

function pendingPurchaseAmount(trades, date) {
  return round(
    trades
      .filter(
        (trade) =>
          trade.trade_type === 'buy' &&
          trade.status !== 'cancelled' &&
          trade.trade_date <= date &&
          (trade.status === 'pending' ||
            (trade.status === 'confirmed' && trade.confirm_date > date)),
      )
      .reduce((sum, trade) => sum + asNumber(trade.amount), 0),
  );
}

function redemptionSettingFor(settingsByCode, productCode) {
  const setting =
    settingsByCode?.[normalizeCode(productCode)] || null;
  const redemptionDays =
    setting?.redemption_days === null ||
    setting?.redemption_days === undefined
      ? null
      : Number(setting.redemption_days);
  const arrivalDays =
    setting?.arrival_days === null ||
    setting?.arrival_days === undefined
      ? null
      : Number(setting.arrival_days);
  const purchaseConfirmDays =
    setting?.purchase_confirm_days === null ||
    setting?.purchase_confirm_days === undefined
      ? null
      : Number(setting.purchase_confirm_days);
  return {
    redemption_days: Number.isFinite(redemptionDays)
      ? redemptionDays
      : null,
    arrival_days: Number.isFinite(arrivalDays) ? arrivalDays : null,
    purchase_confirm_days: Number.isFinite(purchaseConfirmDays)
      ? purchaseConfirmDays
      : null,
    verified: Boolean(setting?.verified_at),
    verified_at: setting?.verified_at || '',
  };
}

function buildRedemptionPoolTimeline(records, trades, settingsByCode) {
  const confirmed = trades
    .filter((trade) => trade.status === 'confirmed')
    .map((trade) => ({
      date: tradeEffectiveDate(trade),
      type: trade.trade_type,
      productCode: normalizeCode(trade.product_code),
      amount: asNumber(trade.amount),
      targetAmount: asNumber(trade.settlement_amount ?? trade.amount),
    }))
    .filter((trade) => parseYmd(trade.date) !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const timeline = new Map();
  let index = 0;
  let pools = [];

  function consume(amount) {
    let remaining = amount;
    for (const pool of pools) {
      if (remaining <= EPSILON) break;
      const take = Math.min(pool.remaining, remaining);
      pool.remaining = round(pool.remaining - take);
      remaining = round(remaining - take);
    }
    pools = pools.filter((pool) => pool.remaining > EPSILON);
  }

  for (const record of records) {
    while (index < confirmed.length && confirmed[index].date <= record.date) {
      const trade = confirmed[index];
      if (trade.type === 'redeem') {
        const setting = redemptionSettingFor(
          settingsByCode,
          trade.productCode,
        );
        pools.push({
          remaining: trade.amount,
          arrival_date:
            setting.arrival_days === null
              ? null
              : shiftDate(trade.date, setting.arrival_days),
          verified: setting.verified,
        });
      } else if (trade.type === 'switch') {
        const setting = redemptionSettingFor(
          settingsByCode,
          trade.productCode,
        );
        pools.push({
          remaining: trade.amount,
          arrival_date:
            setting.arrival_days === null
              ? null
              : shiftDate(trade.date, setting.arrival_days),
          verified: setting.verified,
        });
        consume(trade.targetAmount);
      } else if (trade.type === 'buy') {
        consume(trade.amount);
      }
      index += 1;
    }
    const waiting = round(
      pools
        .filter(
          (pool) =>
            pool.arrival_date === null ||
            pool.arrival_date > record.date,
        )
        .reduce((sum, pool) => sum + pool.remaining, 0),
    );
    const arrived = round(
      pools
        .filter(
          (pool) =>
            pool.arrival_date !== null &&
            pool.arrival_date <= record.date,
        )
        .reduce((sum, pool) => sum + pool.remaining, 0),
    );
    timeline.set(record.date, {
      waiting,
      arrived,
      total: round(waiting + arrived),
    });
  }
  return timeline;
}

function annualizedEquivalentPct(amount, principalDays) {
  if (!Number.isFinite(amount) || !(principalDays > 0)) return null;
  return round((amount / principalDays) * 365 * 100, 6);
}

function buildFeeEstimate(records, trades, settingsByCode) {
  if (!records.length) {
    return emptyAttribution().fee_estimate;
  }
  const startDate = records[0].date;
  const endDate = records.at(-1).date;
  const relevant = trades.filter(
    (trade) =>
      trade.status === 'confirmed' &&
      tradeEffectiveDate(trade) >= startDate &&
      tradeEffectiveDate(trade) <= endDate,
  );
  if (!relevant.length) {
    return {
      available: true,
      amount: 0,
      quality: 'fact',
      included_in_bridge: false,
      matched_trade_count: 0,
      trade_count: 0,
      verified_rule_count: 0,
      note: '观察期内没有已确认申赎交易，交易费用估算为 0。',
    };
  }

  let amount = 0;
  let matched = 0;
  let requiredRules = 0;
  let verifiedRules = 0;
  for (const trade of relevant) {
    const isBuy = trade.trade_type === 'buy';
    const isRedeem = trade.trade_type === 'redeem';
    const isSwitch = trade.trade_type === 'switch';
    const sourceSetting =
      settingsByCode?.[normalizeCode(trade.product_code)] || null;
    const targetSetting =
      settingsByCode?.[
        normalizeCode(
          isSwitch ? trade.target_product_code : trade.product_code,
        )
      ] || null;
    const usesSource = isRedeem || isSwitch;
    const usesTarget = isBuy || isSwitch;
    if ((usesSource && sourceSetting) || (usesTarget && targetSetting)) {
      matched += 1;
    }
    if (usesSource) {
      requiredRules += 1;
      amount +=
        asNumber(trade.amount) *
        (asNumber(sourceSetting?.redemption_fee_bps) / 10000);
      if (sourceSetting?.verified_at) verifiedRules += 1;
    }
    if (usesTarget) {
      requiredRules += 1;
      amount +=
        asNumber(trade.amount) *
        (asNumber(targetSetting?.purchase_fee_bps) / 10000);
      if (targetSetting?.verified_at) verifiedRules += 1;
    }
  }
  if (!matched) {
    return {
      available: false,
      amount: null,
      quality: 'unavailable',
      included_in_bridge: false,
      matched_trade_count: 0,
      trade_count: relevant.length,
      verified_rule_count: 0,
      note: '观察期有申赎交易，但没有匹配到可用的申购或赎回费率设置。',
    };
  }
  const allRulesVerified =
    requiredRules > 0 && verifiedRules === requiredRules;
  return {
    available: true,
    amount: round(amount),
    quality: allRulesVerified ? 'verified_estimate' : 'unverified_estimate',
    included_in_bridge: false,
    matched_trade_count: matched,
    trade_count: relevant.length,
    verified_rule_count: verifiedRules,
    note: allRulesVerified
      ? '按已核验费率估算；仅作费用拖累提示，不从账户收益中再次扣减。'
      : '匹配到部分费率设置但尚未全部核验；仅作估算，不从账户收益中再次扣减。',
  };
}

function buildReturnAttribution(input = {}) {
  const records = Array.isArray(input.records) ? input.records : [];
  const trades = Array.isArray(input.trades) ? input.trades : [];
  const products = Array.isArray(input.products) ? input.products : [];
  const valuations = Array.isArray(input.valuations) ? input.valuations : [];
  const windowSummary = input.windowSummary || null;
  const targetAnnualized = asNumber(
    input.targetAnnualized,
    DEFAULT_TARGET_ANNUALIZED,
  );
  const windowDays = Number.isInteger(input.windowDays)
    ? input.windowDays
    : DEFAULT_WINDOW_DAYS;
  if (!records.length) {
    return emptyAttribution(input.today || null);
  }

  const orderedRecords = [...records]
    .filter((record) => parseYmd(record.date) !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!orderedRecords.length) {
    return emptyAttribution(input.today || null);
  }
  const lastDate = orderedRecords.at(-1).date;
  const lastStamp = parseYmd(lastDate);
  const cutoff = lastStamp - (windowDays - 1) * DAY_MS;
  const selectedRecords = orderedRecords.filter(
    (record) => parseYmd(record.date) >= cutoff,
  );
  if (!selectedRecords.length) {
    return emptyAttribution(lastDate);
  }

  const startDate = selectedRecords[0].date;
  const calendarDays = Math.max(1, daysBetween(startDate, lastDate) + 1);
  const recordDays = selectedRecords.length;
  const dailyTargetRate = (1 + targetAnnualized / 100) ** (1 / 365) - 1;
  const actualPnl = selectedRecords.reduce(
    (sum, record) => sum + asNumber(record.daily_pnl),
    0,
  );
  let targetOnPrincipal = 0;
  let targetOnHoldings = 0;
  let purchaseGap = 0;
  let redemptionGap = 0;
  let cashGap = 0;
  let principalDays = 0;
  let holdingDays = 0;
  const holdingDaysByCode = new Map();
  const { snapshots, names } = buildHoldingEventsByDate(
    selectedRecords,
    trades,
  );
  const redemptionTimeline = buildRedemptionPoolTimeline(
    selectedRecords,
    trades,
    input.settingsByCode || {},
  );

  for (const record of selectedRecords) {
    const principal = Math.max(0, asNumber(record.principal));
    const holdingAmount = Math.max(0, asNumber(record.holding_amount));
    const principalTarget = principal * dailyTargetRate;
    const holdingTarget = holdingAmount * dailyTargetRate;
    targetOnPrincipal += principalTarget;
    targetOnHoldings += holdingTarget;
    principalDays += principal;
    holdingDays += holdingAmount;

    const byProduct = snapshots.get(record.date) || {};
    const productTotal = Object.values(byProduct).reduce(
      (sum, amount) => sum + asNumber(amount),
      0,
    );
    for (const [code, amount] of Object.entries(byProduct)) {
      const normalizedAmount =
        productTotal > EPSILON
          ? asNumber(amount) * (holdingAmount / productTotal)
          : asNumber(amount);
      holdingDaysByCode.set(
        code,
        (holdingDaysByCode.get(code) || 0) + normalizedAmount,
      );
    }

    const deployableGap = principal - holdingAmount;
    const knownPurchase = pendingPurchaseAmount(trades, record.date);
    const redemptionState = redemptionTimeline.get(record.date) || {
      waiting: 0,
      arrived: 0,
      total: 0,
    };
    const purchaseAmount = Math.min(
      Math.max(0, deployableGap),
      knownPurchase,
    );
    const redemptionAmount = Math.min(
      Math.max(0, deployableGap - purchaseAmount),
      redemptionState.waiting,
    );
    purchaseGap -= purchaseAmount * dailyTargetRate;
    redemptionGap -= redemptionAmount * dailyTargetRate;
    cashGap -=
      (deployableGap - purchaseAmount - redemptionAmount) *
      dailyTargetRate;
  }

  const averagePrincipal = principalDays / recordDays;
  const averageHoldingAmount = holdingDays / recordDays;
  const productByCode = new Map(
    products.map((product) => [normalizeCode(product.code), product]),
  );
  const activeProductCodes = [
    ...new Set(
      trades
        .filter((trade) => trade.status === 'confirmed')
        .flatMap((trade) => [
          normalizeCode(trade.product_code),
          normalizeCode(trade.target_product_code),
        ])
        .filter(Boolean),
    ),
  ].sort();
  const tplusProducts = activeProductCodes
    .filter((code) => input.settingsByCode?.[code])
    .map((code) => ({
      product_code: code,
      ...redemptionSettingFor(input.settingsByCode, code),
    }));
  const tplusEvidence = {
    available: tplusProducts.length > 0,
    product_count: tplusProducts.length,
    verified_product_count: tplusProducts.filter((item) => item.verified)
      .length,
    unverified_product_codes: tplusProducts
      .filter((item) => !item.verified)
      .map((item) => item.product_code),
    products: tplusProducts,
  };
  const currentHoldingAmounts = buildCurrentHoldingAmounts(
    input.holdings,
    trades,
    input.today || lastDate,
  );
  const currentHoldingFields = (code) => {
    const currentHoldingAmount = round(
      Math.max(0, asNumber(currentHoldingAmounts.get(code))),
      2,
    );
    return {
      holding_status:
        currentHoldingAmount > EPSILON ? 'held' : 'redeemed',
      current_holding_amount: currentHoldingAmount,
    };
  };
  let referencePnl = 0;
  let coveredHoldingDays = 0;
  const productRows = [];
  const recordedByCode = new Map();
  for (const valuation of valuations) {
    if (
      valuation.yield_date < startDate ||
      valuation.yield_date > lastDate
    ) {
      continue;
    }
    const code = normalizeCode(valuation.product_code);
    const current = recordedByCode.get(code) || {
      code,
      name: valuation.product_name || '',
      recorded_product_pnl: 0,
      recorded_days: 0,
    };
    current.recorded_product_pnl += asNumber(valuation.daily_pnl);
    current.recorded_days += 1;
    if (!current.name && valuation.product_name) {
      current.name = valuation.product_name;
    }
    recordedByCode.set(code, current);
  }

  for (const [code, amountDays] of holdingDaysByCode.entries()) {
    const product = productByCode.get(code) || null;
    const referenceEvidence = productReferenceYield(product);
    const referenceYield = referenceEvidence.value_pct;
    const hasReference = Number.isFinite(referenceYield);
    const productTarget = amountDays * dailyTargetRate;
    const productReference = hasReference
      ? (amountDays * referenceYield) / 36500
      : null;
    if (hasReference) {
      referencePnl += productReference;
      coveredHoldingDays += amountDays;
    }
    const recorded = recordedByCode.get(code) || {
      code,
      name: '',
      recorded_product_pnl: 0,
      recorded_days: 0,
    };
    const recordedProductPnl = asNumber(recorded.recorded_product_pnl);
    const hasHoldingPeriod = amountDays > EPSILON;
    productRows.push({
      ...currentHoldingFields(code),
      product_code: code,
      product_name:
        product?.name ||
        recorded.name ||
        names.get(code) ||
        code,
      reference_yield_pct: hasReference ? referenceYield : null,
      reference_yield_status:
        referenceEvidence.status,
      reference_yield_reason: referenceEvidence.reason,
      reference_available_horizons:
        referenceEvidence.available_horizons,
      reference_normalized_weights:
        referenceEvidence.normalized_weights,
      reference_yield_policy_version:
        referenceEvidence.policy_version,
      reference_data_date: product?.data_date || null,
      holding_days_amount: round(amountDays),
      target_pnl: round(productTarget),
      reference_pnl: hasReference ? round(productReference) : null,
      selection_estimate_pnl: hasReference
        ? round(productReference - productTarget)
        : null,
      actual_vs_reference_pnl:
        hasReference && hasHoldingPeriod
          ? round(recordedProductPnl - productReference)
          : null,
      actual_vs_target_pnl: hasHoldingPeriod
        ? round(recordedProductPnl - productTarget)
        : null,
      recorded_product_pnl: round(recordedProductPnl),
      recorded_days: recorded.recorded_days,
    });
    recordedByCode.delete(code);
  }
  for (const recorded of recordedByCode.values()) {
    productRows.push({
      ...currentHoldingFields(recorded.code),
      product_code: recorded.code,
      product_name: recorded.name || recorded.code,
      reference_yield_pct: null,
      reference_yield_status: 'unavailable',
      reference_yield_reason: 'no_product_snapshot',
      reference_available_horizons: [],
      reference_normalized_weights: {},
      reference_yield_policy_version: null,
      reference_data_date: null,
      holding_days_amount: 0,
      target_pnl: 0,
      reference_pnl: null,
      selection_estimate_pnl: null,
      actual_vs_reference_pnl: null,
      actual_vs_target_pnl: null,
      recorded_product_pnl: round(recorded.recorded_product_pnl),
      recorded_days: recorded.recorded_days,
    });
  }
  productRows.sort(
    (a, b) =>
      b.recorded_product_pnl - a.recorded_product_pnl ||
      a.product_code.localeCompare(b.product_code),
  );

  const referenceCoveragePct =
    holdingDays > 0 ? (coveredHoldingDays / holdingDays) * 100 : 0;
  const referenceComplete =
    holdingDays > 0 && referenceCoveragePct >= 99.995;
  const allRecordedProductTotal = productRows.reduce(
    (sum, item) => sum + asNumber(item.recorded_product_pnl),
    0,
  );

  const deploymentGap = targetOnHoldings - targetOnPrincipal;
  const deploymentClassified = purchaseGap + redemptionGap + cashGap;
  const deploymentResidual = deploymentGap - deploymentClassified;
  cashGap += deploymentResidual;

  const selectionAmount = referenceComplete
    ? referencePnl - targetOnHoldings
    : null;
  const remainingProductAmount = referenceComplete
    ? actualPnl - referencePnl
    : actualPnl - targetOnHoldings;
  const observedGapAmount = actualPnl - targetOnPrincipal;
  const annualizedPct =
    windowSummary?.annualized_pct === null ||
    windowSummary?.annualized_pct === undefined
      ? null
      : asNumber(windowSummary.annualized_pct);
  const sampleSufficient = Boolean(windowSummary?.sample_sufficient);
  const missingRecordDays = Math.max(0, calendarDays - recordDays);
  const quality =
    !sampleSufficient
      ? 'insufficient'
      : missingRecordDays > 0 || !referenceComplete
        ? 'partial'
        : 'complete';
  const targetOnPrincipalRounded = round(targetOnPrincipal);
  const actualPnlRounded = round(actualPnl);
  const components = [
    {
      key: 'product_selection',
      label: '产品选择与配置',
      amount: selectionAmount === null ? null : round(selectionAmount),
      annualized_equivalent_pct:
        selectionAmount === null
          ? null
          : annualizedEquivalentPct(selectionAmount, principalDays),
      included_in_bridge: selectionAmount !== null,
      quality: referenceComplete ? 'estimate' : 'unavailable',
      note: referenceComplete
        ? '按当前产品快照的参考年化与逐日持仓权重估算，不是已实现收益。'
        : '部分持仓缺少参考年化，未按 0 补齐，无法可靠拆分选择贡献。',
    },
    {
      key: 'product_realization',
      label: referenceComplete
        ? '实际收益与参考差异'
        : '产品实际收益对比 3%',
      amount: round(remainingProductAmount),
      annualized_equivalent_pct: annualizedEquivalentPct(
        remainingProductAmount,
        principalDays,
      ),
      included_in_bridge: true,
      quality: referenceComplete ? 'mixed' : 'fact',
      note: referenceComplete
        ? '实际账户收益减参考年化估算；保留复核差异，不把估算写成已实现事实。'
        : '产品选择估算缺失，因此把已投入资金的实际收益整体与 3% 对照。',
    },
    {
      key: 'purchase_wait',
      label: '申购等待空档',
      amount: round(purchaseGap),
      annualized_equivalent_pct: annualizedEquivalentPct(
        purchaseGap,
        principalDays,
      ),
      included_in_bridge: true,
      quality: 'estimate',
      note: '按下单日至确认日仍未确认的买入本金估算 3% 机会收益，并同时展示已核验的申购确认 T+N。',
    },
    {
      key: 'redemption_wait',
      label: '赎回后再配置空档',
      amount: round(redemptionGap),
      annualized_equivalent_pct: annualizedEquivalentPct(
        redemptionGap,
        principalDays,
      ),
      included_in_bridge: true,
      quality: 'estimate',
      note: '按已确认赎回、到账 T+N 和后续确认买入的承接时点，估算尚未到账资金的等待拖累。',
    },
    {
      key: 'cash_unclassified',
      label: '现金或未归类资金',
      amount: round(cashGap),
      annualized_equivalent_pct: annualizedEquivalentPct(
        cashGap,
        principalDays,
      ),
      included_in_bridge: true,
      quality: 'estimate',
      note: '账户本金与已确认持仓的剩余差额，包括已到账但尚未再配置资金；无法继续可靠拆分时保留为未归类。',
    },
  ];
  const feeEstimate = buildFeeEstimate(
    selectedRecords,
    trades,
    input.settingsByCode || {},
  );
  components.push({
    key: 'fee_estimate',
    label: '费用拖累估算',
    amount: feeEstimate.amount,
    annualized_equivalent_pct:
      feeEstimate.amount === null
        ? null
        : annualizedEquivalentPct(feeEstimate.amount, principalDays),
    included_in_bridge: false,
    quality: feeEstimate.quality,
    note: feeEstimate.note,
  });
  const productRealization = components.find(
    (component) => component.key === 'product_realization',
  );
  const reservedBridgeAmount = components
    .filter(
      (component) =>
        component.included_in_bridge &&
        component.key !== 'product_realization',
    )
    .reduce((sum, component) => sum + asNumber(component.amount), 0);
  productRealization.amount = round(
    actualPnlRounded - targetOnPrincipalRounded - reservedBridgeAmount,
  );
  productRealization.annualized_equivalent_pct =
    annualizedEquivalentPct(productRealization.amount, principalDays);

  const includedComponents = components.filter(
    (component) => component.included_in_bridge,
  );
  const includedNetAmount = includedComponents.reduce(
    (sum, component) => sum + asNumber(component.amount),
    0,
  );
  const endValue = round(targetOnPrincipalRounded + includedNetAmount);
  const reconciliationDifference = round(actualPnlRounded - endValue);
  const annualizedGap =
    annualizedPct === null ? null : annualizedPct - targetAnnualized;
  const annualizedGapRounded =
    annualizedGap === null ? null : round(annualizedGap, 6);
  const negativeComponents = includedComponents
    .filter((component) => asNumber(component.amount) < -EPSILON)
    .sort((a, b) => a.amount - b.amount);
  const mainDrags = negativeComponents.slice(0, 3).map((component) => ({
    key: component.key,
    label: component.label,
    amount: component.amount,
    annualized_equivalent_pct: component.annualized_equivalent_pct,
    quality: component.quality,
  }));
  const observedPeriodReturnPct =
    windowSummary?.period_return_pct === null ||
    windowSummary?.period_return_pct === undefined
      ? null
      : asNumber(windowSummary.period_return_pct);
  const targetPeriodReturnPct =
    ((1 + targetAnnualized / 100) ** (calendarDays / 365) - 1) * 100;
  const mainDragText = mainDrags.length
    ? `主要拖累为${mainDrags.map((item) => item.label).join('、')}。`
    : '当前计入项没有形成可识别的金额拖累。';
  const headline =
    quality === 'insufficient' || annualizedGapRounded === null
      ? `观察期样本不足；${mainDragText}结果仅作核算，不用于判断目标是否达成。`
      : annualizedGapRounded < 0
        ? `近 ${calendarDays} 天折算低于 3% 目标 ${Math.abs(
            annualizedGapRounded,
          ).toFixed(2)}pp；${mainDragText}`
        : `近 ${calendarDays} 天折算高于 3% 目标 ${annualizedGapRounded.toFixed(
            2,
          )}pp；${mainDragText}阶段折算不代表目标已经兑现。`;

  return {
    schema_version: 1,
    status:
      quality === 'insufficient'
        ? 'insufficient'
        : quality === 'partial'
          ? 'partial'
          : 'available',
    quality,
    available: recordDays >= 2,
    as_of_date: lastDate,
    period: {
      window_days: windowDays,
      start_date: startDate,
      end_date: lastDate,
      calendar_days: calendarDays,
      record_days: recordDays,
      missing_record_days: missingRecordDays,
      coverage_pct: round((recordDays / calendarDays) * 100, 2),
    },
    target: {
      annualized_pct: targetAnnualized,
      observed_period_return_pct: round(targetPeriodReturnPct, 6),
      observed_period_pnl: targetOnPrincipalRounded,
      pnl_on_observed_principal: targetOnPrincipalRounded,
      pnl_on_observed_holdings: round(targetOnHoldings),
    },
    actual: {
      annualized_pct: annualizedPct,
      observed_period_return_pct: observedPeriodReturnPct,
      observed_period_pnl: actualPnlRounded,
      average_principal: round(averagePrincipal),
      average_holding_amount: round(averageHoldingAmount),
      sample_sufficient: sampleSufficient,
    },
    gap: {
      annualized_pct: annualizedGapRounded,
      observed_period_pnl: round(observedGapAmount),
    },
    bridge: {
      start_value: targetOnPrincipalRounded,
      included_net_amount: round(includedNetAmount),
      end_value: endValue,
      reconciliation_difference: reconciliationDifference,
      reconciled: Math.abs(reconciliationDifference) <= 0.01,
    },
    components,
    main_drags: mainDrags,
    deployment: {
      purchase_wait_pnl: round(purchaseGap),
      redemption_wait_pnl: round(redemptionGap),
      cash_unclassified_pnl: round(cashGap),
      residual_pnl: round(deploymentResidual),
    },
    fee_estimate: feeEstimate,
    tplus_evidence: tplusEvidence,
    product_evidence: {
      available: productRows.length > 0,
      account_pnl: actualPnlRounded,
      recorded_product_pnl: round(allRecordedProductTotal),
      difference: round(allRecordedProductTotal - actualPnl),
      reference_yield_coverage_pct: round(referenceCoveragePct, 2),
      reference_yield_complete: referenceComplete,
      products: productRows,
    },
    headline,
    disclosures: [
      '账户收益始终以账本 daily_pnl 为准；逐产品收益仅用于覆盖度与下钻核对。',
      '选择、申赎空档和费用均明确标为估算；账户与产品收益差额不补零、不自动改写。',
      '3% 是阶段对照目标，不是收益承诺或未来收益预测。',
    ],
  };
}

module.exports = {
  DEFAULT_TARGET_ANNUALIZED,
  DEFAULT_WINDOW_DAYS,
  buildReturnAttribution,
};
