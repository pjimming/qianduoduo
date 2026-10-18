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
import EntryForm from '@/components/EntryForm.vue'
import PnlChart from '@/components/PnlChart.vue'
import ReviewSection from '@/components/ReviewSection.vue'
import ProductsSection from '@/components/ProductsSection.vue'
import LedgerTable from '@/components/LedgerTable.vue'

interface EntryFormExposed {
  loadRecordForEdit: (date: string, focus?: boolean) => void
  resetForm: () => void
  isEditingDate: (date: string) => boolean
}

interface LedgerTableExposed {
  resetPage: () => void
}

const dashboardStore = useDashboardStore()
const { dashboard } = storeToRefs(dashboardStore)
const { show } = useToast()

const entryRef = ref<EntryFormExposed | null>(null)
const ledgerRef = ref<LedgerTableExposed | null>(null)
const capitalDialogOpen = ref(false)
const capitalDialogMode = ref<'init' | 'edit'>('init')
const capitalPromptShown = ref(false)
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

async function handleDeleteRecord(date: string): Promise<void> {
  const confirmed = window.confirm(`确认删除 ${date} 的记录？删除后无法恢复。`)
  if (!confirmed) return
  try {
    await dashboardStore.deleteRecord(date)
    if (entryRef.value?.isEditingDate(date)) {
      entryRef.value.resetForm()
    }
    show('记录已删除')
  } catch (error) {
    show(error instanceof Error ? error.message : '删除失败', { error: true })
  }
}

function handleRecordSaved(): void {
  ledgerRef.value?.resetPage()
}

onMounted(async () => {
  try {
    await dashboardStore.load()
    await nextTick()
    entryRef.value?.resetForm()
    maybePromptCapital()
  } catch (error) {
    show(error instanceof Error ? error.message : '读取数据失败', {
      error: true,
      duration: 6000,
    })
  }
})

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
    <section class="work-grid">
      <AssetChart :records="dashboard.records" />
      <EntryForm ref="entryRef" :dashboard="dashboard" @saved="handleRecordSaved" />
    </section>
    <PnlChart :records="dashboard.records" />
    <ReviewSection :review="dashboard.review" />
    <ProductsSection :dashboard="dashboard" />
    <LedgerTable
      ref="ledgerRef"
      :records="dashboard.records"
      @edit="entryRef?.loadRecordForEdit($event)"
      @delete="handleDeleteRecord"
    />

    <CapitalInitDialog
      v-model:open="capitalDialogOpen"
      :mode="capitalDialogMode"
      :capital="dashboard.capital"
      :today="dashboard.meta.today"
    />
  </template>
</template>

