import { apiRequest } from './client'
import type { StrategyWorkspace, StrategyComputation, StrategyCashflow } from '@/types/r2-strategy'
import type { DecisionProposal } from '@/types/dashboard'
const base = '/api/r2-strategy'
const apiBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

/** 保留 HTTP 状态码，供页面区分“接口尚未部署(404)”与业务校验失败。 */
export class StrategyApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'StrategyApiError'
    this.status = status
  }
}

interface StrategyErrorPayload {
  error?: string | { message?: string }
}

async function strategyRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${base}${path}`, {
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  })
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok) {
    const detail = payload as StrategyErrorPayload | null
    const message =
      typeof detail?.error === 'string'
        ? detail.error
        : detail?.error?.message || `请求失败（${response.status}）`
    throw new StrategyApiError(message, response.status)
  }
  return payload as T
}

export const getStrategyWorkspace = (signal?: AbortSignal) => apiRequest<StrategyWorkspace>(base + '/workspace', { signal })
export const computeStrategy = (fingerprint?: string) => apiRequest<StrategyComputation>(base + '/recompute', { method: 'POST', body: JSON.stringify(fingerprint ? { expected_input_fingerprint: fingerprint } : {}) })
export const generateStrategyProposals = (fingerprint?: string) => apiRequest<{ created: { proposal: DecisionProposal; existing: boolean }[]; blockers?: string[] }>(base + '/proposals', { method: 'POST', body: JSON.stringify(fingerprint ? { expected_input_fingerprint: fingerprint } : {}) })
export const cancelStrategyProposalRemaining = (id: number, reason = '') => strategyRequest<{
  proposal: DecisionProposal
  decision: unknown
  released_cents: number
  remaining_cents: number
  existing: boolean
}>(`/proposals/${id}/cancel-remaining`, { method: 'POST', body: JSON.stringify({ reason }) })

export const generateHoldingExit = (lot: string, fingerprint: string) => strategyRequest<{ created: unknown[]; blockers?: string[] }>('/proposals', { method: 'POST', body: JSON.stringify({kind: 'holding_exit', lot_id: lot, expected_input_fingerprint: fingerprint}) })
export const getStrategyStatus = () => strategyRequest<{ mode: string; contract_hash: string; contract_matches: boolean; contract: { execution_version: string; bucket_targets: { short: number; medium: number; long: number }; max_single_pct: number } }>('/status')
export const saveStrategyCashflow = (cashflow_dates: StrategyCashflow[]) => apiRequest('/api/products/allocation', { method: 'PUT', body: JSON.stringify({ cashflow_dates }) })
