export type LedgerAction = '无操作' | '买入' | '赎回' | '切换'
export type CapitalEventType = 'deposit' | 'withdraw'
export type ProductBucket = 'cash' | 'short' | 'medium' | 'long' | 'unknown'
export type ProductEvidenceTier =
  | 'full_1y'
  | 'six_month'
  | 'three_month'
  | 'one_month'
  | 'no_data'
export type TermFilter = 'all' | ProductBucket
export type SortDirection = 'asc' | 'desc'
export type LedgerSortKey =
  | 'date'
  | 'holding_amount'
  | 'daily_pnl'
  | 'daily_return'
  | 'net_value'
export type ProductSortKey =
  | 'term'
  | 'return_1m'
  | 'return_3m'
  | 'return_6m'
  | 'return_1y'
  | 'reference_yield_pct'
  | 'weighted_yield_pct'
export type RangeValue = 7 | 30 | 90 | 'all'

export interface LedgerRecord {
  id?: number
  date: string
  principal: number
  holding_amount: number
  daily_pnl: number
  action: LedgerAction
  notes: string
  cumulative_pnl: number
  net_value: number
  daily_return: number
  nav_index: number
  drawdown: number
}

export interface RawLedgerRecord {
  id?: number
  date: string
  principal: number
  daily_pnl: number
  action: LedgerAction
  notes: string
  source?: 'manual' | 'income-screenshot' | string
  screenshot_id?: number | null
}

export interface DataTrustRevision {
  id: number
  fact_type: string
  fact_key: string
  revision_no: number
  action: 'create' | 'update' | 'delete' | 'confirm' | 'cancel' | 'recalculate'
  before: Record<string, unknown>
  after: Record<string, unknown>
  changed_fields: string[]
  reason: string
  source_class: string
  actor_type: string
  actor_ref: string
  operation_id: string
  request_id: string
  related_fact_type: string
  related_fact_key: string
  created_at: string
}

export interface DataTrustEvidenceEvent {
  id: number
  evidence_id: number
  event_type: string
  actor_type: string
  actor_ref: string
  payload: Record<string, unknown>
  confidence: number | null
  dedupe_key: string
  request_id: string
  previous_event_id: number | null
  created_at: string
}

export interface DataTrustEvidenceSource {
  inbox_kind: 'income' | 'trade'
  inbox_id: number
  image_url: string
}

export interface DataTrustEvidenceTrace {
  evidence: {
    id: number
    evidence_type: string
    sha256: string
    original_name: string
    mime: string
    bytes: number
    available: boolean
    status: string
    received_at: string
  }
  source: DataTrustEvidenceSource | null
  events: DataTrustEvidenceEvent[]
  fact_links: DataTrustEvidenceLink[]
}

export interface DataTrustEvidenceLink {
  id: number
  fact_type: string
  fact_key: string
  fact_revision_id: number
  evidence_id: number
  evidence_event_id: number
  role: string
  field_paths: string[]
  confidence: number | null
  link_status: string
  created_at: string
  retired_at: string | null
  retire_reason: string
  evidence?: DataTrustEvidenceTrace['evidence'] & {
    source?: DataTrustEvidenceSource | null
  }
  evidence_event?: {
    event_type: string
    actor_type: string
    actor_ref: string
    payload: Record<string, unknown>
    confidence: number | null
    created_at: string
  }
  evidence_trace?: DataTrustEvidenceTrace
}

export interface DataTrustFactTrace {
  fact_type: string
  fact_key: string
  evidence_status: 'complete' | 'partial' | 'incomplete'
  revisions: DataTrustRevision[]
  evidence_links: DataTrustEvidenceLink[]
}

export interface DataTrustTraceResponse {
  fact_trace: DataTrustFactTrace
}

export interface CapitalEvent {
  id: number
  date: string
  type: CapitalEventType
  amount: number
  note: string
  principal_after: number
}

export interface CapitalState {
  initialized: boolean
  initial_principal: number | null
  initial_date: string | null
  current_principal: number
  total_deposits: number
  total_withdrawals: number
  as_of: string
  events: CapitalEvent[]
}

export interface HoldingValuationItem {
  id: number
  snapshot_id: number
  product_code: string
  product_name: string
  market_value: number
  active_cost: number | null
  created_at: string
}

export interface HoldingValuationComponent {
  product_code: string
  product_name: string
  principal: number
  product_income: number
  current_value: number
  last_yield_date: string
  income_recorded: boolean
}

export type BankReconciliationStatus =
  | 'missing'
  | 'outdated'
  | 'matched'
  | 'rounding'
  | 'mismatch'

export interface BankHoldingReconciliation {
  available: boolean
  status: BankReconciliationStatus
  comparison_valid: boolean
  bank_value: number | null
  difference: number | null
  tolerance: number
  matched: boolean
  as_of_date: string | null
  as_of_at: string | null
  snapshot_id: number | null
  evidence_id: number | null
  notes: string
  stale_reasons: string[]
}

export interface CurrentHoldingsValuation {
  available: boolean
  status: 'current' | 'stale' | 'missing'
  value_source: 'confirmed_holdings_plus_product_income'
  current_value: number | null
  as_of_date: string | null
  as_of_at: string | null
  source: string | null
  notes: string
  evidence_id: number | null
  active_holding_count: number
  active_product_count: number
  active_cost: number
  product_income: number
  income_as_of_date: string | null
  income_product_count: number
  missing_income_product_codes: string[]
  components: HoldingValuationComponent[]
  market_gain: number | null
  pending_buy_count: number
  pending_buy_amount: number
  items: HoldingValuationItem[]
  items_complete: boolean
  stale_reasons: string[]
  latest_confirmed_change_date?: string | null
  snapshot_id?: number | null
  previous_value: number | null
  previous_as_of_date: string | null
  change_since_previous: number | null
  bank_reconciliation: BankHoldingReconciliation
}

export interface Summary {
  record_count: number
  first_date: string | null
  last_date: string | null
  calendar_days: number
  total_pnl: number
  avg_principal: number
  latest_principal: number
  avg_holding_amount: number
  latest_holding_amount: number
  latest_net_value: number
  latest_daily_pnl: number
  latest_daily_return: number
  latest_cumulative_pnl: number
  period_return: number
  period_return_pct: number
  annualized_pct: number | null
  max_drawdown: number
  max_drawdown_pct: number
  negative_days: number
  negative_day_ratio_pct: number
  best_day: number
  worst_day: number
  sample_sufficient: boolean
  target_annualized_pct: number
  target_gap_pct: number | null
  target_status: string
  nav_start: number
  nav_end: number
}

export interface MonthlyReview {
  month: string
  month_label: string
  first_date: string | null
  last_date: string | null
  has_records: boolean
  record_days: number
  calendar_days: number
  account_start_date: string | null
  active_start_date: string | null
  before_start_days: number
  is_before_start: boolean
  elapsed_days: number
  days_remaining: number
  missing_days: number
  recorded_dates: string[]
  missing_dates: string[]
  record_coverage_pct: number | null
  pnl: number
  avg_principal: number
  avg_holding_amount: number
  return_pct: number | null
  annualized_pct: number | null
  max_drawdown_pct: number
  negative_days: number
  positive_days: number
  negative_day_ratio_pct: number
  best_day: number
  worst_day: number
  target_month_pct: number
  target_mtd_pct: number
  target_progress_pct: number | null
  target_gap_pct: number | null
  projected_pct: number | null
  grade: string | null
  grade_preview: string | null
  grade_display: string
  grade_range: { low: string; high: string } | null
  sample_sufficient: boolean
  final: boolean
  is_current: boolean
  provisional: boolean
  records_needed_for_grade: number
  days_needed_for_grade: number
  grade_eligible: boolean
  score_status: 'no_records' | 'missing' | 'in_progress' | 'insufficient' | 'scored'
  action_count: number
  buy_count: number
  redeem_count: number
  switch_count: number
  compare: MonthlyComparison | null
}

export interface MonthlyComparison {
  prev_month: string
  prev_month_label: string
  pnl_delta: number
  return_delta_pp: number | null
  drawdown_delta_pp: number | null
  negative_ratio_delta_pp: number | null
  action_delta: number
}

export interface DailyReview {
  date: string
  principal: number
  holding_amount: number
  daily_pnl: number
  daily_return_pct: number
  action: string
  notes: string
  month: string
  month_pnl: number
  month_avg_principal: number
  month_avg_holding_amount: number
  month_return_pct: number | null
  month_grade: string
  month_grade_preview: string | null
  month_record_days: number
  month_missing_days: number
  month_target_progress_pct: number | null
  month_projected_pct: number | null
  provisional: boolean
}

export interface WeeklyReview {
  week_start: string
  week_end: string
  record_days: number
  elapsed_days: number
  missing_days: number
  pnl: number
  avg_principal: number
  avg_holding_amount: number
  return_pct: number | null
  negative_days: number
  positive_days: number
  best_day: number | null
  worst_day: number | null
  action_count: number
  buy_count: number
  redeem_count: number
  switch_count: number
  consecutive_negative_days: number
}

export interface ReviewAlert {
  level: 'info' | 'warn'
  code: string
  text: string
}

export interface ReviewData {
  thresholds: number[]
  target_annualized_pct: number
  target_month_pct: number
  account_start_date: string | null
  reporting_date: string
  reporting_lag_days: number
  daily: DailyReview | null
  weekly: WeeklyReview | null
  alerts: ReviewAlert[]
  current_month: MonthlyReview | null
  monthly: MonthlyReview[]
}

export type DecisionAction = '买入' | '赎回' | '切换' | '观察'
export type DecisionRating =
  | '待评估'
  | '流程正确，结果好'
  | '流程正确，结果差'
  | '流程错误，结果好'
  | '流程错误，结果差'

export interface DecisionCompleteness {
  complete: boolean
  status: 'complete' | 'incomplete'
  missing_fields: string[]
  missing_labels: string[]
}

export interface DecisionEntry {
  id: number
  date: string
  product_name: string
  action: DecisionAction
  reason: string
  expectation: string
  invalidation_condition: string
  actual_result: string
  strategy_version: string
  target_annualized: number
  bucket_plan: Record<string, number>
  evaluation_at: string[]
  evidence_date: string
  verify_date: string
  review_meta: Record<string, unknown>
  rating: DecisionRating
  created_at: string
  updated_at: string
}

export interface DecisionPrediction {
  schema_version: number
  series_id: string
  id: string
  version: number
  recommendation_type: string
  action: DecisionAction
  source: string
  source_ref: string
  created_at: string
  data_cutoff_at: string
  evidence_refs: Array<{
    type?: string
    ref?: string
    as_of?: string
    [key: string]: unknown
  }>
  confidence: number
  horizon: {
    start_date: string
    end_date: string
    days: number
  }
  baseline: {
    metric: string
    value: number | null
    label: string
    unit: string
  }
  expected: {
    direction: string
    target: {
      point: number | null
      min: number | null
      max: number | null
      unit: string
    }
  }
  evaluation: {
    metric: string
    method: string
    minimum_observations: number
    minimum_coverage_ratio: number
    tolerance_pp: number
    tolerance_abs: number
  }
  invalidation_condition: string
  invalidation_triggers: string[]
  review_date: string
  original_text: string
}

export interface DecisionPredictionResult {
  status:
    | 'hit'
    | 'miss'
    | 'invalidated'
    | 'not_executed'
    | 'insufficient_data'
    | 'pending_confirmation'
    | 'pending'
  classification: string
  reason_code: string
  detail: string
  evaluated_for: string
  data_as_of: string
  actual: number | null
  target: DecisionPrediction['expected']['target'] | null
  numeric_error: number | null
  evidence: Record<string, unknown>
  proposed_status?: 'hit' | 'miss'
  proposed_classification?: string
  proposed_reason_code?: string
  confirmed_at?: string
  confirmed_by?: string
}

export interface DecisionCalibrationRecord {
  prediction: DecisionPrediction
  prediction_versions: DecisionPrediction[]
  result: DecisionPredictionResult
  decision: {
    id: number
    product_name: string
    action: DecisionAction
    rating: DecisionRating
  } | null
  proposal: {
    id: number
    status: string
    title: string
    confidence: number
  } | null
}

export interface DecisionCalibrationGroup {
  key: string
  total: number
  evaluated: number
  hit: number
  miss: number
  invalidated: number
  insufficient_data: number
  not_executed: number
  pending: number
  pending_confirmation: number
  hit_rate: number | null
  mean_absolute_error: number | null
}

export interface DecisionCalibrationReport {
  month: string
  generated_for: string
  total: number
  by_type: DecisionCalibrationGroup[]
  by_confidence: DecisionCalibrationGroup[]
  by_action: DecisionCalibrationGroup[]
  by_horizon: DecisionCalibrationGroup[]
  error_sources: Array<{ source: string; count: number }>
  reason_codes: Array<{ code: string; count: number }>
  records: DecisionCalibrationRecord[]
}

export interface Holding {
  id: number
  product_name: string
  product_code: string
  issuer: string
  risk_level: 'R2' | 'PR2'
  amount: number
  purchase_date: string
  term_days: number | null
  maturity_date: string | null
  notes: string
  created_at: string
  updated_at: string
  lot_id?: string
  original_amount?: number
  allocated_principal?: number
  realized_pnl?: number
  source_trade_id?: number
}

export interface ProductDailyValuation {
  id: number
  valuation_date: string
  credit_date: string
  yield_date: string
  product_code: string
  product_name: string
  holding_amount: number | null
  daily_pnl: number
  source: string
  screenshot_id: number | null
  confidence: number
  notes: string
  created_at: string
  updated_at: string
}

export type ProductYieldLagSource =
  | 'default'
  | 'product-document'
  | 'app-rule'
  | 'user-confirmed'

export interface ProductYieldSetting {
  product_code: string
  yield_lag_days: number
  source: ProductYieldLagSource
  verified: boolean
  label: string
  notes: string
  verified_at: string
  updated_at: string
  expected_latest_yield_date?: string
  todays_yield_visible_date?: string
}

export interface ProductIncomeDisclosurePolicy {
  basis: string
  default_yield_lag_days: number
  reporting_lag_days: number
  reporting_date: string
  active_product_count: number
  unverified_product_codes: string[]
  products: ProductYieldSetting[]
}

export interface ProductValuationDay {
  yield_date: string
  daily_pnl: number
}

export interface ProductValuationSummary {
  product_code: string
  product_name: string
  status: 'active' | 'redeemed'
  active_amount: number
  latest_holding_amount: number | null
  first_yield_date: string
  last_yield_date: string
  holding_start: string
  holding_end: string
  holding_days: number
  observed_days: number
  cumulative_pnl: number
  negative_days: number
  latest_daily_pnl: number | null
  yield_lag_days: number
  yield_lag_source: ProductYieldLagSource
  yield_lag_verified: boolean
  yield_lag_label: string
  yield_lag_notes: string
  yield_lag_updated_at: string
  expected_latest_yield_date: string
  todays_yield_visible_date: string
  worst_day: ProductValuationDay | null
  best_day: ProductValuationDay | null
}

export interface ProductValuationReconciliationItem {
  account_date: string
  yield_dates: string[]
  product_pnl: number
  product_count: number
  account_pnl: number | null
  difference: number | null
  status: 'matched' | 'mismatch' | 'missing-account-total'
  message: string
  record_id: number | null
}

export interface ProductValuationReconciliation {
  items: ProductValuationReconciliationItem[]
  counts: {
    matched: number
    mismatch: number
    missing_account_total: number
  }
}

export interface ProductValuationAudit {
  id: number
  valuation_id: number
  action: 'create' | 'update'
  before: Partial<ProductDailyValuation>
  after: Partial<ProductDailyValuation>
  note: string
  source: string
  created_at: string
}

export interface ProductValuationDetail {
  summary: ProductValuationSummary | null
  yield_setting: ProductYieldSetting
  valuations: ProductDailyValuation[]
  audit: ProductValuationAudit[]
}

export type HoldingReviewVerdict = 'replace' | 'watch' | 'hold'

export interface HoldingReviewReminder {
  level: 'urgent' | 'window' | 'none'
  date: string
  kind: 'maturity' | 'open' | 'daily' | 'none'
  text: string
}

export interface HoldingReviewRedemption {
  state: 'locked' | 'window' | 'open' | 'matured' | 'daily_open' | 'unknown'
  redeemable_now: boolean
  available_date: string
  reason: string
}

export interface HoldingReviewPlannedAction {
  action: 'replace_at_maturity'
  candidate_code: string
  candidate_name: string
  available_date: string
  reason: string
}

export interface HoldingReviewSwitch {
  new_days: number
  current_gross: number
  redemption_fee: number
  new_gross: number
  purchase_fee: number
  new_net: number
  difference: number
  break_even_yield_pct: number | null
  fee_drag: number
}

export type HoldingReviewSwitchWaitStatus = 'verified' | 'estimated'

export interface HoldingReviewCandidate {
  code: string
  name: string
  issuer: string
  risk_level: string
  term_days: number | null
  bucket: ProductBucket
  benchmark: string
  min_amount: number | null
  fee_bps: number | null
  data_date: string
  next_open_date: string
  history_months: number | null
  evidence_tier: ProductEvidenceTier
  evidence_label: string
  evidence_single_cap_pct: number | null
  evidence_single_cap_amount: number | null
  selection_score: number | null
  return_1m: number | null
  return_3m: number | null
  return_6m: number | null
  return_1y: number | null
  return_since_inception: number | null
  yield_pct: number | null
  yield_gap_pp: number | null
  term_gap_days: number | null
  comparison_days: number
  purchase_confirm_days: number | null
  switch_wait_days: number | null
  switch_wait_status: HoldingReviewSwitchWaitStatus
  switch_wait_source: string
  effective_days: number | null
  rollover_gap_days: number
  min_gain_amount: number
  min_gain_rule_pct: number
  min_gain_base_days: number
  min_gain_floor: number
  quota_available: number | null
  quota_max_order: number | null
  quota_window: string
  quota_verified_at: string
  execution_ready: boolean
  verdict: HoldingReviewVerdict
  verdict_label: string
  reasons: string[]
  data_gaps: string[]
  switch: HoldingReviewSwitch | null
  product: Product
}

export interface HoldingReviewSetting {
  product_code: string
  redemption_days: number | null
  arrival_days: number | null
  redemption_fee_bps: number
  purchase_fee_bps: number
  purchase_confirm_days: number | null
  next_redeem_open_date: string
  notes: string
  verified_at: string
  updated_at: string
}

export interface HoldingReview {
  holding_id: number
  lot_id: string
  product_code: string
  product_name: string
  issuer: string
  risk_level: string
  amount: number
  term_days: number | null
  bucket: ProductBucket
  maturity_date: string | null
  days_to_maturity: number | null
  next_open_date: string
  days_to_open: number | null
  next_redeem_open_date: string
  days_to_redeem_open: number | null
  horizon_days: number
  current: {
    found: boolean
    product_code: string
    return_1m: number | null
    return_3m: number | null
    return_6m: number | null
    return_1y: number | null
    return_since_inception: number | null
    yield_pct: number | null
    fee_bps: number | null
    data_date: string
    benchmark: string
  }
  review_setting: {
    redemption_days: number | null
    arrival_days: number | null
    redemption_fee_bps: number
    purchase_fee_bps: number
    purchase_confirm_days: number | null
    rollover_gap_days: number
    min_gain_rule_pct: number
    min_gain_base_days: number
    min_gain_floor: number
    next_redeem_open_date: string
    notes: string
    verified_at: string
    complete: boolean
  }
  thresholds: {
    min_yield_edge_pp: number
    break_even_margin_pp: number
    min_gain_amount: number
    min_gain_rule_pct: number
    min_gain_base_days: number
    min_gain_floor: number
    horizon_days: number
    rollover_gap_days: number
  }
  reminders: HoldingReviewReminder[]
  reminder: HoldingReviewReminder
  redemption: HoldingReviewRedemption
  data_gaps: string[]
  candidates: HoldingReviewCandidate[]
  verdict: HoldingReviewVerdict
  verdict_label: string
  summary: string
  planned_action: HoldingReviewPlannedAction | null
  top_candidate_code: string | null
  decision: DecisionEntry | null
  evidence_date: string
  verify_date: string
  generated_at: string
}

export interface HoldingReviewsSummary {
  total: number
  replace: number
  watch: number
  hold: number
  window: number
}

export type TradeType = 'buy' | 'redeem' | 'switch'
export type TradeStatus = 'pending' | 'confirmed' | 'cancelled'

export interface TradeAllocation {
  id: number
  redeem_trade_id: number
  buy_trade_id: number
  principal: number
  realized_pnl: number
  days: number
  created_at: string
}

export interface TradeTransaction {
  id: number
  trade_date: string
  confirm_date: string | null
  trade_type: TradeType
  status: TradeStatus
  product_code: string
  product_name: string
  issuer: string
  risk_level: 'R2' | 'PR2'
  target_product_code: string
  target_product_name: string
  target_term_days: number | null
  target_maturity_date: string | null
  amount: number
  settlement_amount: number | null
  shares: number | null
  term_days: number | null
  maturity_date: string | null
  decision_id: number | null
  screenshot_id: number | null
  source: string
  notes: string
  created_at: string
  updated_at: string
  allocations: TradeAllocation[]
  has_screenshot: boolean
}

export interface TradeSummary {
  trade_count: number
  pending_count: number
  pending_buy_amount: number
  pending_redeem_amount: number
  confirmed_count: number
  cancelled_count: number
  open_principal: number
  open_count: number
  realized_pnl: number
  matured_count: number
  matured_amount: number
  unprocessed_inbox: number
}

export interface ReconciliationItem {
  level: 'info' | 'warn'
  code: string
  trade_id?: number
  inbox_id?: number
  text: string
}

export interface TradeReconciliation {
  generated_for: string
  counts: {
    warn: number
    info: number
    missing_screenshot: number
    amount_mismatch: number
    stale_pending: number
  }
  items: ReconciliationItem[]
}

export interface TradeInboxParsed {
  trade_date?: string
  confirm_date?: string | null
  trade_type?: TradeType
  status?: TradeStatus
  product_code?: string
  product_name?: string
  issuer?: string
  risk_level?: 'R2' | 'PR2'
  amount?: number | null
  settlement_amount?: number | null
  shares?: number | null
  term_days?: number | null
  maturity_date?: string | null
  target_product_code?: string
  target_product_name?: string
  target_term_days?: number | null
  target_maturity_date?: string | null
  decision_id?: number | null
  confidence?: number
  warnings?: string[]
  fields_found?: string[]
}

export interface TradeInboxItem {
  id: number
  original_name: string
  stored_name: string
  mime: string
  bytes: number
  sha256: string
  status: 'pending' | 'applied' | 'ignored'
  ocr_text: string
  parsed: TradeInboxParsed
  parse_confidence: number
  duplicate_of: number | null
  trade_id: number | null
  error: string
  notes: string
  received_at: string
  applied_at: string | null
  image_url: string | null
}

export interface TradeOverview {
  trades: TradeTransaction[]
  inbox: TradeInboxItem[]
  allocations: TradeAllocation[]
  holdings: Holding[]
  summary: TradeSummary
  reconciliation: TradeReconciliation
}

export type ProductEventType = '费率' | '经理' | '底层' | '赎回规则' | '额度' | '其他'
export type ProductEventImpact = '低' | '中' | '高'
export type ProductEventStatus = '待复核' | '已处理'

export interface ProductEvent {
  id: number
  date: string
  product_name: string
  event_type: ProductEventType
  description: string
  impact: ProductEventImpact
  status: ProductEventStatus
  created_at: string
  updated_at: string
}

export interface ReviewNote {
  month: string
  answers: string[]
  conclusion: string
  created_at: string
  updated_at: string
}

export interface QuarterlyNote {
  quarter: string
  answers: string[]
  conclusion: string
  created_at: string
  updated_at: string
}

export interface HoldingConcentration {
  name: string
  amount: number
  count: number
  pct: number
  code?: string
}

export interface HoldingsSummary {
  total_amount: number
  count: number
  buckets: Record<'liquid' | 'short' | 'medium' | 'long' | 'unknown', number>
  bucket_pct: Record<'liquid' | 'short' | 'medium' | 'long' | 'unknown', number | null>
  liquidity_amount: number
  liquidity_ratio_pct: number | null
  short_ratio_pct: number | null
  daily_open_ratio_pct: number | null
  max_product: HoldingConcentration | null
  max_issuer: HoldingConcentration | null
  by_product: HoldingConcentration[]
  by_issuer: HoldingConcentration[]
  ladder: Array<{ month: string; amount: number; count: number }>
  overdue_count: number
  overdue_amount: number
  beyond_12m_amount: number
  alerts: ReviewAlert[]
}

export type TimelineStatus = 'done' | 'due' | 'overdue' | 'upcoming' | 'not_applicable'

export interface TimelineNode {
  key: 'daily' | 'weekly' | 'monthly' | 'quarterly'
  label: string
  cadence: string
  status: TimelineStatus
  title: string
  detail: string
}

export type ReturnAttributionQuality =
  | 'fact'
  | 'mixed'
  | 'estimate'
  | 'verified_estimate'
  | 'unverified_estimate'
  | 'unavailable'

export interface ReturnAttributionComponent {
  key:
    | 'product_selection'
    | 'product_realization'
    | 'purchase_wait'
    | 'redemption_wait'
    | 'cash_unclassified'
    | 'fee_estimate'
  label: string
  amount: number | null
  annualized_equivalent_pct: number | null
  included_in_bridge: boolean
  quality: ReturnAttributionQuality
  note: string
}

export interface ReturnAttributionProduct {
  product_code: string
  product_name: string
  reference_yield_pct: number | null
  reference_data_date: string | null
  holding_days_amount: number
  target_pnl: number
  reference_pnl: number | null
  selection_estimate_pnl: number | null
  recorded_product_pnl: number
  recorded_days: number
}

export interface ReturnAttribution {
  schema_version: number
  status: 'available' | 'partial' | 'insufficient'
  quality: 'complete' | 'partial' | 'insufficient'
  available: boolean
  as_of_date: string | null
  period: {
    window_days: number
    start_date: string | null
    end_date: string | null
    calendar_days: number
    record_days: number
    missing_record_days: number
    coverage_pct: number
  }
  target: {
    annualized_pct: number
    observed_period_return_pct: number | null
    observed_period_pnl: number | null
    pnl_on_observed_principal: number | null
    pnl_on_observed_holdings: number | null
  }
  actual: {
    annualized_pct: number | null
    observed_period_return_pct: number | null
    observed_period_pnl: number | null
    average_principal: number
    average_holding_amount: number
    sample_sufficient: boolean
  }
  gap: {
    annualized_pct: number | null
    observed_period_pnl: number | null
  }
  bridge: {
    start_value: number | null
    included_net_amount: number
    end_value: number | null
    reconciliation_difference: number | null
    reconciled: boolean
  }
  components: ReturnAttributionComponent[]
  main_drags: Array<{
    key: ReturnAttributionComponent['key']
    label: string
    amount: number
    annualized_equivalent_pct: number | null
    quality: ReturnAttributionQuality
  }>
  deployment: {
    purchase_wait_pnl: number
    redemption_wait_pnl: number
    cash_unclassified_pnl: number
    residual_pnl: number
  }
  fee_estimate: {
    available: boolean
    amount: number | null
    quality: ReturnAttributionQuality
    included_in_bridge: false
    matched_trade_count: number
    trade_count: number
    verified_rule_count: number
    note: string
  }
  tplus_evidence: {
    available: boolean
    product_count: number
    verified_product_count: number
    unverified_product_codes: string[]
    products: Array<{
      product_code: string
      redemption_days: number | null
      arrival_days: number | null
      purchase_confirm_days: number | null
      verified: boolean
      verified_at: string
    }>
  }
  product_evidence: {
    available: boolean
    account_pnl: number
    recorded_product_pnl: number
    difference: number
    reference_yield_coverage_pct: number
    reference_yield_complete: boolean
    products: ReturnAttributionProduct[]
  }
  headline: string
  disclosures: string[]
}

export interface ReviewWorkspace {
  decisions: DecisionEntry[]
  holdings: Holding[]
  current_holdings_valuation: CurrentHoldingsValuation
  return_attribution: ReturnAttribution
  holding_reviews: HoldingReview[]
  holding_reviews_summary: HoldingReviewsSummary
  events: ProductEvent[]
  notes: ReviewNote[]
  quarterly: QuarterlyNote[]
  holdings_summary: HoldingsSummary
  trades: TradeOverview | null
  income_inbox: IncomeInboxItem[]
  income_summary: {
    pending: number
    applied: number
    latest_date: string | null
  }
  product_valuation_summaries: ProductValuationSummary[]
  product_valuation_reconciliation: ProductValuationReconciliation
  product_valuation_disclosure_policy: ProductIncomeDisclosurePolicy
  product_valuation_summary: {
    products: number
    active: number
    redeemed: number
    valuation_days: number
    latest_date: string | null
    max_yield_lag_days: number
    unverified_product_codes: string[]
  }
  timeline: {
    today: string
    focus: 'daily' | 'weekly' | 'monthly' | 'quarterly' | null
    nodes: TimelineNode[]
  }
}

export type DecisionProposalStatus =
  | 'pending'
  | 'accepted'
  | 'executed'
  | 'confirmed'
  | 'rejected'
  | 'expired'

export interface DecisionProposal {
  id: number
  dedupe_key: string
  group_key: string
  proposal_type: 'holding_switch' | 'cash_allocation'
  title: string
  summary: string
  action: DecisionAction
  product_name: string
  product_code: string
  target_product_code: string
  target_product_name: string
  amount: number
  evidence_date: string
  expires_at: string
  verify_date: string
  confidence: number
  status: DecisionProposalStatus
  decision_id: number | null
  payload: {
    decision?: Partial<DecisionInput>
    review_meta?: Record<string, unknown>
    expected_legs?: Array<{
      side: 'buy' | 'redeem'
      product_code: string
      product_name: string
      amount: number
    }>
    [key: string]: unknown
  }
  created_at: string
  updated_at: string
  accepted_at: string | null
  rejected_at: string | null
  reject_reason: string
  executed_at: string | null
  decision_execution_status?: string | null
  decision_audit_status?: string | null
}

export interface DecisionProposalWorkspace {
  generated_for: string
  proposals: DecisionProposal[]
  pending: DecisionProposal[]
  accepted: DecisionProposal[]
  executed: DecisionProposal[]
  history: DecisionProposal[]
  summary: {
    pending: number
    accepted: number
    executed: number
    rejected: number
    expired: number
  }
}

export type EvaluationStage = 'buy_day' | 'holding' | 'maturity'
export type EvaluationStatus = 'pending' | 'auto' | 'confirmed' | 'undone'

export interface EvaluationEvidence {
  next_update?: string
  checks?: Array<{ key: string; label: string; pass: boolean; detail: string }>
  buckets?: Record<string, number>
  by_product?: Array<{ code: string; name: string; amount: number }>
  linked_trade_ids?: number[]
  pending_trade_ids?: number[]
  strategy_version?: string
  target_annualized?: number
  target_progress_pct?: number | null
  monthly?: MonthlyReview | null
  liquidity_ratio_pct?: number | null
  short_ratio_pct?: number | null
  previous_short_ratio_pct?: number | null
  daily_open_ratio_pct?: number | null
  previous_liquidity_ratio_pct?: number | null
  liquidity_delta_pp?: number | null
  high_impact_event_ids?: number[]
  decision_quality?: DecisionCompleteness
  decision_missing_fields?: string[]
  open_trade_ids?: number[]
  hurdle?: number
  allocations?: TradeAllocation[]
  principal?: number
  weighted_days?: number
  weighted_term_days?: number
  realized_pnl?: number | null
  annualized_pct?: number | null
  hurdle_pct?: number
  settlement_amount?: number | null
  sell_trade_ids?: number[]
  all_settlement_known?: boolean
  maturity_date?: string
  term_days?: number | null
  remaining_principal?: number
  [key: string]: unknown
}

export interface EvaluationRun {
  id: number
  dedupe_key: string
  scope: 'decision' | 'trade'
  decision_id: number | null
  trade_id: number | null
  stage: EvaluationStage
  period: string
  evaluated_for: string
  rule_version: string
  source: string
  confidence: number
  confidence_level: 'high' | 'medium' | 'low'
  process_ok: boolean | null
  outcome: 'good' | 'bad' | 'unknown'
  rating: DecisionRating
  summary: string
  evidence: EvaluationEvidence
  status: EvaluationStatus
  previous_rating: DecisionRating | null
  previous_actual_result: string | null
  applied_rating: DecisionRating | null
  applied_actual_result: string | null
  applied_at: string | null
  undone_at: string | null
  created_at: string
  updated_at: string
}

export interface EvaluationSettings {
  target_annualized: number
  hurdle_short: number
  hurdle_medium: number
  hurdle_long: number
  liquidity_floor_pct: number
  daily_open_target_pct: number
  single_product_cap_pct: number
  bucket_tolerance_pp: number
  auto_confidence_threshold: number
  scheduler_minutes: number
  rule_version: string
  strategy_version: string
  notifications_enabled: boolean
  automation_enabled: boolean
  auto_confirm_reviews: boolean
}

export interface AutomationNotification {
  id: number
  dedupe_key: string
  kind: string
  level: 'info' | 'warn'
  title: string
  message: string
  data: Record<string, unknown>
  created_at: string
  updated_at: string
  read_at: string | null
  resolved_at: string | null
}

export interface AutomationJob {
  id: number
  dedupe_key: string
  job_type: string
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed'
  payload: Record<string, unknown>
  result: Record<string, unknown>
  note: string
  attempts: number
  created_at: string
  updated_at: string
  resolved_at: string | null
}

export interface ReviewDraft {
  id: number
  period_type: 'monthly' | 'quarterly'
  period: string
  status: 'draft' | 'confirmed'
  content: {
    title?: string
    answers?: string[]
    conclusion?: string
    anomalies?: string[]
    next_action?: string
    metrics?: MonthlyReview | null
    [key: string]: unknown
  }
  generated_at: string
  confirmed_at: string | null
  updated_at: string
}

export interface AutomationRun {
  id: number
  trigger: string
  status: 'running' | 'done' | 'failed'
  started_at: string
  finished_at: string | null
  summary: Record<string, number>
  error: string
}

export interface AutomationWorkspace {
  settings: EvaluationSettings
  runs: EvaluationRun[]
  pending_evaluations: EvaluationRun[]
  notifications: AutomationNotification[]
  all_notifications: AutomationNotification[]
  drafts: ReviewDraft[]
  jobs: AutomationJob[]
  automation_runs: AutomationRun[]
  calibration: DecisionCalibrationReport
  scheduler: {
    enabled: boolean
    last_run: AutomationRun | null
    next_run: string | null
  }
  runner?: {
    running: boolean
    startedAt: string | null
    finishedAt: string | null
    durationMs: number | null
    lastResult: Record<string, unknown> | null
    lastError: string
    timedOut: boolean
    stopReason: string
  } | null
}

export interface IncomeInboxParsed {
  date?: string
  valuation_date?: string
  credit_date?: string
  daily_pnl?: number | null
  product_daily_total?: number | null
  principal?: number | null
  confidence?: number
  warnings?: string[]
  fields_found?: string[]
  action?: LedgerAction
  notes?: string
  products?: ProductValuationInput[]
  needs_product_date_review?: boolean
  missing_product_codes?: string[]
  reconciliation?: ProductValuationReconciliationItem | null
}

export interface IncomeInboxItem {
  id: number
  original_name: string
  stored_name: string
  mime: string
  bytes: number
  sha256: string
  status: 'pending' | 'applied' | 'ignored'
  ocr_text: string
  parsed: IncomeInboxParsed
  parse_confidence: number
  record_date: string | null
  error: string
  notes: string
  received_at: string
  applied_at: string | null
  image_url: string | null
}

export type InboxCategory = 'action' | 'reminder' | 'system'
export type InboxSeverity = 'urgent' | 'warn' | 'info'
export type InboxStatus = 'active' | 'snoozed' | 'resolved'

export interface InboxItem {
  id: number
  dedupe_key: string
  source_type: string
  source_id: string
  source_label: string
  category: InboxCategory
  severity: InboxSeverity
  title: string
  summary: string
  action_label: string
  action_url: string
  due_at: string | null
  status: InboxStatus
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
  read_at: string | null
  snoozed_until: string | null
  resolved_at: string | null
}

export interface InboxCenter {
  generated_for: string
  items: InboxItem[]
  pending: InboxItem[]
  reminders: InboxItem[]
  handled: InboxItem[]
  summary: {
    pending_count: number
    reminder_count: number
    unread_count: number
    urgent_count: number
    handled_count: number
    by_source: Record<
      string,
      {
        label: string
        pending: number
        unread: number
      }
    >
  }
}

export interface IncomeCaptureResponse {
  inbox: IncomeInboxItem
  record: RawLedgerRecord | null
  duplicate: boolean
  auto_applied: boolean
  apply_error: string
  saved_valuations: ProductDailyValuation[]
  valuation_conflicts: Array<{
    product_code: string
    yield_date: string
    reason: string
    existing: ProductDailyValuation
  }>
  missing_product_codes: string[]
  reconciliation: ProductValuationReconciliationItem | null
  income_conflict: IncomeRecordConflict | null
  income_ignored: boolean
  ocr: {
    ok: boolean
    language: string | null
    error: string
  }
  dashboard: DashboardPayload
}

export interface IncomeApplyResponse {
  inbox: IncomeInboxItem
  record: RawLedgerRecord | null
  duplicate: boolean
  matched_existing: boolean
  ignored: boolean
  overwritten: boolean
  conflict: IncomeRecordConflict | null
  saved_valuations: ProductDailyValuation[]
  valuation_conflicts: Array<{
    product_code: string
    yield_date: string
    reason: string
    existing: ProductDailyValuation
  }>
  missing_product_codes: string[]
  reconciliation: ProductValuationReconciliationItem | null
  dashboard: DashboardPayload
}

export interface ProductValuationInput {
  valuation_date?: string
  credit_date?: string
  yield_date?: string
  date?: string
  product_code: string
  product_name?: string
  holding_amount?: number | null
  daily_pnl?: number | null
  source?: string
  screenshot_id?: number | null
  confidence?: number
  notes?: string
  correction_note?: string
}

export interface IncomeRecordConflict {
  date: string
  existing_daily_pnl: number
  incoming_daily_pnl: number
  difference: number
  notification_id: number | null
}

export interface ProductValuationMutationResponse {
  valuation: ProductDailyValuation
  conflict: string | null
  dashboard: DashboardPayload
}

export interface HoldingValuationItemInput {
  product_code: string
  product_name?: string
  market_value: number
}

export interface HoldingValuationInput {
  as_of_date: string
  total_value: number
  source?: string
  evidence_id?: number | null
  notes?: string
  items?: HoldingValuationItemInput[]
}

export interface HoldingValuationMutationResponse {
  snapshot: {
    id: number
    as_of_date: string
    as_of_at: string
    total_value: number
    source: string
    evidence_id: number | null
    notes: string
    items: HoldingValuationItem[]
  }
  created: boolean
  dashboard: DashboardPayload
}

export interface HoldingValuationEvidence {
  id: number
  evidence_type: string
  source_channel: string
  sha256: string
  original_name: string
  storage_namespace: string
  storage_name: string
  mime: string
  bytes: number
  available: boolean
  status: string
}

export interface HoldingValuationEvidenceUploadResponse {
  evidence: HoldingValuationEvidence
  duplicate: boolean
}

export interface ProductYieldSettingInput {
  yield_lag_days: number
  source: Exclude<ProductYieldLagSource, 'default'>
  notes?: string
  verified_at?: string
}

export interface ProductYieldSettingMutationResponse {
  setting: ProductYieldSetting
  dashboard: DashboardPayload
}

export interface TradeInput {
  trade_date: string
  confirm_date: string | null
  trade_type: TradeType
  status: TradeStatus
  product_code: string
  product_name: string
  issuer: string
  risk_level: 'R2' | 'PR2'
  target_product_code?: string
  target_product_name?: string
  target_term_days?: number | null
  target_maturity_date?: string | null
  amount: number
  settlement_amount: number | null
  shares: number | null
  term_days: number | null
  maturity_date: string | null
  decision_id: number | null
  notes: string
}

export interface Product {
  name: string
  code: string
  short_name: string
  issuer: string
  risk_level: string
  currency_code: string
  pub_prv: string
  soc_tag: string
  product_type: string
  term_days: number | null
  score: number | null
  min_amount: number | null
  annualized_yield: number | null
  benchmark: string
  return_1m: number | null
  return_3m: number | null
  return_6m: number | null
  return_1y: number | null
  reference_yield_pct: number | null
  weighted_yield_pct: number | null
  return_since_inception: number | null
  status: string
  source: string
  data_date: string
  notes: string
  capacity: number | null
  history_months: number | null
  fee_bps: number | null
  next_open_date: string
  bucket: ProductBucket
  evidence_tier: ProductEvidenceTier
  evidence_label: string
  evidence_scoring: boolean
  evidence_automatic: boolean
  evidence_single_cap_pct: number
  evidence_aggregate_cap_pct: number | null
  observation_score: number | null
  selection_score: number | null
  observation_ready: boolean
  selected: boolean
  selection_rank: number | null
  target_amount: number
  target_pct: number
  allocation_bucket: ProductBucket | null
  allocation_mode: 'top_up' | 'new' | null
  minimum_order_amount: number
  meaningful_target_amount: number
  meaningful_min_amount: number
  existing_exposure: number
  issuer_exposure: number
  quota_status: 'unverified' | 'limited' | 'verified' | null
  quota_available: number | null
  quota_max_order: number | null
  quota_window: string
  quota_verified_at: string
  allocation_reason: string
  target_gap_pct: number | null
  reference_target_gap_pct: number | null
}

export interface ProductAllocationBucket {
  key: 'short' | 'medium' | 'long'
  label: string
  target_amount: number
  target_pct: number
  existing_amount: number
  budget_amount: number
  new_amount: number
  top_up_amount: number
  new_position_amount: number
  unallocated_amount: number
  minimum_new_position_amount: number
  final_amount: number
  final_pct: number
  status: 'filled' | 'partial' | 'no_budget'
  reasons: string[]
}

export interface ProductAllocationSettings {
  principal_override: number | null
  liquidity_floor_pct: number
  daily_open_target_pct: number
  max_single_pct: number
  target_slice_pct: number
  cashflow_0_3: number
  cashflow_3_6: number
  cashflow_6_12: number
  bucket_targets: { short: number; medium: number; long: number }
  quota_by_code: Record<
    string,
    {
      available: number | null
      max_order: number | null
      window: string
      verified_at: string
    }
  >
  updated_at?: string | null
}

export interface ProductAllocation {
  version: string
  status:
    | 'ready'
    | 'partial'
    | 'quota_unverified'
    | 'no_cash'
    | 'no_allocation'
    | 'no_principal'
  principal: number
  committed_amount: number
  available_cash: number
  allocated_amount: number
  top_up_amount: number
  new_position_amount: number
  unallocated_amount: number
  overcommitted: boolean
  allocation_policy: {
    confirmed_holdings_first: true
    issuer_display_only: true
    meaningful_new_position_ratio_pct: number
    target_slice_amount: number
    max_single_amount: number
    minimum_new_position_amount: number
    evidence_caps: {
      six_month: { single_pct: number; aggregate_pct: number }
      three_month: { single_pct: number; aggregate_pct: number }
      one_month: {
        automatic: false
        single_pct: number
        aggregate_pct: number
      }
    }
  }
  liquidity: {
    floor_pct: number
    target_amount: number
    existing_amount: number
    final_amount: number
    shortfall_amount: number
    status: 'covered' | 'shortfall'
  }
  daily_open: {
    target_pct: number
    target_amount: number
    existing_amount: number
    migration_required: boolean
    status: 'zero' | 'migration_required'
    note: string
  }
  cashflow: Array<{
    key: string
    label: string
    required_amount: number
    covered_amount: number
    status: 'covered' | 'shortfall'
  }>
  pending: {
    count: number
    amount: number
    items: Array<{
      code: string
      name: string
      issuer: string
      amount: number
      term_days: number | null
      bucket: ProductBucket
      source: string
    }>
  }
  holdings: { count: number; amount: number }
  settings: ProductAllocationSettings
  buckets: ProductAllocationBucket[]
  reasons: string[]
  quota_unverified_count: number
}

export interface ProductStats {
  total: number
  observation_ready: number
  selected_count: number
  observation_count: number
  evidence_counts: Record<ProductEvidenceTier, number>
  scored_bucket_counts: Record<'cash' | 'short' | 'medium' | 'long', number>
  median_1y: number | null
  median_3m: number | null
  median_6m: number | null
  median_reference: number | null
  universe_median_1y: number | null
  universe_median_3m: number | null
  universe_median_6m: number | null
  universe_median_reference: number | null
  bucket_counts: Record<'cash' | 'short' | 'medium' | 'long', number>
  target_annualized: number
  target_gap_pct: number | null
  target_coverage_pct: number | null
}

export interface ProductView {
  all: Product[]
  watchlist: Product[]
  observation_list: Product[]
  allocation: ProductAllocation
  selection: {
    version: string
    per_bucket: number | null
    max_single_pct: number
    min_history_months: number
    full_history_months: number
    selected_count: number
    evidence_caps: ProductAllocation['allocation_policy']['evidence_caps']
    rules: string[]
  }
  stats: ProductStats
}

export interface DashboardMeta {
  today: string
  reporting_date: string
  reporting_lag_days: number
  recording_date_source: 'user-provided'
  income_disclosure_policy: ProductIncomeDisclosurePolicy
  target_annualized: number
  has_today_record: boolean
  today_record: RawLedgerRecord | null
  has_reporting_record: boolean
  reporting_record: RawLedgerRecord | null
  product_snapshot_date: string | null
  product_history_date: string | null
  product_csv: string | null
  latest_backup: { date: string; bytes: number } | null
  storage: string
}

export interface DashboardPayload {
  meta: DashboardMeta
  records: LedgerRecord[]
  summary: Summary
  windows: Record<'7' | '30' | '90', Summary>
  review: ReviewData
  workspace: ReviewWorkspace
  automation: AutomationWorkspace
  decision_proposals: DecisionProposalWorkspace
  inbox_center: InboxCenter
  capital: CapitalState
  products: ProductView
}

export interface RecordInput {
  date: string
  daily_pnl: number
  action: LedgerAction
  notes: string
}

export interface CapitalInitInput {
  initial_principal: number
  initial_date: string
}

export interface CapitalEventInput {
  event_date: string
  event_type: CapitalEventType
  amount: number
  note: string
}

export interface RecordMutationResponse {
  record: LedgerRecord
  duplicate: boolean
  changed: boolean
  conflict: IncomeRecordConflict | null
  dashboard: DashboardPayload
}

export interface DecisionInput {
  date: string
  product_name: string
  action: DecisionAction
  reason: string
  expectation: string
  invalidation_condition: string
  actual_result: string
  strategy_version: string
  target_annualized: number
  bucket_plan: Record<string, number>
  evaluation_at: string[]
  evidence_date: string
  verify_date: string
  review_meta: Record<string, unknown>
  rating: DecisionRating
}

export interface HoldingReviewSettingInput {
  redemption_days?: number | null
  arrival_days?: number | null
  redemption_fee_bps?: number
  purchase_fee_bps?: number
  purchase_confirm_days?: number | null
  next_redeem_open_date?: string
  notes?: string
  verified_at?: string
}

export interface HoldingInput {
  product_name: string
  product_code: string
  issuer: string
  risk_level: 'R2' | 'PR2'
  amount: number
  purchase_date: string
  term_days: number | null
  maturity_date: string | null
  notes: string
}

export interface ProductEventInput {
  date: string
  product_name: string
  event_type: ProductEventType
  description: string
  impact: ProductEventImpact
  status: ProductEventStatus
}

export interface ReviewNoteInput {
  answers: string[]
  conclusion: string
}

export interface DecisionMutationResponse {
  decision: DecisionEntry
  dashboard: DashboardPayload
}

export interface HoldingMutationResponse {
  holding: Holding
  dashboard: DashboardPayload
}

export interface ProductEventMutationResponse {
  event: ProductEvent
  dashboard: DashboardPayload
}

export interface ReviewNoteMutationResponse {
  note: ReviewNote | QuarterlyNote
  dashboard: DashboardPayload
}

export interface CapitalEventMutationResponse {
  event: CapitalEvent
  dashboard: DashboardPayload
}

export interface DashboardMutationResponse {
  dashboard: DashboardPayload
}

export interface ProductRefreshResponse {
  refreshed: number
  dashboard: DashboardPayload
}

export interface TradeOverviewResponse {
  overview: TradeOverview
  inbox: TradeInboxItem[]
}

export interface TradeMutationResponse {
  trade: TradeTransaction
  overview: TradeOverview
  dashboard: DashboardPayload
}

export interface TradeInboxResponse {
  inbox: TradeInboxItem
  duplicate: boolean
  overview: TradeOverview
  ocr?: {
    ok: boolean
    language: string | null
    error: string
  }
}

export interface DecisionProposalMutationResponse {
  result: {
    proposal: DecisionProposal
    decision?: DecisionEntry
  }
  dashboard: DashboardPayload
}

export interface InboxMutationResponse {
  inbox: TradeInboxItem
  overview: TradeOverview
  dashboard?: DashboardPayload
  trade?: TradeTransaction
  matched?: boolean
  duplicate?: boolean
}

export interface InboxPruneResponse {
  removed: number
  threshold: string
  inbox: TradeInboxItem[]
}

export interface DeleteResponse {
  deleted: true
  dashboard: DashboardPayload
}

export interface ApiErrorPayload {
  error?: string
}

export interface SortState<TKey extends string> {
  key: TKey
  direction: SortDirection
}
