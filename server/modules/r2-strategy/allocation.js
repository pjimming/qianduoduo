'use strict';

const solver = require('javascript-lp-solver');
const { CONTRACT, CONTRACT_HASH, fingerprint, freeze } = require('./contract');
const { identityKey } = require('./evidence');
const { bucketForTerm } = require('../../../lib/yield-policy');
const { isoDate } = require('../r2-screening/calendar');

const BUCKETS = ['short', 'medium', 'long'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const safe = value => Number.isSafeInteger(value) && value >= 0;
const pct = (cents, percent) => Number(BigInt(cents) * BigInt(Math.round(percent * 100)) / 10000n);
const sum = rows => rows.reduce((total, row) => total + row, 0);

// Pure integer-cent allocation. Input limits must be derived by a service from
// explicit same-share facts, not accepted as trusted HTTP request fields.
// No legacy CSV, selection_score, or reference-yield sorting is used here.
function allocateV9({ context, account, limits = {}, settings = {} }, { solve = model => solver.Solve(model), timeoutMs = 2000, clock = Date.now } = {}) {
  const started = clock();
  const blockers = [];
  const excluded = [];
  const rows = [];
  const principal = account?.principal_cents;
  if (!safe(principal) || principal === 0 || principal > 1e14) blockers.push('principal_unavailable');
  if (!context?.available || context.contract_hash !== CONTRACT_HASH || !context.fingerprint) blockers.push('evidence_unavailable');
  const exposures = account?.exposures ?? [];
  const blockedCash = account?.blocked_cash_cents ?? 0;
  if (account?.verified === false || account?.blockers?.length) blockers.push('account_unverified');
  if (!Array.isArray(exposures) || exposures.length > 20000 || !safe(blockedCash)) blockers.push('account_invalid');
  const exposureKeys = new Set();
  for (const exposure of Array.isArray(exposures) ? exposures : []) {
    if (!safe(exposure.amount_cents) || !exposure.key || exposureKeys.has(exposure.key) ||
        !['cash', ...BUCKETS].includes(exposure.bucket) || !exposure.product_key || !exposure.family_key ||
        !['full_1y', 'six_month', 'three_month', 'one_month', 'no_data'].includes(exposure.evidence_tier)) blockers.push('exposure_unverified');
    exposureKeys.add(exposure.key);
  }
  const committed = sum((Array.isArray(exposures) ? exposures : []).map(row => row.amount_cents));
  if (!safe(committed) || (safe(principal) && committed + blockedCash > principal)) blockers.push('account_overcommitted');
  const available = safe(principal) && safe(committed) && safe(blockedCash) ? Math.max(0, principal - committed - blockedCash) : 0;
  const singlePct = settings.max_single_pct ?? CONTRACT.max_single_pct;
  const liquidityPct = settings.liquidity_floor_pct ?? CONTRACT.liquidity_floor_pct;
  if (!Number.isFinite(singlePct) || singlePct < 25 || singlePct > CONTRACT.max_single_pct ||
      !Number.isFinite(liquidityPct) || liquidityPct < CONTRACT.liquidity_floor_pct || liquidityPct > 100) blockers.push('settings_invalid');
  const cashNeeds = settings.cash_needs ?? [];
  if (!Array.isArray(cashNeeds) || cashNeeds.length > 12 || cashNeeds.some(need => !isoDate(need.by_date) || !safe(need.required_cents))) blockers.push('cash_needs_invalid');
  if (context?.rows?.length > 20000) blockers.push('candidate_limit');
  const seen = new Set();
  if (!blockers.length) for (const row of context.rows) {
    const key = identityKey(row.identity);
    if (seen.has(key)) { blockers.push('duplicate_candidate'); break; }
    seen.add(key);
    if (!row.automatic_eligible) { excluded.push({ identity: row.identity, reasons: row.blockers }); continue; }
    const limit = limits[key];
    const reasons = [];
    if (!limit || !safe(limit.minimum_cents) || !safe(limit.increment_cents) || limit.increment_cents < 1 ||
        !safe(limit.available_cents) || !limit.family_key || !limit.product_key ||
        typeof limit.liquidity_eligible !== 'boolean') reasons.push('allocation_limits_unverified');
    if (!Number.isSafeInteger(row.rank) || row.rank < 1 || !row.mapping || row.quota?.status !== 0 ||
        row.yield_state !== 'pass' || row.reference?.status !== 'available' ||
        !['full_1y', 'six_month', 'three_month'].includes(row.evidence_tier)) reasons.push('candidate_inconsistent');
    if (reasons.length) { excluded.push({ identity: row.identity, reasons }); continue; }
    const bucket = bucketForTerm(row.term.days);
    if (!BUCKETS.includes(bucket) || row.term.days > CONTRACT.max_term_days) { excluded.push({ identity: row.identity, reasons: ['term_invalid'] }); continue; }
    const minimum = Math.max(1, limit.minimum_cents);
    const maximum = Math.min(available, limit.available_cents, limit.max_order_cents ?? available);
    if (!safe(maximum) || maximum < minimum) { excluded.push({ identity: row.identity, reasons: ['quota_below_minimum'] }); continue; }
    rows.push({ key, identity: row.identity, rank: row.rank, bucket, group: `${row.term.days}/${row.category}`,
      category: row.category, term_days: row.term.days, tier: row.evidence_tier, reference: row.reference,
      minimum, increment: limit.increment_cents, maximum, limit, evidence_hash: row.evidence_hash });
  }
  rows.sort((a, b) => a.term_days - b.term_days || compare(a.category, b.category) || a.rank - b.rank || compare(a.key, b.key));
  // Solve each coupled model in a bounded worker use case. No truncation of the
  // candidate set: an oversized model is explicitly pending capacity review.
  if (rows.length > 128) blockers.push('allocation_model_limit');
  const base = { version: CONTRACT.allocation_policy_version, contract_hash: CONTRACT_HASH, date: context?.date ?? null,
    source_fingerprint: context?.fingerprint ?? null, account_fingerprint: account ? fingerprint(account) : null,
    principal_cents: principal ?? null, committed_cents: committed, blocked_cash_cents: blockedCash,
    available_cents: available, rows: [], excluded, allocated_cents: 0,
    unallocated_cents: available + (safe(blockedCash) ? blockedCash : 0), blockers: [...new Set(blockers)],
    status: 'pending', full_investment: false, executable: false };
  const done = value => freeze({ ...value, fingerprint: fingerprint(value) });
  if (blockers.length) return done(base);

  const existing = (field, key) => sum(exposures.filter(row => row[field] === key).map(row => row.amount_cents));
  const bucketAmount = Object.fromEntries(BUCKETS.map(bucket => [bucket, existing('bucket', bucket)]));
  const existingViolations = [];
  const bucketLimits = Object.fromEntries(Object.entries(CONTRACT.bucket_caps_pct).map(([bucket, percent]) => {
    const limit = pct(principal, percent);
    const occupied = bucketAmount[bucket];
    if (occupied > limit) existingViolations.push(`existing_${bucket}_bucket_cap`);
    const actual = Array.isArray(account.actual_holdings) ? sum(account.actual_holdings.filter(row => row.bucket === bucket).map(row => row.amount_cents)) : null;
    return [bucket, { limit_cents: limit, occupied_cents: occupied, actual_cents: actual,
      remaining_cents: Math.max(0, limit - occupied), excess_cents: Math.max(0, occupied - limit) }];
  }));
  for (const [field, maximum, reason] of [['product_key', pct(principal, singlePct), 'existing_product_cap'],
    ['family_key', pct(principal, CONTRACT.max_strategy_family_pct), 'existing_family_cap']]) {
    for (const key of new Set(exposures.map(row => row[field]))) if (existing(field, key) > maximum) existingViolations.push(reason);
  }
  for (const [tier, cap] of Object.entries(CONTRACT.evidence_caps)) {
    if (existing('evidence_tier', tier) > pct(principal, cap.aggregate)) existingViolations.push('existing_evidence_tier_cap');
    for (const exposure of exposures.filter(row => row.evidence_tier === tier)) {
      if (existing('product_key', exposure.product_key) > pct(principal, cap.single)) existingViolations.push('existing_evidence_single_cap');
    }
  }
  const existingLiquid = sum(exposures.filter(row => row.liquidity_eligible === true).map(row => row.amount_cents));
  const budgets = {};
  for (const bucket of BUCKETS) {
    budgets[bucket] = Math.min(available, bucketLimits[bucket]?.remaining_cents ?? available);
  }
  const model = { optimize: 'invested', opType: 'max', constraints: { total: { max: available } },
    variables: {}, ints: {}, binaries: {}, options: { timeout: timeoutMs, tolerance: 0, exitOnCycles: true } };
  const capacities = new Map();
  const addCapacity = (key, max, description) => {
    model.constraints[key] = { max: Math.max(0, max) };
    capacities.set(key, { maximum_cents: Math.max(0, max), ...description });
  };
  for (const bucket of BUCKETS) addCapacity(`bucket_${bucket}`, budgets[bucket], { type: 'bucket_budget', bucket });
  const add = (name, variable, amount) => { variable[name] = (variable[name] ?? 0) + amount; };
  const capIndex = new Map();
  const capKey = (type, value) => {
    const key = JSON.stringify([type, value]);
    if (!capIndex.has(key)) capIndex.set(key, `cap_${capIndex.size}`);
    return capIndex.get(key);
  };
  const memberships = rows.map((row, index) => {
    const product = capKey('product', row.limit.product_key);
    const family = capKey('family', row.limit.family_key);
    const tier = CONTRACT.evidence_caps[row.tier];
    addCapacity(product, pct(principal, singlePct) - existing('product_key', row.limit.product_key), { type: 'product', key: row.limit.product_key });
    addCapacity(family, pct(principal, CONTRACT.max_strategy_family_pct) - existing('family_key', row.limit.family_key), { type: 'family', key: row.limit.family_key });
    const keys = ['total', `bucket_${row.bucket}`, product, family];
    if (tier) {
      const evidence = capKey('tier', row.tier);
      addCapacity(evidence, pct(principal, tier.aggregate) - existing('evidence_tier', row.tier), { type: 'evidence_tier', key: row.tier });
      keys.push(evidence);
      // The evidence-tier single cap applies to the same registered product,
      // including holdings of other mapped sales shares.
      const single = capKey('tier_product', row.limit.product_key);
      addCapacity(single, pct(principal, tier.single) - existing('product_key', row.limit.product_key), { type: 'evidence_single', key: row.limit.product_key });
      keys.push(single);
    }
    const y = {}, z = {};
    for (const key of keys) { y[key] = row.minimum; z[key] = row.increment; }
    y.invested = row.minimum; z.invested = row.increment;
    model.constraints[`bound_${index}`] = { max: 0 };
    y[`bound_${index}`] = -Math.floor((row.maximum - row.minimum) / row.increment);
    z[`bound_${index}`] = 1;
    const singleLimit = tier ? pct(principal, tier.single) - existing('product_key', row.limit.product_key) : row.maximum;
    if (singleLimit < row.minimum) { model.constraints[`disabled_${index}`] = { max: 0 }; y[`disabled_${index}`] = 1; }
    model.variables[`y_${index}`] = y; model.binaries[`y_${index}`] = 1;
    model.variables[`z_${index}`] = z; model.ints[`z_${index}`] = 1;
    return keys;
  });
  const addRequirement = (name, required, accepts) => {
    const already = sum(exposures.filter(accepts).map(row => row.amount_cents));
    model.constraints[name] = { min: Math.max(0, required - already) };
    rows.forEach((row, i) => {
      if (accepts(row.limit)) { add(name, model.variables[`y_${i}`], row.minimum); add(name, model.variables[`z_${i}`], row.increment); }
    });
  };
  addRequirement('liquidity', pct(principal, liquidityPct), row => row.liquidity_eligible === true);
  cashNeeds.forEach((need, index) => {
    const name = `cash_need_${index}`;
    const arrives = row => isoDate(row.available_on) && row.available_on <= need.by_date;
    const already = sum(exposures.filter(arrives).map(row => row.amount_cents));
    model.constraints[name] = { min: need.required_cents - already - available };
    rows.forEach((row, i) => {
      if (arrives(row.limit)) return;
      add(name, model.variables[`y_${i}`], -row.minimum);
      add(name, model.variables[`z_${i}`], -row.increment);
    });
  });

  let solveCount = 0;
  let exhausted = false;
  function run() {
    const left = timeoutMs - (clock() - started);
    if (left <= 0) { exhausted = true; return null; }
    model.options.timeout = left;
    solveCount++;
    try {
      const result = solve(model);
      if (clock() - started >= timeoutMs) exhausted = true;
      return result;
    } catch { return null; }
  }
  function amounts(result) {
    if (!result?.feasible || result.bounded === false) return null;
    const values = [];
    for (let i = 0; i < rows.length; i++) {
      const y = result[`y_${i}`] ?? 0, z = result[`z_${i}`] ?? 0;
      if (!Number.isFinite(y) || !Number.isFinite(z) || Math.abs(y - Math.round(y)) > 1e-6 ||
          Math.abs(z - Math.round(z)) > 1e-6 || ![0, 1].includes(Math.round(y)) || z < 0) return null;
      const value = rows[i].minimum * Math.round(y) + rows[i].increment * Math.round(z);
      if (!safe(value) || value > rows[i].maximum || (Math.round(y) === 0 && value !== 0)) return null;
      values.push(value);
    }
    // Re-evaluate every model constraint independently with rounded integer
    // variables. Never trust LP tolerances to decide a financial boundary.
    const rounded = Object.fromEntries(Object.keys(model.variables).map(key => [key, Math.round(result[key] ?? 0)]));
    for (const [key, bound] of Object.entries(model.constraints)) {
      const value = sum(Object.entries(model.variables).map(([variable, fields]) => (fields[key] ?? 0) * rounded[variable]));
      if ((bound.min !== undefined && value < bound.min) || (bound.max !== undefined && value > bound.max) ||
          (bound.equal !== undefined && value !== bound.equal)) return null;
    }
    return values;
  }
  let solution = run();
  let values = amounts(solution);
  let requirementsPassed = true;
  if (!values) {
    // Diagnostic allocation may show the funding gap, but removing a lower
    // bound NEVER turns a failed liquidity/cash-flow plan into a valid plan.
    requirementsPassed = false;
    for (const key of Object.keys(model.constraints)) if (key === 'liquidity' || key.startsWith('cash_need_')) delete model.constraints[key];
    solution = run(); values = amounts(solution);
  }
  if (!values) return done({ ...base, blockers: [exhausted ? 'solver_budget_exhausted' : 'allocation_not_verified'],
    solver: { name: 'javascript-lp-solver@1.0.3', calls: solveCount }, bucket_budgets_cents: budgets });
  const invested = sum(values);
  model.constraints.total = { equal: invested };
  model.optimize = 'short_invested';
  rows.forEach((row, index) => {
    if (row.bucket !== 'short') return;
    model.variables[`y_${index}`].short_invested = row.minimum;
    model.variables[`z_${index}`].short_invested = row.increment;
  });
  const shortValues = amounts(run());
  if (!shortValues) return done({ ...base, bucket_limits: bucketLimits,
    blockers: [exhausted ? 'solver_budget_exhausted' : 'allocation_preferences_not_verified'] });
  values = shortValues;
  model.constraints.short_invested = { equal: sum(rows.map((row, index) => row.bucket === 'short' ? values[index] : 0)) };

  // At fixed invested amount, prefer equal group budgets. Then optimize each
  // original v9-ranked share in stable group order while preserving all prior
  // objectives. This never sorts unrelated groups by yield.
  const groups = [...new Set(rows.map(row => row.group))];
  for (const bucket of BUCKETS) {
    const peers = groups.filter(group => rows.find(row => row.group === group).bucket === bucket);
    peers.forEach((group, ordinal) => {
      const id = groups.indexOf(group), key = `group_${id}`;
      const target = Math.floor(budgets[bucket] / peers.length) + (ordinal < budgets[bucket] % peers.length ? 1 : 0);
      model.constraints[key] = { equal: target };
      rows.forEach((row, index) => {
        if (row.group === group) { model.variables[`y_${index}`][key] = row.minimum; model.variables[`z_${index}`][key] = row.increment; }
      });
      model.variables[`under_${id}`] = { [key]: 1, fairness: -1 };
      model.variables[`over_${id}`] = { [key]: -1, fairness: -1 };
      model.ints[`under_${id}`] = 1; model.ints[`over_${id}`] = 1;
    });
  }
  model.optimize = 'fairness';
  const fairResult = run(), fairValues = amounts(fairResult);
  let preferencesComplete = false;
  if (fairValues) {
    values = fairValues;
    const fairness = sum(groups.map((_, index) => -Math.round(fairResult[`under_${index}`] ?? 0) - Math.round(fairResult[`over_${index}`] ?? 0)));
    model.constraints.fairness = { equal: fairness };
    for (let index = 0; index < rows.length; index++) {
      model.optimize = `rank_${index}`;
      model.variables[`y_${index}`][model.optimize] = rows[index].minimum;
      model.variables[`z_${index}`][model.optimize] = rows[index].increment;
      const ranked = run(), rankedValues = amounts(ranked);
      if (!rankedValues) break;
      values = rankedValues;
      model.constraints[model.optimize] = { equal: values[index] };
      if (index === rows.length - 1) preferencesComplete = true;
    }
    if (!rows.length) preferencesComplete = true;
  }
  const allocated = sum(values);
  const resultRows = rows.map((row, index) => ({ identity: row.identity, group: row.group, rank: row.rank,
    amount_cents: values[index], evidence_hash: row.evidence_hash, quota_basis: row.limit.quota_basis ?? null,
    reason: values[index] > 0 ? row.rank > 3 ? 'ranked_reserve_used' : 'ranked_candidate_used' : 'constraints_or_rank',
    tight_constraints: memberships[index].filter(key => model.constraints[key]?.max !== undefined &&
      sum(rows.map((_, i) => memberships[i].includes(key) ? values[i] : 0)) === model.constraints[key].max) }));
  const liquidAfter = existingLiquid + sum(rows.map((row, index) => row.limit.liquidity_eligible ? values[index] : 0));
  preferencesComplete = preferencesComplete && !exhausted;
  const full = requirementsPassed && allocated === available && blockedCash === 0 && !existingViolations.length && preferencesComplete;
  return done({ ...base, rows: resultRows, allocated_cents: allocated, unallocated_cents: available - allocated + blockedCash,
    status: full ? 'simulation_passed' : !preferencesComplete ? 'pending' : 'no_feasible_full_allocation', full_investment: full,
    blockers: full ? [] : [...new Set(existingViolations), ...(!preferencesComplete ? ['allocation_preferences_not_verified'] : []), ...(!requirementsPassed ? ['liquidity_or_cashflow_conflict'] : []),
      ...(allocated < available ? ['capacity_or_increment_gap'] : []), ...(blockedCash ? ['cash_in_transit'] : [])],
    bucket_budgets_cents: budgets, bucket_limits: bucketLimits, liquidity_cents: liquidAfter, liquidity_required_cents: pct(principal, liquidityPct),
    constraints: Object.fromEntries(capacities),
    solver: { name: 'javascript-lp-solver@1.0.3', calls: solveCount, preference_complete: preferencesComplete } });
}

module.exports = { allocateV9, pct };
