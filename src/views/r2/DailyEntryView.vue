<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import R2PageHeader from '@/components/r2/R2PageHeader.vue'
import R2SectionIndex from '@/components/r2/R2SectionIndex.vue'
import QuickEntryPanel from '@/components/review/QuickEntryPanel.vue'
import LedgerTable from '@/components/LedgerTable.vue'
import CapitalPanel from '@/components/CapitalPanel.vue'
import CapitalInitDialog from '@/components/CapitalInitDialog.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import type { DashboardPayload } from '@/types/dashboard'

const props = defineProps<{
  dashboard: DashboardPayload
}>()

type ModuleKey =
  | 'inbox'
  | 'trades'
  | 'holdings'
  | 'events'
  | 'holding_reviews'
  | 'decisions'
  | 'automation'
  | 'monthly'
  | 'quarterly'

interface QuickEntryExposed {
  startRecord: (date: string) => void
  loadRecordForEdit: (date: string) => void
  resetForm: () => void
  isEditingDate: (date: string) => boolean
}

interface LedgerTableExposed {
  resetPage: () => void
}

const route = useRoute()
const router = useRouter()
const dashboardStore = useDashboardStore()
const { show } = useToast()

const quickRef = ref<QuickEntryExposed | null>(null)
const ledgerRef = ref<LedgerTableExposed | null>(null)
const capitalDialogOpen = ref(false)
const capitalDialogMode = ref<'init' | 'edit'>('init')
const pendingDeleteDate = ref<string | null>(null)
let promptTimer: number | undefined

const sections = [
  { id: 'today', label: '今日三件事' },
  { id: 'records', label: '历史记录' },
  { id: 'capital', label: '本金账户' },
]

const moduleRoutes: Record<
  ModuleKey,
  { name: string; hash: string }
> = {
  inbox: { name: 'r2-trades', hash: '#inbox' },
  trades: { name: 'r2-trades', hash: '#trades' },
  holdings: { name: 'r2-trades', hash: '#holdings' },
  events: { name: 'r2-products', hash: '#events' },
  holding_reviews: { name: 'r2-products', hash: '#holding-reviews' },
  decisions: { name: 'r2-evaluation', hash: '#decisions' },
  automation: { name: 'r2-evaluation', hash: '#automation' },
  monthly: { name: 'r2-review', hash: '#monthly-notes' },
  quarterly: { name: 'r2-review', hash: '#quarterly-notes' },
}

function openCapitalDialog(mode?: 'init' | 'edit'): void {
  capitalDialogMode.value =
    mode === 'edit' || (mode === undefined && Boolean(props.dashboard.capital.initialized))
      ? 'edit'
      : 'init'
  capitalDialogOpen.value = true
}

function goModule(key: ModuleKey): void {
  const target = moduleRoutes[key]
  if (!target) return
  void router.push(target)
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
    if (quickRef.value?.isEditingDate(date)) {
      quickRef.value.resetForm()
    }
    show('记录已删除')
  } catch (error) {
    show(error instanceof Error ? error.message : '删除失败', { error: true })
  }
}

function handleRecordSaved(): void {
  ledgerRef.value?.resetPage()
}

function applyRouteDate(): void {
  const date = typeof route.query.date === 'string' ? route.query.date : ''
  if (!date) return
  void nextTick(() => {
    quickRef.value?.startRecord(date)
  })
}

watch(
  () => route.query.date,
  () => applyRouteDate(),
)

onMounted(() => {
  applyRouteDate()
  if (!props.dashboard.capital.initialized) {
    promptTimer = window.setTimeout(() => {
      if (!props.dashboard.capital.initialized) {
        openCapitalDialog('init')
      }
    }, 240)
  }
})

onBeforeUnmount(() => {
  window.clearTimeout(promptTimer)
})
</script>

<template>
  <div class="r2-page">
    <R2PageHeader
      kicker="DAILY LEDGER"
      title="每天记一笔，本金与收益分开"
      description="成交截图、当日收益、特殊事项都在这里提交；历史记录和本金账户在下方核对。其他页面只读汇总，不再重复放录入表单。"
    >
      <template #actions>
        <RouterLink class="button button-ghost button-small" :to="{ name: 'r2-overview' }">
          看收益概览
        </RouterLink>
      </template>
    </R2PageHeader>

    <R2SectionIndex :items="sections" />

    <div class="r2-stack">
      <section id="today" class="r2-anchor" aria-label="今日三件事">
        <QuickEntryPanel
          ref="quickRef"
          :dashboard="dashboard"
          :workspace="dashboard.workspace"
          :automation="dashboard.automation"
          @saved="handleRecordSaved"
          @open-module="goModule"
        />
      </section>

      <section id="records" class="r2-anchor" aria-label="历史记录">
        <LedgerTable
          ref="ledgerRef"
          :records="dashboard.records"
          @edit="quickRef?.loadRecordForEdit($event)"
          @delete="handleDeleteRecord"
        />
      </section>

      <section id="capital" class="r2-anchor" aria-label="本金账户">
        <CapitalPanel :dashboard="dashboard" @open-init="openCapitalDialog()" />
      </section>
    </div>

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
  </div>
</template>
