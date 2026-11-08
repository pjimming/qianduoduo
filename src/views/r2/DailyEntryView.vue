<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import R2PageHeader from '@/components/r2/R2PageHeader.vue'
import WorkspaceNav from '@/components/r2/WorkspaceNav.vue'
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

const SECTIONS = ['today', 'records', 'capital'] as const
type Section = (typeof SECTIONS)[number]

const route = useRoute()
const router = useRouter()
const dashboardStore = useDashboardStore()
const { show } = useToast()

const quickRef = ref<QuickEntryExposed | null>(null)
const ledgerRef = ref<LedgerTableExposed | null>(null)
const capitalDialogOpen = ref(false)
const capitalDialogMode = ref<'init' | 'edit'>('init')
const pendingDeleteDate = ref<string | null>(null)
const pendingEditDate = ref('')
let appliedRequest = ''
let promptTimer: number | undefined

const section = computed<Section>(() => {
  const value = typeof route.query.section === 'string' ? route.query.section : ''
  return (SECTIONS as readonly string[]).includes(value) ? (value as Section) : 'today'
})

const navItems = computed(() => [
  { key: 'today', label: '两类截图', meta: '2 类' },
  {
    key: 'records',
    label: '历史记录',
    meta: `${props.dashboard.records.length} 条`,
    query: { date: undefined },
  },
  {
    key: 'capital',
    label: '本金账户',
    meta: props.dashboard.capital.initialized ? '已初始化' : '待初始化',
    query: { date: undefined },
  },
])

const moduleRoutes: Record<
  ModuleKey,
  { name: string; hash?: string; query?: Record<string, string | undefined> }
> = {
  inbox: { name: 'r2-trades', query: { section: 'inbox' } },
  trades: { name: 'r2-trades', query: { section: 'trades' } },
  holdings: { name: 'r2-trades', query: { section: 'holdings' } },
  events: { name: 'r2-products', hash: '#events' },
  holding_reviews: { name: 'r2-products', hash: '#holding-reviews' },
  decisions: { name: 'r2-evaluation', hash: '#decisions' },
  automation: { name: 'r2-evaluation', hash: '#automation' },
  monthly: { name: 'r2-review', query: { section: 'monthly-notes' } },
  quarterly: { name: 'r2-review', query: { section: 'quarterly-notes' } },
}

function dismissNotice(): void {
  void router.replace({ query: { ...route.query, notice: undefined } })
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

// 历史记录里点“编辑”后切到「两类截图」，由 pendingEditDate 承接具体日期。
function handleEditRecord(date: string): void {
  pendingEditDate.value = date
  if (section.value !== 'today') {
    void router.push({
      query: { ...route.query, date: undefined, section: 'today' },
    })
    return
  }
  void nextTick(applyRecordRequest)
}

// 只有「两类截图」分区承载录入表单；其它分区忽略 date 参数。
function applyRecordRequest(): void {
  if (section.value !== 'today') return
  const editDate = pendingEditDate.value
  const routeDate = typeof route.query.date === 'string' ? route.query.date : ''
  const date = editDate || routeDate
  if (!date) return
  const token = `${editDate ? 'edit' : 'new'}:${date}`
  if (token === appliedRequest) return
  appliedRequest = token
  pendingEditDate.value = ''
  void nextTick(() => {
    if (editDate) quickRef.value?.loadRecordForEdit(date)
    else quickRef.value?.startRecord(date)
  })
}

watch(
  [section, () => route.query.date],
  () => applyRecordRequest(),
  { flush: 'post' },
)

onMounted(() => {
  applyRecordRequest()
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
  <div class="r2-page daily-workspace">
    <R2PageHeader
      kicker="TWO UPLOADS ONLY"
      title="上传交易截图与收益截图，其余交给平台"
      description="手工录入交易前先写决策；截图自动入账时，平台会立即建立临时决策并提示补齐理由、预期、证据日和失效条件，补齐后才进入有效评估。三个分区各自独立：截图录入、历史记录、本金账户。"
    >
      <template #actions>
        <RouterLink class="button button-ghost button-small" :to="{ name: 'r2-overview' }">
          看收益概览
        </RouterLink>
      </template>
    </R2PageHeader>

    <WorkspaceNav :items="navItems" :active="section" label="每日记账分区" />

    <div
      v-if="route.query.notice === 'invalid-section'"
      class="rw-alert is-warn daily-notice"
      role="status"
    >
      <span>无法识别的分区参数，已回到「两类截图」。</span>
      <button type="button" class="link-button" @click="dismissNotice">知道了</button>
    </div>

    <section
      v-if="section === 'today'"
      id="today"
      class="r2-anchor daily-section"
      aria-label="两类截图"
    >
      <QuickEntryPanel
        ref="quickRef"
        :dashboard="dashboard"
        :workspace="dashboard.workspace"
        @saved="handleRecordSaved"
        @open-module="goModule"
      />
    </section>

    <section
      v-else-if="section === 'records'"
      id="records"
      class="r2-anchor daily-section"
      aria-label="历史记录"
    >
      <LedgerTable
        ref="ledgerRef"
        :records="dashboard.records"
        @edit="handleEditRecord"
        @delete="handleDeleteRecord"
      />
    </section>

    <section
      v-else
      id="capital"
      class="r2-anchor daily-section"
      aria-label="本金账户"
    >
      <CapitalPanel :dashboard="dashboard" @open-init="openCapitalDialog()" />
    </section>

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

<style scoped>
.daily-workspace {
  min-width: 0;
}

.daily-section {
  min-width: 0;
  scroll-margin-top: 76px;
}

.daily-notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  width: fit-content;
  max-width: 100%;
  margin-bottom: 14px;
}
</style>
