<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import HeroSection from '@/components/HeroSection.vue'
import StatsGrid from '@/components/StatsGrid.vue'
import CapitalPanel from '@/components/CapitalPanel.vue'
import CapitalInitDialog from '@/components/CapitalInitDialog.vue'
import AssetChart from '@/components/AssetChart.vue'
import PnlChart from '@/components/PnlChart.vue'
import ReviewSection from '@/components/ReviewSection.vue'
import ReviewWorkspace from '@/components/review/ReviewWorkspace.vue'
import ProductsSection from '@/components/ProductsSection.vue'
import LedgerTable from '@/components/LedgerTable.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

interface ReviewWorkspaceExposed {
  startRecord: (date: string) => void
  loadRecordForEdit: (date: string) => void
  resetForm: () => void
  isEditingDate: (date: string) => boolean
}

interface LedgerTableExposed {
  resetPage: () => void
}

const dashboardStore = useDashboardStore()
const { dashboard } = storeToRefs(dashboardStore)
const { show } = useToast()

const reviewRef = ref<ReviewWorkspaceExposed | null>(null)
const ledgerRef = ref<LedgerTableExposed | null>(null)
const capitalDialogOpen = ref(false)
const capitalDialogMode = ref<'init' | 'edit'>('init')
const capitalPromptShown = ref(false)
const initialLoadDone = ref(false)
const loadError = ref('')
const pendingDeleteDate = ref<string | null>(null)
let promptTimer: number | undefined

function openCapitalDialog(mode?: 'init' | 'edit'): void {
  capitalDialogMode.value =
    mode === 'edit' || (mode === undefined && Boolean(dashboard.value?.capital.initialized))
      ? 'edit'
      : 'init'
  capitalDialogOpen.value = true
}

function maybePromptCapital(): void {
  if (
    capitalPromptShown.value ||
    !dashboard.value ||
    dashboard.value.capital.initialized
  ) {
    return
  }
  capitalPromptShown.value = true
  window.clearTimeout(promptTimer)
  promptTimer = window.setTimeout(() => {
    if (!dashboard.value?.capital.initialized) {
      openCapitalDialog('init')
    }
  }, 240)
}

function handleDeleteRecord(date: string): void {
  pendingDeleteDate.value = date
}

async function confirmDeleteRecord(): Promise<void> {
  const date = pendingDeleteDate.value
  pendingDeleteDate.value = null
  if (!date) return
  try {
    await dashboardStore.deleteRecord(date)
    if (reviewRef.value?.isEditingDate(date)) {
      reviewRef.value.resetForm()
    }
    show('记录已删除')
  } catch (error) {
    show(error instanceof Error ? error.message : '删除失败', { error: true })
  }
}

function handleRecordSaved(): void {
  ledgerRef.value?.resetPage()
}

function handleReviewRecord(date: string): void {
  if (dashboardStore.recordByDate(date)) {
    reviewRef.value?.loadRecordForEdit(date)
  } else {
    reviewRef.value?.startRecord(date)
  }
}

async function loadDashboard(): Promise<void> {
  loadError.value = ''
  try {
    await dashboardStore.load()
    await nextTick()
    maybePromptCapital()
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '读取数据失败'
    show(loadError.value, {
      error: true,
      duration: 6000,
    })
  } finally {
    initialLoadDone.value = true
  }
}

onMounted(loadDashboard)

onUnmounted(() => {
  window.clearTimeout(promptTimer)
})
</script>

<template>
  <template v-if="dashboard">
    <HeroSection :today="dashboard.meta.today" :summary="dashboard.summary" />
    <StatsGrid
      :summary="dashboard.summary"
      :windows="dashboard.windows"
      :records="dashboard.records"
    />
    <CapitalPanel :dashboard="dashboard" @open-init="openCapitalDialog()" />
    <section class="work-grid is-single">
      <AssetChart :records="dashboard.records" />
    </section>
    <PnlChart :records="dashboard.records" />
    <ReviewSection
      :review="dashboard.review"
      :notes="dashboard.workspace.notes"
      :today="dashboard.meta.today"
      @record="handleReviewRecord"
    />
    <ReviewWorkspace
      ref="reviewRef"
      :dashboard="dashboard"
      :workspace="dashboard.workspace"
      :review="dashboard.review"
      :automation="dashboard.automation"
      @saved="handleRecordSaved"
    />
    <ProductsSection :dashboard="dashboard" />
    <LedgerTable
      ref="ledgerRef"
      :records="dashboard.records"
      @edit="reviewRef?.loadRecordForEdit($event)"
      @delete="handleDeleteRecord"
    />

    <CapitalInitDialog
      v-model:open="capitalDialogOpen"
      :mode="capitalDialogMode"
      :capital="dashboard.capital"
      :today="dashboard.meta.today"
    />

    <ConfirmDialog
      :open="Boolean(pendingDeleteDate)"
      title="删除这条收益记录？"
      :message="`${pendingDeleteDate ?? ''} 的记录删除后无法恢复，相关统计会立即重算。`"
      confirm-label="删除记录"
      danger
      @confirm="confirmDeleteRecord"
      @update:open="pendingDeleteDate = null"
    />
  </template>
  <section
    v-else-if="!initialLoadDone || dashboardStore.loading"
    class="dashboard-skeleton"
    aria-live="polite"
    aria-busy="true"
  >
    <div class="skeleton-hero">
      <span class="skeleton-line is-short"></span>
      <span class="skeleton-line is-title"></span>
      <span class="skeleton-line"></span>
    </div>
    <div class="skeleton-grid">
      <span v-for="index in 5" :key="index" class="skeleton-card"></span>
    </div>
    <span class="skeleton-panel"></span>
    <p class="skeleton-caption">正在读取本地账本…</p>
  </section>
  <section v-else class="dashboard-error-state" role="alert">
    <p class="kicker">LOCAL LEDGER</p>
    <h1>账本暂时读不到</h1>
    <p>{{ loadError || '本地服务没有返回数据。' }}</p>
    <p class="dashboard-error-hint">
      请确认服务仍在运行（<code>npm run prod:status</code>），或检查
      <code>data/r2_ledger.sqlite</code> 是否可读。
    </p>
    <button class="button button-primary button-small" type="button" @click="loadDashboard">
      重新加载
    </button>
  </section>
</template>

