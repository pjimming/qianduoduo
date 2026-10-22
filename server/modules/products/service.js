'use strict';

const { parseYmd, todayShanghai } = require('../../../lib/metrics');
const {
  DAILY_OPEN_TARGET_PCT,
} = require('../../../lib/r2-policy');

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function createProductsService(repository, options = {}) {
  if (!repository) throw new Error('products 服务需要 repository');
  const todayProvider = options.todayProvider || todayShanghai;

  function refresh(productCsvPath) {
    return repository.refreshProducts(productCsvPath);
  }

  function validateAllocationInput(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw validationError('分配设置格式不正确');
    }
    if (
      body.principal_override !== null &&
      body.principal_override !== undefined &&
      body.principal_override !== ''
    ) {
      const principal = Number(body.principal_override);
      if (!Number.isFinite(principal) || principal < 0 || principal > 1e12) {
        throw validationError('可投资本金需要是 0 以上的数字');
      }
    }
    if (
      body.daily_open_target_pct !== undefined &&
      Number(body.daily_open_target_pct) !== DAILY_OPEN_TARGET_PCT
    ) {
      throw validationError(
        `本项目新增日开额度固定为 ${DAILY_OPEN_TARGET_PCT}%`,
      );
    }
    const ranges = {
      liquidity_floor_pct: [0, 100],
      max_single_pct: [25, 30],
      max_issuer_pct: [40, 100],
      target_slice_pct: [5, 25],
      cashflow_0_3: [0, 1e12],
      cashflow_3_6: [0, 1e12],
      cashflow_6_12: [0, 1e12],
    };
    for (const [key, [min, max]] of Object.entries(ranges)) {
      if (
        body[key] === undefined ||
        body[key] === null ||
        body[key] === ''
      ) {
        continue;
      }
      const value = Number(body[key]);
      if (!Number.isFinite(value) || value < min || value > max) {
        throw validationError(`${key} 需要在 ${min}–${max} 之间`);
      }
    }
    const targets = body.bucket_targets;
    if (targets !== undefined) {
      if (
        !targets ||
        typeof targets !== 'object' ||
        Array.isArray(targets)
      ) {
        throw validationError('期限桶目标格式不正确');
      }
      let total = 0;
      for (const key of ['short', 'medium', 'long']) {
        const value = Number(targets[key] ?? 0);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          throw validationError('期限桶目标需要是 0–100 的数字');
        }
        total += value;
      }
      if (total > 100.001) {
        throw validationError('期限桶目标合计不能超过 100%');
      }
    }
    if (body.quota_by_code !== undefined) {
      if (
        !body.quota_by_code ||
        typeof body.quota_by_code !== 'object' ||
        Array.isArray(body.quota_by_code)
      ) {
        throw validationError('产品额度格式不正确');
      }
      for (const [code, quota] of Object.entries(body.quota_by_code)) {
        if (!code || code.length > 80) {
          throw validationError('产品代码格式不正确');
        }
        if (!quota || typeof quota !== 'object' || Array.isArray(quota)) {
          throw validationError('单只产品额度格式不正确');
        }
        for (const key of ['available', 'max_order']) {
          if (
            quota[key] === null ||
            quota[key] === undefined ||
            quota[key] === ''
          ) {
            continue;
          }
          const value = Number(quota[key]);
          if (!Number.isFinite(value) || value < 0 || value > 1e12) {
            throw validationError('产品额度需要是 0 以上的数字');
          }
        }
      }
    }
  }

  function saveAllocationSettings(body) {
    validateAllocationInput(body);
    return repository.saveAllocationSettings(body);
  }

  function saveHoldingReviewSetting(productCode, body) {
    const code = decodeURIComponent(productCode).trim();
    if (!code || code.length > 80) {
      throw validationError('产品代码格式不正确');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw validationError('持仓复核口径格式不正确');
    }
    const deprecatedFields = [
      'idle_days',
      'compare_horizon_days',
      'min_gain_amount',
    ];
    const deprecatedField = deprecatedFields.find((key) =>
      Object.prototype.hasOwnProperty.call(body, key),
    );
    if (deprecatedField) {
      throw validationError(
        `${deprecatedField} 已停用，请使用统一期限和动态门槛`,
      );
    }
    const integerRanges = {
      redemption_days: [0, 30],
      arrival_days: [0, 30],
      purchase_confirm_days: [0, 30],
    };
    for (const [key, [min, max]] of Object.entries(integerRanges)) {
      if (body[key] === undefined) continue;
      if (body[key] === null || body[key] === '') continue;
      const value = Number(body[key]);
      if (!Number.isInteger(value) || value < min || value > max) {
        throw validationError(`${key} 需要是 ${min}–${max} 的整数`);
      }
    }
    const feeRanges = {
      redemption_fee_bps: [0, 500],
      purchase_fee_bps: [0, 500],
    };
    for (const [key, [min, max]] of Object.entries(feeRanges)) {
      if (
        body[key] === undefined ||
        body[key] === null ||
        body[key] === ''
      ) {
        continue;
      }
      const value = Number(body[key]);
      if (!Number.isFinite(value) || value < min || value > max) {
        throw validationError(`${key} 需要在 ${min}–${max} 之间`);
      }
    }
    const notes = body.notes === undefined ? undefined : String(body.notes);
    if (notes !== undefined && notes.length > 1000) {
      throw validationError('赎回规则备注不能超过 1000 个字符');
    }
    const verifiedAt =
      body.verified_at === undefined
        ? undefined
        : String(body.verified_at).trim();
    if (verifiedAt) {
      if (!parseYmd(verifiedAt)) {
        throw validationError('核验日期格式应为 YYYY-MM-DD');
      }
      if (verifiedAt > todayProvider()) {
        throw validationError('核验日期不能晚于今天');
      }
    }
    const redeemOpenDate =
      body.next_redeem_open_date === undefined
        ? undefined
        : String(body.next_redeem_open_date).trim();
    if (redeemOpenDate && !parseYmd(redeemOpenDate)) {
      throw validationError('下一赎回开放日格式应为 YYYY-MM-DD');
    }
    return repository.saveHoldingReviewSetting({
      ...body,
      product_code: code,
      notes,
      verified_at: verifiedAt,
      next_redeem_open_date: redeemOpenDate,
    });
  }

  return {
    refresh,
    saveAllocationSettings,
    saveHoldingReviewSetting,
    validateAllocationInput,
  };
}

module.exports = {
  createProductsService,
};
