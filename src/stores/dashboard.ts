import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { apiRequest } from '@/api/client'
import type {
  CapitalEventInput,
  CapitalEventMutationResponse,
  CapitalInitInput,
  CapitalState,
  AutomationWorkspace,
  DashboardMutationResponse,
  DashboardPayload,
  DataTrustTraceResponse,
  DecisionCalibrationReport,
  DecisionInput,
  DecisionProposalMutationResponse,
  DecisionMutationResponse,
  DeleteResponse,
  HoldingInput,
  HoldingMutationResponse,
  HoldingReviewSettingInput,
  IncomeCaptureResponse,
  IncomeApplyResponse,
  IncomeInboxParsed,
  InboxCenter,
  InboxMutationResponse,
  InboxPruneResponse,
  LedgerRecord,
  ProductEventInput,
  ProductEventMutationResponse,
  ProductRefreshResponse,
  ProductValuationDetail,
  ProductValuationInput,
  ProductValuationMutationResponse,
  ProductYieldSettingInput,
  ProductYieldSettingMutationResponse,
  RecordInput,
  RecordMutationResponse,
  ReviewNoteInput,
  ReviewNoteMutationResponse,
  TradeInboxParsed,
  TradeInboxResponse,
  TradeInput,
  TradeMutationResponse,
  TradeOverview,
  TradeOverviewResponse,
} from '@/types/dashboard'

export const useDashboardStore = defineStore('dashboard', () => {
  const dashboard = ref<DashboardPayload | null>(null)
  const loading = ref(false)

  const capital = computed<CapitalState | null>(() => dashboard.value?.capital ?? null)

  function applyTradeOverview(overview: TradeOverview): void {
    if (dashboard.value) {
      dashboard.value.workspace.trades = overview
    }
  }

  function applyAutomation(automation: AutomationWorkspace): void {
    if (dashboard.value) {
      dashboard.value.automation = automation
    }
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      dashboard.value = await apiRequest<DashboardPayload>('/api/dashboard')
    } finally {
      loading.value = false
    }
  }

  function recordByDate(date: string): LedgerRecord | null {
    return dashboard.value?.records.find((record) => record.date === date) ?? null
  }

  function principalForDate(date: string): number | null {
    const currentCapital = dashboard.value?.capital
    if (!currentCapital?.initialized || !date) return null
    if (!currentCapital.initial_date || date < currentCapital.initial_date) return null
    let principal = Number(currentCapital.initial_principal)
    for (const event of currentCapital.events) {
      if (event.date > date) break
      principal += event.type === 'deposit' ? event.amount : -event.amount
    }
    return Math.round((principal + Number.EPSILON) * 100) / 100
  }

  async function createRecord(input: RecordInput): Promise<RecordMutationResponse> {
    const response = await apiRequest<RecordMutationResponse>('/api/records', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    dashboard.value = response.dashboard
    return response
  }

  async function updateRecord(
    date: string,
    input: RecordInput,
  ): Promise<RecordMutationResponse> {
    const response = await apiRequest<RecordMutationResponse>(
      `/api/records/${encodeURIComponent(date)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ ...input, date }),
      },
    )
    dashboard.value = response.dashboard
    return response
  }

  async function deleteRecord(date: string): Promise<DeleteResponse> {
    const response = await apiRequest<DeleteResponse>(
      `/api/records/${encodeURIComponent(date)}`,
      { method: 'DELETE' },
    )
    dashboard.value = response.dashboard
    return response
  }

  async function initializeCapital(input: CapitalInitInput): Promise<DashboardMutationResponse> {
    const response = await apiRequest<DashboardMutationResponse>('/api/capital/init', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    dashboard.value = response.dashboard
    return response
  }

  async function updateCapital(input: CapitalInitInput): Promise<DashboardMutationResponse> {
    const response = await apiRequest<DashboardMutationResponse>('/api/capital/init', {
      method: 'PUT',
      body: JSON.stringify(input),
    })
    dashboard.value = response.dashboard
    return response
  }

  async function createCapitalEvent(
    input: CapitalEventInput,
  ): Promise<CapitalEventMutationResponse> {
    const response = await apiRequest<CapitalEventMutationResponse>('/api/capital/events', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    dashboard.value = response.dashboard
    return response
  }

  async function deleteCapitalEvent(id: number): Promise<DeleteResponse> {
    const response = await apiRequest<DeleteResponse>(`/api/capital/events/${id}`, {
      method: 'DELETE',
    })
    dashboard.value = response.dashboard
    return response
  }

  async function refreshProducts(): Promise<ProductRefreshResponse> {
    const response = await apiRequest<ProductRefreshResponse>('/api/products/refresh', {
      method: 'POST',
    })
    dashboard.value = response.dashboard
    return response
  }

  async function updateAllocationSettings(
    patch: Record<string, unknown>,
  ): Promise<DashboardPayload> {
    const response = await apiRequest<{
      settings: unknown
      dashboard: DashboardPayload
    }>('/api/products/allocation', {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
    dashboard.value = response.dashboard
    return response.dashboard
  }

  async function saveHoldingReviewSetting(
    productCode: string,
    input: HoldingReviewSettingInput,
  ): Promise<DashboardPayload> {
    const response = await apiRequest<{
      setting: unknown
      dashboard: DashboardPayload
    }>(`/api/holding-reviews/${encodeURIComponent(productCode)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })
    dashboard.value = response.dashboard
    return response.dashboard
  }

  async function loadAutomation(): Promise<AutomationWorkspace> {
    const response = await apiRequest<{ automation: AutomationWorkspace }>(
      '/api/automation/workspace',
    )
    applyAutomation(response.automation)
    return response.automation
  }

  async function runAutomation(): Promise<{
    ok: boolean
    summary?: Record<string, number>
    error?: string
    automation?: AutomationWorkspace
    dashboard?: DashboardPayload
  }> {
    const response = await apiRequest<{
      ok: boolean
      summary?: Record<string, number>
      error?: string
      automation: AutomationWorkspace
      dashboard: DashboardPayload
    }>('/api/automation/run', { method: 'POST', body: '{}' })
    dashboard.value = response.dashboard
    return response
  }

  async function loadCalibration(
    month: string,
  ): Promise<DecisionCalibrationReport> {
    const report = await apiRequest<DecisionCalibrationReport>(
      `/api/calibration/monthly?month=${encodeURIComponent(month)}`,
    )
    if (dashboard.value) {
      dashboard.value.automation.calibration = report
    }
    return report
  }

  async function confirmCalibrationPrediction(
    id: string,
    status: 'hit' | 'miss',
    note = '',
  ): Promise<void> {
    await apiRequest(
      `/api/calibration/predictions/${encodeURIComponent(id)}/confirm`,
      {
        method: 'POST',
        body: JSON.stringify({ status, note }),
      },
    )
  }

  async function updateAutomationSettings(
    patch: Record<string, unknown>,
  ): Promise<AutomationWorkspace> {
    const response = await apiRequest<{
      settings: unknown
      automation: AutomationWorkspace
    }>('/api/automation/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
    applyAutomation(response.automation)
    return response.automation
  }

  async function applyEvaluation(
    id: number,
    input: { rating?: string; summary?: string } = {},
  ): Promise<void> {
    const response = await apiRequest<{
      evaluation: unknown
      automation: AutomationWorkspace
      dashboard: DashboardPayload
    }>(`/api/evaluations/${id}/apply`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
    dashboard.value = response.dashboard
  }

  async function loadDecisionProposals(): Promise<DashboardPayload> {
    const response = await apiRequest<{ dashboard: DashboardPayload }>(
      '/api/decision-proposals',
    )
    dashboard.value = response.dashboard
    return response.dashboard
  }

  async function adoptDecisionProposal(
    id: number,
  ): Promise<DecisionProposalMutationResponse> {
    const response = await apiRequest<DecisionProposalMutationResponse>(
      `/api/decision-proposals/${id}/adopt`,
      { method: 'POST', body: '{}' },
    )
    dashboard.value = response.dashboard
    return response
  }

  async function rejectDecisionProposal(
    id: number,
    reason = '',
  ): Promise<DecisionProposalMutationResponse> {
    const response = await apiRequest<DecisionProposalMutationResponse>(
      `/api/decision-proposals/${id}/reject`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      },
    )
    dashboard.value = response.dashboard
    return response
  }

  async function undoEvaluation(id: number): Promise<void> {
    const response = await apiRequest<{
      evaluation: unknown
      automation: AutomationWorkspace
      dashboard: DashboardPayload
    }>(`/api/evaluations/${id}/undo`, {
      method: 'POST',
      body: '{}',
    })
    dashboard.value = response.dashboard
  }

  async function markNotification(
    id: number,
    action: 'read' | 'unread' | 'resolve',
  ): Promise<void> {
    await apiRequest(`/api/notifications/${id}/${action}`, {
      method: 'POST',
      body: '{}',
    })
    await loadAutomation()
  }

  async function markAllNotificationsRead(): Promise<void> {
    await apiRequest('/api/notifications/read-all', {
      method: 'POST',
      body: '{}',
    })
    await loadAutomation()
  }

  async function markInboxItem(
    id: number,
    action: 'read' | 'unread' | 'snooze' | 'unsnooze',
    input: { until?: string } = {},
  ): Promise<InboxCenter> {
    const response = await apiRequest<{
      inbox_center: InboxCenter
      dashboard: DashboardPayload
    }>(`/api/inbox/${id}/${action}`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
    dashboard.value = response.dashboard
    return response.inbox_center
  }

  async function markAllInboxRead(): Promise<InboxCenter> {
    const response = await apiRequest<{
      inbox_center: InboxCenter
      dashboard: DashboardPayload
    }>('/api/inbox/read-all', {
      method: 'POST',
      body: '{}',
    })
    dashboard.value = response.dashboard
    return response.inbox_center
  }

  async function resolveAutomationJob(
    id: number,
    status: 'done' | 'skipped' | 'failed',
    note = '',
  ): Promise<AutomationWorkspace> {
    const response = await apiRequest<{ automation: AutomationWorkspace }>(
      `/api/automation/jobs/${id}/resolve`,
      {
        method: 'POST',
        body: JSON.stringify({ status, note }),
      },
    )
    applyAutomation(response.automation)
    return response.automation
  }

  async function generateDraft(
    periodType: 'monthly' | 'quarterly',
    period: string,
  ): Promise<AutomationWorkspace> {
    const response = await apiRequest<{ automation: AutomationWorkspace }>(
      `/api/review/drafts/${periodType}/${encodeURIComponent(period)}/generate`,
      { method: 'POST', body: '{}' },
    )
    applyAutomation(response.automation)
    return response.automation
  }

  async function confirmDraft(
    periodType: 'monthly' | 'quarterly',
    period: string,
    input: { answers: string[]; conclusion: string },
  ): Promise<void> {
    const response = await apiRequest<{ dashboard: DashboardPayload }>(
      `/api/review/drafts/${periodType}/${encodeURIComponent(period)}/confirm`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    )
    dashboard.value = response.dashboard
  }

  async function loadTrades(): Promise<TradeOverviewResponse> {
    const response = await apiRequest<TradeOverviewResponse>('/api/trades')
    applyTradeOverview(response.overview)
    return response
  }

  async function createTrade(input: TradeInput): Promise<TradeMutationResponse> {
    const response = await apiRequest<TradeMutationResponse>('/api/trades', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    dashboard.value = response.dashboard
    return response
  }

  async function updateTrade(
    id: number,
    input: TradeInput,
  ): Promise<TradeMutationResponse> {
    const response = await apiRequest<TradeMutationResponse>(`/api/trades/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })
    dashboard.value = response.dashboard
    return response
  }

  async function confirmTrade(
    id: number,
    confirmDate: string,
  ): Promise<TradeMutationResponse> {
    const response = await apiRequest<TradeMutationResponse>(
      `/api/trades/${id}/confirm`,
      {
        method: 'POST',
        body: JSON.stringify({ confirm_date: confirmDate }),
      },
    )
    dashboard.value = response.dashboard
    return response
  }

  async function cancelTrade(
    id: number,
    note = '',
  ): Promise<TradeMutationResponse> {
    const response = await apiRequest<TradeMutationResponse>(
      `/api/trades/${id}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify({ note }),
      },
    )
    dashboard.value = response.dashboard
    return response
  }

  async function uploadTradeScreenshot(input: {
    filename: string
    mime: string
    data: string
  }): Promise<TradeInboxResponse> {
    const response = await apiRequest<TradeInboxResponse>('/api/trades/inbox', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    applyTradeOverview(response.overview)
    return response
  }

  async function uploadIncomeScreenshot(input: {
    filename: string
    mime: string
    data: string
  }): Promise<IncomeCaptureResponse> {
    const response = await apiRequest<IncomeCaptureResponse>('/api/income/inbox', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    dashboard.value = response.dashboard
    return response
  }

  async function applyIncomeScreenshot(
    id: number,
    input: IncomeInboxParsed,
  ): Promise<IncomeApplyResponse> {
    const response = await apiRequest<IncomeApplyResponse>(
      `/api/income/inbox/${id}/apply`,
      {
      method: 'POST',
      body: JSON.stringify(input),
      },
    )
    dashboard.value = response.dashboard
    return response
  }

  async function ignoreIncomeScreenshot(id: number): Promise<void> {
    const response = await apiRequest<{ dashboard: DashboardPayload }>(
      `/api/income/inbox/${id}/ignore`,
      {
        method: 'POST',
        body: JSON.stringify({ note: '忽略收益截图' }),
      },
    )
    dashboard.value = response.dashboard
  }

  async function loadProductValuationDetail(
    productCode: string,
  ): Promise<ProductValuationDetail> {
    const response = await apiRequest<{ detail: ProductValuationDetail }>(
      `/api/product-valuations?product_code=${encodeURIComponent(productCode)}`,
    )
    return response.detail
  }

  async function loadFactTrace(factType: string, factKey: string) {
    const response = await apiRequest<DataTrustTraceResponse>(
      `/api/facts/${encodeURIComponent(factType)}/${encodeURIComponent(factKey)}/trace`,
    )
    return response.fact_trace
  }

  async function saveProductValuation(
    input: ProductValuationInput,
  ): Promise<ProductValuationMutationResponse> {
    const response = await apiRequest<ProductValuationMutationResponse>(
      '/api/product-valuations',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    )
    dashboard.value = response.dashboard
    return response
  }

  async function updateProductValuation(
    id: number,
    input: ProductValuationInput,
  ): Promise<ProductValuationMutationResponse> {
    const response = await apiRequest<ProductValuationMutationResponse>(
      `/api/product-valuations/${id}`,
      {
        method: 'PUT',
        body: JSON.stringify(input),
      },
    )
    dashboard.value = response.dashboard
    return response
  }

  async function saveProductYieldSetting(
    productCode: string,
    input: ProductYieldSettingInput,
  ): Promise<ProductYieldSettingMutationResponse> {
    const response = await apiRequest<ProductYieldSettingMutationResponse>(
      `/api/product-yield-settings/${encodeURIComponent(productCode)}`,
      {
        method: 'PUT',
        body: JSON.stringify(input),
      },
    )
    dashboard.value = response.dashboard
    return response
  }

  async function updateTradeInbox(
    id: number,
    parsed: TradeInboxParsed,
  ): Promise<InboxMutationResponse> {
    const response = await apiRequest<InboxMutationResponse>(
      `/api/trades/inbox/${id}`,
      {
        method: 'PUT',
        body: JSON.stringify(parsed),
      },
    )
    applyTradeOverview(response.overview)
    return response
  }

  async function applyTradeInbox(
    id: number,
    parsed: TradeInboxParsed,
  ): Promise<InboxMutationResponse> {
    const response = await apiRequest<InboxMutationResponse>(
      `/api/trades/inbox/${id}/apply`,
      {
        method: 'POST',
        body: JSON.stringify(parsed),
      },
    )
    if (response.dashboard) {
      dashboard.value = response.dashboard
    } else {
      applyTradeOverview(response.overview)
    }
    return response
  }

  async function ignoreTradeInbox(id: number): Promise<InboxMutationResponse> {
    const response = await apiRequest<InboxMutationResponse>(
      `/api/trades/inbox/${id}/ignore`,
      {
        method: 'POST',
        body: JSON.stringify({ note: '忽略截图' }),
      },
    )
    applyTradeOverview(response.overview)
    return response
  }

  async function pruneTradeScreenshots(days = 180): Promise<InboxPruneResponse> {
    const response = await apiRequest<InboxPruneResponse>(
      '/api/trades/inbox/prune',
      {
        method: 'POST',
        body: JSON.stringify({ olderThanDays: days }),
      },
    )
    await loadTrades()
    return response
  }

  async function createDecision(
    input: DecisionInput,
  ): Promise<DecisionMutationResponse> {
    const response = await apiRequest<DecisionMutationResponse>('/api/review/decisions', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    dashboard.value = response.dashboard
    return response
  }

  async function updateDecision(
    id: number,
    input: DecisionInput,
  ): Promise<DecisionMutationResponse> {
    const response = await apiRequest<DecisionMutationResponse>(
      `/api/review/decisions/${id}`,
      {
        method: 'PUT',
        body: JSON.stringify(input),
      },
    )
    dashboard.value = response.dashboard
    return response
  }

  async function deleteDecision(id: number): Promise<DeleteResponse> {
    const response = await apiRequest<DeleteResponse>(`/api/review/decisions/${id}`, {
      method: 'DELETE',
    })
    dashboard.value = response.dashboard
    return response
  }

  async function createHolding(input: HoldingInput): Promise<HoldingMutationResponse> {
    const response = await apiRequest<HoldingMutationResponse>('/api/review/holdings', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    dashboard.value = response.dashboard
    return response
  }

  async function updateHolding(
    id: number,
    input: HoldingInput,
  ): Promise<HoldingMutationResponse> {
    const response = await apiRequest<HoldingMutationResponse>(
      `/api/review/holdings/${id}`,
      {
        method: 'PUT',
        body: JSON.stringify(input),
      },
    )
    dashboard.value = response.dashboard
    return response
  }

  async function deleteHolding(id: number): Promise<DeleteResponse> {
    const response = await apiRequest<DeleteResponse>(`/api/review/holdings/${id}`, {
      method: 'DELETE',
    })
    dashboard.value = response.dashboard
    return response
  }

  async function createProductEvent(
    input: ProductEventInput,
  ): Promise<ProductEventMutationResponse> {
    const response = await apiRequest<ProductEventMutationResponse>('/api/review/events', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    dashboard.value = response.dashboard
    return response
  }

  async function updateProductEvent(
    id: number,
    input: ProductEventInput,
  ): Promise<ProductEventMutationResponse> {
    const response = await apiRequest<ProductEventMutationResponse>(
      `/api/review/events/${id}`,
      {
        method: 'PUT',
        body: JSON.stringify(input),
      },
    )
    dashboard.value = response.dashboard
    return response
  }

  async function deleteProductEvent(id: number): Promise<DeleteResponse> {
    const response = await apiRequest<DeleteResponse>(`/api/review/events/${id}`, {
      method: 'DELETE',
    })
    dashboard.value = response.dashboard
    return response
  }

  async function saveReviewNote(
    month: string,
    input: ReviewNoteInput,
  ): Promise<ReviewNoteMutationResponse> {
    const response = await apiRequest<ReviewNoteMutationResponse>(
      `/api/review/notes/${encodeURIComponent(month)}`,
      {
        method: 'PUT',
        body: JSON.stringify(input),
      },
    )
    dashboard.value = response.dashboard
    return response
  }

  async function saveQuarterlyNote(
    quarter: string,
    input: ReviewNoteInput,
  ): Promise<ReviewNoteMutationResponse> {
    const response = await apiRequest<ReviewNoteMutationResponse>(
      `/api/review/quarterly/${encodeURIComponent(quarter)}`,
      {
        method: 'PUT',
        body: JSON.stringify(input),
      },
    )
    dashboard.value = response.dashboard
    return response
  }

  return {
    dashboard,
    loading,
    capital,
    load,
    recordByDate,
    principalForDate,
    createRecord,
    updateRecord,
    deleteRecord,
    initializeCapital,
    updateCapital,
    createCapitalEvent,
    deleteCapitalEvent,
    refreshProducts,
    updateAllocationSettings,
    saveHoldingReviewSetting,
    loadAutomation,
    loadCalibration,
    confirmCalibrationPrediction,
    runAutomation,
    updateAutomationSettings,
    applyEvaluation,
    undoEvaluation,
    loadDecisionProposals,
    adoptDecisionProposal,
    rejectDecisionProposal,
    markNotification,
    markAllNotificationsRead,
    markInboxItem,
    markAllInboxRead,
    resolveAutomationJob,
    generateDraft,
    confirmDraft,
    loadTrades,
    createTrade,
    updateTrade,
    confirmTrade,
    cancelTrade,
    uploadTradeScreenshot,
    uploadIncomeScreenshot,
    applyIncomeScreenshot,
    ignoreIncomeScreenshot,
    loadProductValuationDetail,
    loadFactTrace,
    saveProductValuation,
    updateProductValuation,
    saveProductYieldSetting,
    updateTradeInbox,
    applyTradeInbox,
    ignoreTradeInbox,
    pruneTradeScreenshots,
    createDecision,
    updateDecision,
    deleteDecision,
    createHolding,
    updateHolding,
    deleteHolding,
    createProductEvent,
    updateProductEvent,
    deleteProductEvent,
    saveReviewNote,
    saveQuarterlyNote,
  }
})
