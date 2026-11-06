export type Counts = {
  total: number; eligible: number; watch: number; pending: number; rejected: number
  yield_pass: number; yield_pending: number; yield_rejected: number
  quota_open: number; shortlisted: number; frequent_zero: number
}
export type Run = {
  id: number; trigger: string; business_date: string; status: string; rule_version: string
  created_at: string; started_at: string | null; finished_at: string | null; retry_at: string | null
  refresh_calendar_version: string; valuation_calendar_version: string; collector_version: string
  counts: Counts | null; error_message: string | null
  health: Record<string, { requested?: number; ok?: number; matched?: number; pages?: number; covered?: number; state?: string }> | null
}
export type EvidenceAge = { date: string; performance_expired: number; nav_expired: number;
  performance_latest: string | null; nav_latest: string | null }
export type RunDetail = Run & {
  data_age?: EvidenceAge | null
  attempts: { attempt: number; status: string; started_at: string; finished_at: string | null; error_message: string | null }[]
}
export type Status = {
  availability: string; current_run: Run | null; last_attempt: Run | null; next_due_at: string | null
  data_age: (EvidenceAge & { days: number }) | null
  scheduler: { enabled: boolean; calendar_gap: boolean; active: Run | null }
}
export type Point = { date: string; unit: string }
export type Metrics = {
  latest: string | null; start: string | null; end: string | null; count: number; issue: string | null
  zero_count?: number | null; zero_dates?: string[] | null; recent?: Point[]
  trend: string; month_ends?: { date: string | null; unit: string | null }[]; monthly_returns?: number[]
  drawdown: { pct: number | null; peak_date?: string; trough_date?: string; peak_value?: string; trough_value?: string
    repair_date?: string | null; repair_days?: number | null; recovery: string }
}
export type Reason = { gate: string; outcome: string; code: string }
export type Row = {
  channel: string; code: string; name: string; issuer: string; status: string
  term: { kind: string; days: number | null; basis?: string | null }; category: string
  rank: number | null; shortlisted: boolean; hints: string[]
  performance: Partial<Record<'1m' | '3m' | '6m' | '1y', string>>; performance_date: string | null
  quota: { status: number | null; amount: string | null; amount_state: string;
    checked_at: string | null; amount_checked_at: string | null; assumption: boolean }
  min_amount: string | null; metrics: Metrics; reason?: Reason | null
}
export type Evidence = {
  kind: string; url: string; checked_at: string
  summary: { disclosure_date?: string | null; title?: string; location?: string; document_hash?: string; registration?: string }
}
export type Results = {
  items: Row[]; total: number; page: number; limit: number; run_id: number
  facets: { issuers: string[]; terms: (number | null)[] }
}
export type Detail = {
  run_id: number; business_date: string; rule_version: string
  result: Row & { reasons: Reason[]; detail: { registration?: string; sale_channel?: string; valuation_clause?: string;
    category_basis?: string; equity_upper_pct?: number | null } | null }
  evidence: Evidence[]
  trade_review: { label: string; evidence?: string | null; note?: string | null; state: string; url?: string | null }[]
}
export type Nav = { items: (Point & { cumulative: string | null; marks: string[] })[]; total: number; issue: string | null }
export type History = { items: Run[]; total: number; page: number; limit: number }

export class ScreeningError extends Error {
  constructor(message: string, readonly details?: { code: string; run?: Run }) { super(message) }
}

export async function screeningGet<T>(path: string, signal: AbortSignal): Promise<T> {
  return request<T>(path, { signal })
}

export async function refreshScreening(key: string, signal: AbortSignal): Promise<Run> {
  try {
    return (await request<{ run: Run }>('/runs', { method: 'POST', headers: { 'Idempotency-Key': key }, signal })).run
  } catch (error) {
    if (error instanceof ScreeningError && error.details?.code === 'active_run' && error.details.run) return error.details.run
    throw error
  }
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const budget = AbortSignal.timeout(10000)
  const response = await fetch('/api/r2-screening' + path, {
    ...init, cache: 'no-store', signal: init.signal ? AbortSignal.any([init.signal, budget]) : budget,
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data) throw new ScreeningError(data?.error || '初筛接口暂时无法读取', data?.details)
  return data as T
}

const shanghai = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
export function localTime(value?: string | null) { return value ? shanghai.format(new Date(value)) : '—' }
export const runState: Record<string, string> = {
  queued: '排队中', running: '采集中', succeeded: '已发布', degraded: '部分证据待核', failed: '刷新失败', interrupted: '已中断',
}
export const triggerLabel: Record<string, string> = { manual: '手动', scheduled: '定时', startup: '启动补跑' }
export const stateLabel: Record<string, string> = { eligible: '通过', watch: '回撤观察', pending: '待核', rejected: '淘汰' }
export const categoryLabel: Record<string, string> = { bond: '纯债', deposit: '存款类', enhanced: '固收增强', unknown: '分类待核' }
export const hintLabel: Record<string, string> = {
  frequent_zero: '频繁挂零', zero_pending: '挂零待核', trend_weak: '走势走弱', trend_pending: '走势待核',
  trend_short: '走势历史不足', quota_default: '策略默认额度', quota_low: '公开余额较低',
  term_unknown: '期限待核', category_unknown: '分类待核', equity_review: '权益上限待复核', calendar_gap: '日历覆盖不足',
}
export const reasonLabel: Record<string, string> = {
  yield_unverified: '近 1 月年化缺少有效的同份额披露', yield_below: '近 1 月年化低于 2.15%', yield_pass: '近 1 月年化达到 2.15%',
  quota_open: '公开额度状态为 0', sold_out: '公开额度状态为 1（售罄）', quota_unverified: '公开额度状态待核',
  periodic: '定期开放', rolling: '滚动持有规则待核', term_exceeds: '公开期限超过 190 天', term_pass: '公开期限在 190 天以内',
  term_unknown: '未核实公开最短持有期', term_conflict: '公开期限依据不一致', category_unknown: '公开证据不足以确认分类',
  drawdown_pass: '最大回撤低于 1%', drawdown_watch: '最大回撤在 1% 至 1.5% 之间', drawdown_reject: '最大回撤高于 1.5%',
  detail_unavailable: '同渠道产品详情暂未取得', nav_unavailable: '未获取到可用净值', nav_pages: '净值分页不完整', nav_identity: '净值份额不匹配',
  nav_conflict: '同日单位净值冲突', nav_invalid: '单位净值日期或披露精度无法核验',
  nav_insufficient: '有效单位净值少于两条', nav_stale: '净值披露已过期', calendar_gap: '交易日历覆盖不足',
}
export const recoveryLabel: Record<string, string> = { none: '无回撤', unrepaired: '未修复', repaired: '已修复', pending: '待核' }
export function pct(value?: number | string | null) { return value == null ? '—' : Number(value).toFixed(2) + '%' }
export function drawdownPct(value: number | null) {
  return value !== null && value > 0 && value < 0.01 ? '<0.01%' : pct(value)
}
export function evidenceExpired(value: string | null, today?: string) {
  return Boolean(value && today && (value > today || Date.parse(today) - Date.parse(value) >= 7 * 86400000))
}
