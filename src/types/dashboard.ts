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
  timeline: {
    today: string
    focus: 'daily' | 'weekly' | 'monthly' | 'quarterly' | null
    nodes: TimelineNode[]
  }
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
