export interface StrategyIdentity { source: string; channel: string; code: string }
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
