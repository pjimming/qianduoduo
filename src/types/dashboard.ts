export type LedgerAction = '无操作' | '买入' | '赎回' | '切换'
export type CapitalEventType = 'deposit' | 'withdraw'
export type ProductBucket = 'short' | 'medium' | 'long' | 'unknown'
export type TermFilter = 'all' | ProductBucket
export type SortDirection = 'asc' | 'desc'
export type LedgerSortKey = 'date' | 'principal' | 'daily_pnl' | 'daily_return' | 'net_value'
export type ProductSortKey = 'term' | 'return_1m' | 'return_3m' | 'return_6m' | 'return_1y'
export type RangeValue = 7 | 30 | 90 | 'all'

export interface LedgerRecord {
  date: string
  principal: number
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
  date: string
  principal: number
  daily_pnl: number
  action: LedgerAction
  notes: string
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

export interface Summary {
  record_count: number
  first_date: string | null
  last_date: string | null
  calendar_days: number
  total_pnl: number
  avg_principal: number
  latest_principal: number
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
  first_date: string
  last_date: string
  record_days: number
  calendar_days: number
  elapsed_days: number
  missing_days: number
  record_coverage_pct: number | null
  pnl: number
  avg_principal: number
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
  daily_pnl: number
  daily_return_pct: number
  action: string
  notes: string
  month: string
  month_pnl: number
  month_avg_principal: number
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

export interface DecisionEntry {
  id: number
  date: string
  product_name: string
  action: DecisionAction
  reason: string
  expectation: string
  actual_result: string
  strategy_version: string
  target_annualized: number
  bucket_plan: Record<string, number>
  evaluation_at: string[]
  rating: DecisionRating
  created_at: string
  updated_at: string
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

export type TimelineStatus = 'done' | 'due' | 'overdue' | 'upcoming'

export interface TimelineNode {
  key: 'daily' | 'weekly' | 'monthly' | 'quarterly'
  label: string
  cadence: string
  status: TimelineStatus
  title: string
  detail: string
}

export interface ReviewWorkspace {
  decisions: DecisionEntry[]
  holdings: Holding[]
  events: ProductEvent[]
  notes: ReviewNote[]
  quarterly: QuarterlyNote[]
  holdings_summary: HoldingsSummary
  trades: TradeOverview | null
  timeline: {
    today: string
    focus: 'daily' | 'weekly' | 'monthly' | 'quarterly' | null
    nodes: TimelineNode[]
  }
}

export type EvaluationStage = 'buy_day' | 'holding' | 'maturity'
export type EvaluationStatus = 'pending' | 'auto' | 'confirmed' | 'undone'

export interface EvaluationEvidence {
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
  previous_liquidity_ratio_pct?: number | null
  liquidity_delta_pp?: number | null
  high_impact_event_ids?: number[]
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
  single_product_cap_pct: number
  bucket_tolerance_pp: number
  auto_confidence_threshold: number
  scheduler_minutes: number
  rule_version: string
  strategy_version: string
  notifications_enabled: boolean
  automation_enabled: boolean
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
  scheduler: {
    enabled: boolean
    last_run: AutomationRun | null
    next_run: string | null
  }
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
  issuer: string
  risk_level: string
  term_days: number | null
  score: number | null
  min_amount: number | null
  annualized_yield: number | null
  benchmark: string
  return_1m: number | null
  return_3m: number | null
  return_6m: number | null
  return_1y: number | null
  return_since_inception: number | null
  status: string
  source: string
  data_date: string
  notes: string
  capacity: number | null
  bucket: ProductBucket
  observation_score: number
  observation_ready: boolean
  target_gap_pct: number | null
}

export interface ProductStats {
  total: number
  observation_ready: number
  median_1y: number | null
  median_3m: number | null
  median_6m: number | null
  target_annualized: number
  target_gap_pct: number | null
  target_coverage_pct: number | null
}

export interface ProductView {
  all: Product[]
  watchlist: Product[]
  stats: ProductStats
}

export interface DashboardMeta {
  today: string
  target_annualized: number
  has_today_record: boolean
  today_record: RawLedgerRecord | null
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
  dashboard: DashboardPayload
}

export interface DecisionInput {
  date: string
  product_name: string
  action: DecisionAction
  reason: string
  expectation: string
  actual_result: string
  strategy_version: string
  target_annualized: number
  bucket_plan: Record<string, number>
  evaluation_at: string[]
  rating: DecisionRating
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
