'use strict';

const {
  bucketForTerm,
  EVIDENCE_POLICY,
  returnEvidenceTier,
} = require('./products');

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_YIELD_EDGE_PP = 0.15;
const BREAK_EVEN_MARGIN_PP = 0.05;
const MIN_GAIN_RULE_PCT = 0.1;
const MIN_GAIN_BASE_DAYS = 90;
const MIN_GAIN_FLOOR = 1;
const MAX_CANDIDATES = 6;
const ROLLOVER_GAP_DAYS = 0;
const DEFAULT_REDEMPTION_DAYS = 1;
const DEFAULT_ARRIVAL_DAYS = 0;
const DEFAULT_PURCHASE_CONFIRM_DAYS = 1;
const BUCKET_COMPARISON_DAYS = Object.freeze({
  short: 30,
  medium: 100,
  long: 360,
});

function round(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const factor = 10 ** digits;
  return Math.round((number + Number.EPSILON) * factor) / factor;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseYmd(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    return null;
  }
  return date;
}

function formatYmd(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value, days) {
  const date = parseYmd(value);
  if (!date) return '';
  return formatYmd(new Date(date.getTime() + Number(days || 0) * DAY_MS));
}

function daysBetween(from, to) {
  const start = parseYmd(from);
  const end = parseYmd(to);
  if (!start || !end) return null;
  return Math.round((end.getTime() - start.getTime()) / DAY_MS);
}

/**
 * Reference run-rate for a product. The 3M figure carries the most weight
 * because it is closest to the current reinvestment decision; 1Y is only a
 * sanity anchor and is never treated as a forward return.
 */
function referenceYield(product) {
  if (!product) return null;
  const parts = [
    [numberOrNull(product.return_3m), 0.5],
    [numberOrNull(product.return_6m), 0.3],
    [numberOrNull(product.return_1y), 0.2],
  ].filter(([value]) => value !== null);
  if (!parts.length) return null;
  const weight = parts.reduce((sum, [, itemWeight]) => sum + itemWeight, 0);
  const value = parts.reduce((sum, [item, itemWeight]) => sum + item * itemWeight, 0) / weight;
  return round(value, 4);
}

/**
 * Mirrors skills/r2-wealth-management/scripts/switch_calc.py. The current
 * product is held to its maturity/open date; redemption fees apply only to the
 * switch path. Returns use annual-rate compounding over the effective days.
 */
function calculateSwitch({
  amount,
  currentYieldPct,
  horizonDays,
  redemptionFeeBps = 0,
  switchWaitDays = 0,
  newYieldPct,
  purchaseFeeBps = 0,
}) {
  const moneyAmount = Number(amount);
  const currentDays = Number(horizonDays);
  const waitDays = Number(switchWaitDays);
  if (!Number.isFinite(moneyAmount) || moneyAmount <= 0) {
    throw new Error('持仓金额需要大于 0');
  }
  if (!Number.isFinite(currentDays) || currentDays < 0) {
    throw new Error('比较期限不能为负');
  }
  if (!Number.isFinite(waitDays) || waitDays < 0) {
    throw new Error('切换等待天数不能为负');
  }
  const currentYield = Number(currentYieldPct) / 100;
  const newYield = Number(newYieldPct) / 100;
  if (
    !Number.isFinite(currentYield) ||
    !Number.isFinite(newYield) ||
    currentYield <= -1 ||
    newYield <= -1
  ) {
    throw new Error('参考年化必须大于 -100%');
  }
  const newDays = Math.max(0, currentDays - waitDays);
  const currentGross =
    moneyAmount * (Math.pow(1 + currentYield, currentDays / 365) - 1);
  const redemptionFee = moneyAmount * Number(redemptionFeeBps || 0) / 10_000;
  const newGross =
    moneyAmount * (Math.pow(1 + newYield, newDays / 365) - 1);
  const purchaseFee = moneyAmount * Number(purchaseFeeBps || 0) / 10_000;
  const newNet = newGross - redemptionFee - purchaseFee;
  const difference = newNet - currentGross;
  const breakEvenFactor =
    newDays > 0
      ? 1 + (currentGross + redemptionFee + purchaseFee) / moneyAmount
      : null;
  const breakEvenYieldPct =
    breakEvenFactor !== null && breakEvenFactor > 0
      ? (Math.pow(breakEvenFactor, 365 / newDays) - 1) * 100
      : null;
  return {
    new_days: round(newDays, 2),
    current_gross: round(currentGross, 2),
    redemption_fee: round(redemptionFee, 2),
    new_gross: round(newGross, 2),
    purchase_fee: round(purchaseFee, 2),
    new_net: round(newNet, 2),
    difference: round(difference, 2),
    break_even_yield_pct:
      breakEvenYieldPct === null ? null : round(breakEvenYieldPct, 4),
    fee_drag: round(redemptionFee + purchaseFee, 2),
  };
}

function reviewBucketForTerm(termDays) {
  const bucket = bucketForTerm(termDays);
  return bucket === 'cash' || bucket === 'unknown' ? 'short' : bucket;
}

function comparisonDaysForBucket(bucket) {
  return BUCKET_COMPARISON_DAYS[bucket] || BUCKET_COMPARISON_DAYS.short;
}

function dynamicMinGainAmount(amount, comparisonDays = MIN_GAIN_BASE_DAYS) {
  const principal = Number(amount);
  if (!Number.isFinite(principal) || principal <= 0) return MIN_GAIN_FLOOR;
  const days = Number(comparisonDays);
  const effectiveDays =
    Number.isFinite(days) && days > 0 ? days : MIN_GAIN_BASE_DAYS;
  return round(
    Math.max(
      MIN_GAIN_FLOOR,
      principal *
        (MIN_GAIN_RULE_PCT / 100) *
        (effectiveDays / MIN_GAIN_BASE_DAYS),
    ),
    2,
  );
}

function candidatePool({ holding, currentProduct, products, amount }) {
  const termDays =
    numberOrNull(holding.term_days) ??
    numberOrNull(currentProduct?.term_days) ??
    null;
  // Daily-open holdings migrate into the short bucket. All other products stay
  // in their standard bucket; minimum holding periods do not create subgroups.
  const comparisonBucket = reviewBucketForTerm(termDays);
  return (Array.isArray(products) ? products : [])
    .filter((product) => product && product.code !== holding.product_code)
    .filter((product) => product.observation_ready !== false)
    .filter((product) => {
      const risk = String(product.risk_level || '').toUpperCase();
      const holdingRisk = String(holding.risk_level || 'R2').toUpperCase();
      if (risk !== holdingRisk) return false;
      const candidateTerm = numberOrNull(product.term_days);
      if (candidateTerm === null) return false;
      if (bucketForTerm(candidateTerm) !== comparisonBucket) return false;
      const minimum = Number(product.min_amount);
      if (Number.isFinite(minimum) && minimum > amount) return false;
      return true;
    });
}

function quotaFor(quotaByCode, code) {
  const quota = quotaByCode && quotaByCode[code];
  if (!quota) return { available: null, max_order: null, window: '', verified_at: '' };
  return {
    available: numberOrNull(quota.available),
    max_order: numberOrNull(quota.max_order),
    window: String(quota.window || ''),
    verified_at: String(quota.verified_at || ''),
  };
}

function resolveSwitchWaitDays(setting, candidateSetting) {
  const storedRedemptionDays = numberOrNull(setting?.redemption_days);
  const storedArrivalDays = numberOrNull(setting?.arrival_days);
  const storedPurchaseConfirmDays = numberOrNull(
    candidateSetting?.purchase_confirm_days,
  );
  const redemptionDays = storedRedemptionDays ?? DEFAULT_REDEMPTION_DAYS;
  const arrivalDays = storedArrivalDays ?? DEFAULT_ARRIVAL_DAYS;
  const purchaseConfirmDays =
    storedPurchaseConfirmDays ?? DEFAULT_PURCHASE_CONFIRM_DAYS;
  const currentVerified =
    storedRedemptionDays !== null &&
    storedArrivalDays !== null &&
    Boolean(String(setting?.verified_at || '').trim());
  const candidateVerified =
    storedPurchaseConfirmDays !== null &&
    Boolean(String(candidateSetting?.verified_at || '').trim());
  const status =
    currentVerified && candidateVerified ? 'verified' : 'estimated';
  const parts = [
    `当前产品赎回 T+${redemptionDays}${
      storedRedemptionDays === null ? '（默认）' : ''
    }`,
    `到账 T+${arrivalDays}${storedArrivalDays === null ? '（默认）' : ''}`,
    `候选申购确认 T+${purchaseConfirmDays}${
      storedPurchaseConfirmDays === null ? '（默认）' : ''
    }`,
  ];
  return {
    value: redemptionDays + arrivalDays + purchaseConfirmDays,
    status,
    source: `${status === 'verified' ? '已核验' : '估算'}：${parts.join(' + ')}`,
  };
}

function buildReminders({ today, maturityDate, redemptionOpenDate, termDays }) {
  const reminders = [];
  const maturityDays = maturityDate ? daysBetween(today, maturityDate) : null;
  if (maturityDays !== null) {
    if (maturityDays < 0) {
      reminders.push({
        level: 'urgent',
        date: maturityDate,
        kind: 'maturity',
        text: `已到期 ${Math.abs(maturityDays)} 天，需处理赎回或续作`,
      });
    } else if (maturityDays === 0) {
      reminders.push({
        level: 'urgent',
        date: maturityDate,
        kind: 'maturity',
        text: '今天到期，需处理赎回或续作',
      });
    } else if (maturityDays <= 3) {
      reminders.push({
        level: 'urgent',
        date: maturityDate,
        kind: 'maturity',
        text: `距到期 ${maturityDays} 天，替代品与赎回到账要现在核对`,
      });
    } else if (maturityDays <= 14) {
      reminders.push({
        level: 'window',
        date: maturityDate,
        kind: 'maturity',
        text: `距到期 ${maturityDays} 天，进入替换/续作比较窗口`,
      });
    }
  }
  const openDays = redemptionOpenDate
    ? daysBetween(today, redemptionOpenDate)
    : null;
  // `next_open_date` in the public snapshot is a purchase-opening date. A
  // redemption window must come from the product's own rules and is stored
  // separately by the user.
  if (openDays !== null && openDays >= -1) {
    if (openDays <= 0) {
      reminders.push({
        level: 'urgent',
        date: redemptionOpenDate,
        kind: 'open',
        text: '今日为下一赎回开放日，替换需按赎回截止时间倒推',
      });
    } else if (openDays <= 3) {
      reminders.push({
        level: 'window',
        date: redemptionOpenDate,
        kind: 'open',
        text: `距下一赎回开放日 ${openDays} 天，替换窗口临近`,
      });
    }
  }
  if (!maturityDate && openDays === null) {
    reminders.push({
      level: 'none',
      date: '',
      kind: 'daily',
      text: '日开产品无固定到期日，按月复核即可',
    });
  }
  const rank = { urgent: 2, window: 1, none: 0 };
  reminders.sort((a, b) => rank[b.level] - rank[a.level]);
  return reminders.length
    ? reminders
    : [{ level: 'none', date: '', kind: 'none', text: '未进入到期或开放窗口' }];
}

function resolveRedemptionState({
  today,
  maturityDate,
  redemptionOpenDate,
  termDays,
}) {
  const maturityDays = maturityDate ? daysBetween(today, maturityDate) : null;
  const openDays = redemptionOpenDate
    ? daysBetween(today, redemptionOpenDate)
    : null;

  if (maturityDays !== null && maturityDays <= 0) {
    return {
      state: 'matured',
      redeemable_now: true,
      available_date: maturityDate,
      reason:
        maturityDays === 0
          ? '今天到期，可按到期规则赎回或续作'
          : `已到期 ${Math.abs(maturityDays)} 天，可按到期规则处理`,
    };
  }
  if (Number(termDays) === 0) {
    return {
      state: 'daily_open',
      redeemable_now: true,
      available_date: '',
      reason: '日开产品，按产品规则可在交易日赎回',
    };
  }
  if (openDays !== null && openDays <= 0) {
    return {
      state: 'open',
      redeemable_now: true,
      available_date: redemptionOpenDate,
      reason: '已到赎回开放日，可按开放日规则赎回',
    };
  }
  if (openDays !== null && openDays <= 14) {
    return {
      state: 'window',
      redeemable_now: false,
      available_date: redemptionOpenDate,
      reason: `距下一赎回开放日 ${openDays} 天，进入到期处理窗口；开放日前仍不可提前赎回`,
    };
  }
  if (maturityDays !== null && maturityDays <= 14) {
    return {
      state: 'window',
      redeemable_now: false,
      available_date: maturityDate,
      reason: `距到期 ${maturityDays} 天，进入到期处理窗口；到期日前仍不可提前赎回`,
    };
  }
  if (maturityDays !== null) {
    return {
      state: 'locked',
      redeemable_now: false,
      available_date: maturityDate,
      reason: `锁定期内，最早 ${maturityDate} 到期后可赎回`,
    };
  }
  if (openDays !== null && openDays > 14) {
    return {
      state: 'locked',
      redeemable_now: false,
      available_date: redemptionOpenDate,
      reason: `距下一赎回开放日 ${openDays} 天，当前不可赎回`,
    };
  }
  return {
    state: 'unknown',
    redeemable_now: false,
    available_date: '',
    reason: '缺少到期日或赎回开放日，无法确认当前是否可赎回',
  };
}

function buildHoldingReview({
  holding,
  products = [],
  universe = [],
  principal = null,
  setting = null,
  settingsByCode = {},
  quotaByCode = {},
  today,
  snapshotDate = '',
  decisions = [],
}) {
  const amount = round(Number(holding.amount) || 0, 2);
  const currentProduct =
    (Array.isArray(universe) ? universe : []).find(
      (product) => product.code === holding.product_code,
    ) || null;
  const currentTermDays =
    numberOrNull(holding.term_days) ?? numberOrNull(currentProduct?.term_days);
  const isDailyOpen = currentTermDays === 0;
  const bucket = bucketForTerm(currentTermDays);
  const comparisonBucket = reviewBucketForTerm(currentTermDays);
  const maturityDate = holding.maturity_date || null;
  const daysToMaturity = maturityDate ? daysBetween(today, maturityDate) : null;
  const nextOpenDate = currentProduct?.next_open_date || '';
  const daysToOpen = nextOpenDate ? daysBetween(today, nextOpenDate) : null;
  const redemptionOpenDate = String(setting?.next_redeem_open_date || '');
  const daysToRedemptionOpen = redemptionOpenDate
    ? daysBetween(today, redemptionOpenDate)
    : null;
  const redemption = resolveRedemptionState({
    today,
    maturityDate,
    redemptionOpenDate,
    termDays: currentTermDays,
  });
  const currentYieldPct = referenceYield(currentProduct);
  const redemptionFeeBps = numberOrNull(setting?.redemption_fee_bps) ?? 0;
  const purchaseFeeBps = numberOrNull(setting?.purchase_fee_bps) ?? 0;
  const horizonDays = comparisonDaysForBucket(comparisonBucket);
  const minGainAmount = dynamicMinGainAmount(amount, horizonDays);
  const settingsComplete =
    numberOrNull(setting?.redemption_days) !== null &&
    numberOrNull(setting?.arrival_days) !== null &&
    Boolean(String(setting?.verified_at || '').trim());
  const snapshot = snapshotDate || currentProduct?.data_date || '';
  const reminders = buildReminders({
    today,
    maturityDate,
    redemptionOpenDate,
    termDays: currentTermDays,
  });
  const reminder = reminders[0];
  const dataGaps = [];
  if (!currentProduct) {
    dataGaps.push('当前产品不在最新产品快照，参考年化与开放日缺失');
  } else if (currentYieldPct === null) {
    dataGaps.push('当前产品缺少 3M/6M/1Y 年化，无法计算盈亏平衡');
  }
  if (!settingsComplete) {
    dataGaps.push(
      `赎回/到账 T+N 未核验，按当前产品赎回 T+${DEFAULT_REDEMPTION_DAYS}、到账 T+${DEFAULT_ARRIVAL_DAYS} 估算；执行前需确认交易规则`,
    );
  }
  const candidates = candidatePool({
    holding,
    currentProduct,
    products,
    amount,
  })
    .map((product) => {
      const yieldPct = referenceYield(product);
      const quota = quotaFor(quotaByCode, product.code);
      const candidateSetting = settingsByCode?.[product.code] || null;
      const switchWait = resolveSwitchWaitDays(setting, candidateSetting);
      const candidateTerm = numberOrNull(product.term_days);
      const comparisonDays = horizonDays;
      const candidateMinGainAmount = dynamicMinGainAmount(
        amount,
        comparisonDays,
      );
      const evidenceTier =
        product.evidence_tier || returnEvidenceTier(product);
      const evidencePolicy = EVIDENCE_POLICY[evidenceTier];
      const principalAmount = numberOrNull(principal);
      const evidenceSingleCapAmount =
        principalAmount !== null && evidencePolicy.single_pct !== null
          ? round(
              principalAmount * (evidencePolicy.single_pct / 100),
              2,
            )
          : null;
      const candidateReasons = [];
      const candidateGaps = [];
      if (yieldPct === null) {
        candidateGaps.push('候选缺少 3M/6M/1Y 年化');
      }
      if (quota.available === null) {
        candidateGaps.push('额度未核验');
      } else if (quota.available <= 0) {
        candidateGaps.push('额度售罄或为 0，当前不可新增');
      }
      if (
        evidenceTier !== 'full_1y' &&
        evidenceSingleCapAmount !== null
      ) {
        candidateGaps.push(
          `${evidencePolicy.label}候选单只最多 ${evidencePolicy.single_pct}% · ¥${evidenceSingleCapAmount.toFixed(2)}；组合合计上限另需按同类产品核对`,
        );
      }
      let result = null;
      if (currentYieldPct !== null && yieldPct !== null) {
        result = calculateSwitch({
          amount,
          currentYieldPct,
          horizonDays: comparisonDays,
          redemptionFeeBps,
          switchWaitDays: switchWait.value,
          newYieldPct: yieldPct,
          purchaseFeeBps,
        });
      }
      const yieldGapPp =
        currentYieldPct === null || yieldPct === null
          ? null
          : round(yieldPct - currentYieldPct, 4);
      let verdict = 'watch';
      if (result && yieldGapPp !== null) {
        if (yieldGapPp < MIN_YIELD_EDGE_PP) {
          verdict = 'hold';
          candidateReasons.push(
            `年化差 ${round(yieldGapPp, 2)}pp，低于 ${MIN_YIELD_EDGE_PP}pp 门槛`,
          );
        } else if (result.new_days <= 0) {
          candidateReasons.push('空档天数不小于比较期限，切换没有计息时间');
        } else if (result.difference < candidateMinGainAmount) {
          candidateReasons.push(
            `切换后多赚 ¥${result.difference.toFixed(2)}，低于门槛 ¥${round(
              candidateMinGainAmount,
              2,
            ).toFixed(2)}`,
          );
        } else if (
          result.break_even_yield_pct !== null &&
          yieldPct <= result.break_even_yield_pct + BREAK_EVEN_MARGIN_PP
        ) {
          candidateReasons.push(
            `候选年化 ${yieldPct.toFixed(2)}% 未显著超过盈亏平衡 ${result.break_even_yield_pct.toFixed(2)}%`,
          );
        } else if (
          evidenceSingleCapAmount !== null &&
          amount > evidenceSingleCapAmount + 0.01
        ) {
          candidateReasons.push(
            `${evidencePolicy.label}候选受单只 ${evidencePolicy.single_pct}% 上限约束，当前批次 ¥${amount.toFixed(2)} 超过 ¥${evidenceSingleCapAmount.toFixed(2)}`,
          );
        } else {
          verdict = 'replace';
          candidateReasons.push(
            `年化差 +${round(yieldGapPp, 2)}pp（3M/6M/1Y 加权口径）`,
          );
          candidateReasons.push(
            `切换后多赚 ¥${result.difference.toFixed(2)}，高于门槛 ¥${round(
              candidateMinGainAmount,
              2,
            ).toFixed(2)}`,
          );
          candidateReasons.push(
            `盈亏平衡 ${result.break_even_yield_pct.toFixed(2)}%，候选 ${yieldPct.toFixed(2)}%`,
          );
          if (quota.available === null) {
            candidateReasons.push('额度未核验，执行前需在 App 核对');
          }
        }
      } else {
        candidateReasons.push('缺少当前产品或候选的参考年化，暂不判定');
      }
      if (switchWait.status === 'estimated') {
        candidateGaps.push(
          `切换等待按 ${switchWait.value} 天估算，执行前需核验 T+N`,
        );
      }
      if (isDailyOpen) {
        candidateReasons.push('日开持仓按短期限（7–30 天）候选比较');
      }
      if (!redemption.redeemable_now) {
        candidateReasons.push(
          `当前不可赎回：${redemption.reason}；只能做到期后计划`,
        );
      }
      return {
        code: product.code,
        name: product.name,
        issuer: product.issuer,
        risk_level: product.risk_level,
        term_days: product.term_days,
        bucket: product.bucket,
        benchmark: product.benchmark,
        min_amount: product.min_amount,
        fee_bps: product.fee_bps,
        data_date: product.data_date,
        next_open_date: product.next_open_date,
        history_months: product.history_months,
        evidence_tier: evidenceTier,
        evidence_label: evidencePolicy.label,
        evidence_single_cap_pct: evidencePolicy.single_pct,
        evidence_single_cap_amount: evidenceSingleCapAmount,
        selection_score: product.selection_score,
        return_1m: product.return_1m,
        return_3m: product.return_3m,
        return_6m: product.return_6m,
        return_1y: product.return_1y,
        return_since_inception: product.return_since_inception,
        yield_pct: yieldPct,
        yield_gap_pp: yieldGapPp,
        term_gap_days:
          currentTermDays === null ? null : round(product.term_days - currentTermDays, 0),
        comparison_days: comparisonDays,
        purchase_confirm_days:
          numberOrNull(candidateSetting?.purchase_confirm_days) ??
          DEFAULT_PURCHASE_CONFIRM_DAYS,
        switch_wait_days: switchWait.value,
        switch_wait_status: switchWait.status,
        switch_wait_source: switchWait.source,
        effective_days: result?.new_days ?? null,
        rollover_gap_days: ROLLOVER_GAP_DAYS,
        min_gain_amount: candidateMinGainAmount,
        min_gain_rule_pct: MIN_GAIN_RULE_PCT,
        min_gain_base_days: MIN_GAIN_BASE_DAYS,
        min_gain_floor: MIN_GAIN_FLOOR,
        quota_available: quota.available,
        quota_max_order: quota.max_order,
        quota_window: quota.window,
        quota_verified_at: quota.verified_at,
        execution_ready:
          settingsComplete &&
          switchWait.status === 'verified' &&
          quota.available !== null &&
          quota.available > 0,
        verdict,
        verdict_label:
          verdict === 'replace'
            ? redemption.redeemable_now
              ? '可替换'
              : '到期后可替换'
            : verdict === 'watch'
              ? '观察'
              : redemption.redeemable_now
                ? '不划算'
                : '锁定期内',
        reasons: candidateReasons,
        data_gaps: candidateGaps,
        switch: result,
        product,
      };
    })
    .sort((a, b) => {
      const rank = { replace: 2, watch: 1, hold: 0 };
      return (
        rank[b.verdict] - rank[a.verdict] ||
        (b.yield_pct ?? -999) - (a.yield_pct ?? -999) ||
        (b.selection_score ?? -999) - (a.selection_score ?? -999) ||
        a.code.localeCompare(b.code)
      );
    })
    .slice(0, MAX_CANDIDATES);

  const replaceCandidate = candidates.find((item) => item.verdict === 'replace') || null;
  const watchCandidate = candidates.find((item) => item.verdict === 'watch') || null;
  let verdict = 'hold';
  if (!redemption.redeemable_now) {
    // Economics can be attractive, but a locked lot cannot be switched now.
    // Keep the current action as "hold" and surface the candidate as a
    // maturity plan instead of an executable replacement.
    verdict = 'hold';
  } else if (replaceCandidate) verdict = 'replace';
  else if (watchCandidate || dataGaps.length || reminder.level !== 'none') {
    verdict = 'watch';
  }

  let summary = '';
  if (!redemption.redeemable_now && replaceCandidate) {
    summary = `到期后首选 ${replaceCandidate.name}；届时按最新快照、额度和赎回规则重新比较，现在不能执行替换。`;
  } else if (!redemption.redeemable_now) {
    summary =
      redemption.state === 'window'
        ? `已进入到期处理窗口，最早 ${redemption.available_date} 到期；现在仍不可提前赎回，到期日再比较。`
        : '当前只能继续持有；到期前 14 天再复核。';
  } else if (verdict === 'replace' && replaceCandidate) {
    summary = `建议替换为 ${replaceCandidate.name}：统一比较 ${horizonDays} 天，切换等待 ${replaceCandidate.switch_wait_days} 天${replaceCandidate.switch_wait_status === 'estimated' ? '（估算）' : ''}，有效计息 ${replaceCandidate.switch?.new_days ?? 0} 天，扣费后预计多赚 ¥${
      replaceCandidate.switch?.difference?.toFixed(2) ?? '0.00'
    }。执行前核对额度与赎回规则。`;
  } else if (verdict === 'watch') {
    const reason = watchCandidate?.reasons?.[0] || dataGaps[0] || reminder.text;
    summary = `${reason}。先核对数据，再决定是否动仓。`;
  } else {
    summary = `${
      isDailyOpen ? '短期限' : '同期限'
    }候选未达到替换门槛，继续持有；本桶统一比较 ${horizonDays} 天，初始切换等待按候选产品单独核验，后续到期自动续作。`;
  }

  const decision =
    (Array.isArray(decisions) ? decisions : []).find((item) => {
      const meta = item.review_meta || {};
      if (meta.holding_lot_id && meta.holding_lot_id === holding.lot_id) return true;
      return Boolean(
        meta.holding_code && meta.holding_code === holding.product_code,
      );
    }) || null;

  return {
    holding_id: holding.id,
    lot_id: holding.lot_id || `${holding.id}:${holding.product_code}`,
    product_code: holding.product_code,
    product_name: holding.product_name,
    issuer: holding.issuer,
    risk_level: holding.risk_level,
    amount,
    term_days: currentTermDays,
    bucket,
    maturity_date: maturityDate,
    days_to_maturity: daysToMaturity,
    next_open_date: nextOpenDate,
    days_to_open: daysToOpen,
    next_redeem_open_date: redemptionOpenDate,
    days_to_redeem_open: daysToRedemptionOpen,
    horizon_days: horizonDays,
    current: {
      found: Boolean(currentProduct),
      product_code: holding.product_code,
      return_1m: currentProduct?.return_1m ?? null,
      return_3m: currentProduct?.return_3m ?? null,
      return_6m: currentProduct?.return_6m ?? null,
      return_1y: currentProduct?.return_1y ?? null,
      return_since_inception: currentProduct?.return_since_inception ?? null,
      yield_pct: currentYieldPct,
      fee_bps: currentProduct?.fee_bps ?? null,
      data_date: currentProduct?.data_date || '',
      benchmark: currentProduct?.benchmark || '',
    },
    review_setting: {
      redemption_days: numberOrNull(setting?.redemption_days),
      arrival_days: numberOrNull(setting?.arrival_days),
      redemption_fee_bps: redemptionFeeBps,
      purchase_fee_bps: purchaseFeeBps,
      purchase_confirm_days: numberOrNull(setting?.purchase_confirm_days),
      rollover_gap_days: ROLLOVER_GAP_DAYS,
      min_gain_rule_pct: MIN_GAIN_RULE_PCT,
      min_gain_base_days: MIN_GAIN_BASE_DAYS,
      min_gain_floor: MIN_GAIN_FLOOR,
      next_redeem_open_date: redemptionOpenDate,
      notes: String(setting?.notes || ''),
      verified_at: String(setting?.verified_at || ''),
      complete: settingsComplete,
    },
    thresholds: {
      min_yield_edge_pp: MIN_YIELD_EDGE_PP,
      break_even_margin_pp: BREAK_EVEN_MARGIN_PP,
      min_gain_amount: round(minGainAmount, 2),
      min_gain_rule_pct: MIN_GAIN_RULE_PCT,
      min_gain_base_days: MIN_GAIN_BASE_DAYS,
      min_gain_floor: MIN_GAIN_FLOOR,
      horizon_days: horizonDays,
      rollover_gap_days: ROLLOVER_GAP_DAYS,
    },
    reminders,
    reminder,
    redemption,
    data_gaps: dataGaps,
    candidates,
    verdict,
    verdict_label:
      !redemption.redeemable_now
        ? '继续持有（锁定期）'
        : verdict === 'replace'
          ? '建议替换'
          : verdict === 'watch'
            ? '观察'
            : '继续持有',
    summary,
    planned_action:
      !redemption.redeemable_now && replaceCandidate
        ? {
            action: 'replace_at_maturity',
            candidate_code: replaceCandidate.code,
            candidate_name: replaceCandidate.name,
            available_date: redemption.available_date,
            reason: redemption.reason,
          }
        : null,
    top_candidate_code: replaceCandidate?.code || candidates[0]?.code || null,
    decision,
    evidence_date: snapshot,
    verify_date: addDays(today, Math.min(30, Math.max(7, horizonDays))),
    generated_at: new Date().toISOString(),
  };
}

function buildHoldingReviews({
  holdings = [],
  products = [],
  universe = [],
  principal = null,
  settingsByCode = {},
  quotaByCode = {},
  today,
  snapshotDate = '',
  decisions = [],
}) {
  return holdings
    .filter((holding) => Number(holding.amount) > 0)
    .map((holding) =>
      buildHoldingReview({
        holding,
        products,
        universe,
        principal,
        setting: settingsByCode[holding.product_code] || null,
        settingsByCode,
        quotaByCode,
        today,
        snapshotDate,
        decisions,
      }),
    );
}

module.exports = {
  BUCKET_COMPARISON_DAYS,
  BREAK_EVEN_MARGIN_PP,
  DEFAULT_ARRIVAL_DAYS,
  DEFAULT_PURCHASE_CONFIRM_DAYS,
  DEFAULT_REDEMPTION_DAYS,
  MIN_YIELD_EDGE_PP,
  MIN_GAIN_BASE_DAYS,
  MIN_GAIN_FLOOR,
  MIN_GAIN_RULE_PCT,
  ROLLOVER_GAP_DAYS,
  addDays,
  buildHoldingReview,
  buildHoldingReviews,
  calculateSwitch,
  comparisonDaysForBucket,
  daysBetween,
  dynamicMinGainAmount,
  referenceYield,
  reviewBucketForTerm,
  resolveSwitchWaitDays,
};
