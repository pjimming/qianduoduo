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
  pnl: number
  avg_principal: number
  return_pct: number | null
  grade: string
  negative_days: number
  positive_days: number
  is_current: boolean
  provisional: boolean
}

export interface DailyReview {
  date: string
  principal: number
  daily_pnl: number
  daily_return_pct: number
  month: string
  month_pnl: number
  month_avg_principal: number
  month_return_pct: number | null
  month_grade: string
  month_record_days: number
  provisional: boolean
}

export interface ReviewData {
  thresholds: number[]
  daily: DailyReview | null
  current_month: MonthlyReview | null
  monthly: MonthlyReview[]
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
