import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { apiRequest } from '@/api/client'
import type {
  CapitalEventInput,
  CapitalEventMutationResponse,
  CapitalInitInput,
  CapitalState,
  DashboardMutationResponse,
  DashboardPayload,
  DecisionInput,
  DecisionMutationResponse,
  DeleteResponse,
  HoldingInput,
  HoldingMutationResponse,
  LedgerRecord,
  ProductEventInput,
  ProductEventMutationResponse,
  ProductRefreshResponse,
  RecordInput,
  RecordMutationResponse,
  ReviewNoteInput,
  ReviewNoteMutationResponse,
} from '@/types/dashboard'

export const useDashboardStore = defineStore('dashboard', () => {
  const dashboard = ref<DashboardPayload | null>(null)
  const loading = ref(false)

  const capital = computed<CapitalState | null>(() => dashboard.value?.capital ?? null)

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
