export interface StrategyIdentity { source: string; channel: string; code: string }
export interface StrategyMapping { id: number; source: string; channel: string; sales_code: string; product_code: string; registration_code: string | null }
export interface StrategyCheck { id: number; mapping_id: number; lot_id: string; version: number; facts: Record<string, unknown>; verified_at: string; verified_by: string }
export interface StrategyAllocationRow { identity: StrategyIdentity; rank: number; group: string; amount_cents: number; evidence_hash: string; reason: string }
export interface StrategyHoldingRow { identity?: StrategyIdentity | null; summary?: string; redemption?: { earliest_redeem_date?: string | null; funds_available_date?: string | null }; lot_id: string; product_code: string; state: string; action: string; planned_action: string; yield_1m: string | null; performance_date: string | null; next_verify_date: string; requires_user_action: boolean; fingerprint: string }
export interface StrategyResult {
  input: { mode: string; activation_seq: number; business_date: string; source_fingerprint: string | null }
  input_fingerprint: string; may_generate_buy_proposals: boolean
  allocation: { status: string; full_investment: boolean; principal_cents: number | null; committed_cents: number; available_cents: number; blocked_cash_cents: number; allocated_cents: number; unallocated_cents: number; blockers: string[]; rows: StrategyAllocationRow[]; excluded_reason_counts: Record<string, number> }
  monitoring: { counts: Record<string, number>; rows: StrategyHoldingRow[] }
  selected_reviews: { identity: StrategyIdentity; check_id: number | null; mapping_id: number | null; amount_cents: number; executable: boolean; blockers: string[]; forecast_status?: string; forecast_reason?: string; expected_net_pnl_cents?: number | null; expected_net_annualized_pct?: number | null }[]
}
export interface StrategyWorkspace { mode: string; activation_seq: number; migrated: boolean; contract_hash: string; business_date: string; input_fingerprint: string; source_issue: string | null; run_id: number | null; stale: boolean; result: StrategyResult | null }
export interface StrategyComputation { input_fingerprint: string; persisted: boolean; pending?: boolean; result?: StrategyResult; job_id?: number }
export interface StrategyShareMatch { source: string; channel: string; code: string; registration_code: string | null; name: string | null }
export interface StrategyShareMatchResult { matched: boolean; product_code: string; candidates: StrategyShareMatch[] }
export interface StrategyReviewPrefill { facts: Record<string, unknown>; paths: string[] }
export interface StrategyReview { identity: StrategyIdentity; mapping: StrategyMapping | null; check: StrategyCheck | null; public_evidence: { name?: string; issuer?: string; registration?: string | null; term?: { kind: string; days: number | null }; performance_date?: string; quota?: Record<string, unknown> | null; min_amount?: string | number | null; evidence_tier?: string | null; detail?: { equity_upper_pct?: number | null; valuation_basis?: string | null; sale_channel?: string | null } | null; evidence?: { kind: string; url: string; hash?: string; summary?: Record<string, unknown> }[] } | null; suggestions?: StrategyReviewPrefill | null; review: { executable: boolean; blockers: string[]; limits?: Record<string, unknown> | null } | null; business_date: string; activation_seq: number; input_fingerprint: string }
