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
  DeleteResponse,
  LedgerRecord,
  ProductRefreshResponse,
  RecordInput,
  RecordMutationResponse,
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
  }
})
