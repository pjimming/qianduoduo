<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import R2PageHeader from '@/components/r2/R2PageHeader.vue'
import WorkspaceNav from '@/components/r2/WorkspaceNav.vue'
import ProductsSection from '@/components/ProductsSection.vue'
import ProductEventsPanel from '@/components/review/ProductEventsPanel.vue'
import HoldingReviewPanel from '@/components/r2/HoldingReviewPanel.vue'
import HoldingPerformancePanel from '@/components/r2/HoldingPerformancePanel.vue'
import { useDashboardStore } from '@/stores/dashboard'
import type { DashboardPayload } from '@/types/dashboard'
import ScreeningView from './ScreeningView.vue'
import StrategyWorkspacePanel from '@/components/r2/StrategyWorkspacePanel.vue'
import { getStrategyWorkspace } from '@/api/r2-strategy'
import type { StrategyWorkspace } from '@/types/r2-strategy'

const props = defineProps<{
  dashboard?: DashboardPayload | null
}>()

const route = useRoute()
const router = useRouter()
const store = useDashboardStore()
const { dashboard: storeDashboard } = storeToRefs(store)

const data = computed<DashboardPayload | null>(
  () => storeDashboard.value ?? props.dashboard ?? null,
)

const SECTIONS = ['screening', 'allocation', 'holdings'] as const
type Section = (typeof SECTIONS)[number]

const section = computed<Section>(() => {
  const value = typeof route.query.section === 'string' ? route.query.section : ''
  return (SECTIONS as readonly string[]).includes(value) ? (value as Section) : 'allocation'
})

const holdingsView = computed<'review' | 'performance' | 'events'>(() => {
  if (section.value !== 'holdings') return 'review'
  if (route.hash === '#events') return 'events'
  return route.query.view === 'performance' ? 'performance' : 'review'
})

const strategy = ref<StrategyWorkspace | null>(null)
const strategyError = ref('')
const strategyLoading = ref(false)
let strategyController: AbortController | null = null
async function loadStrategy(): Promise<void> {
  strategyController?.abort()
  const controller = new AbortController()
  strategyController = controller
  strategyLoading.value = true
  strategyError.value = ''
  try {
    const value = await getStrategyWorkspace(controller.signal)
    if (!controller.signal.aborted) strategy.value = value
  } catch (caught) {
    if (!controller.signal.aborted) strategyError.value = caught instanceof Error ? caught.message : '读取当前策略失败'
  } finally { if (!controller.signal.aborted) strategyLoading.value = false }
}
// 候选初筛不依赖账本，但“资金配置”标签的可分配金额来自策略快照，进入页面即预取。
watch(section, (next) => {
  if (next !== 'screening' || !strategy.value) void loadStrategy()
}, { immediate: true })
onUnmounted(() => strategyController?.abort())

const ledgerError = ref('')
const ledgerLoading = ref(false)
const ledgerReady = computed(
  () => Boolean(data.value?.products && data.value?.workspace?.holding_reviews),
)
let ledgerToken = 0

async function ensureLedger(force = false): Promise<void> {
  if (section.value === 'screening' && !force) return
  if (!force && ledgerReady.value) return
  const token = ++ledgerToken
  ledgerLoading.value = true
  ledgerError.value = ''
  try {
    await store.load('products')
    if (token !== ledgerToken) return
  } catch (caught) {
    if (token !== ledgerToken) return
    ledgerError.value =
      caught instanceof Error && caught.message ? caught.message : '读取账本失败'
  } finally {
    if (token === ledgerToken) ledgerLoading.value = false
  }
}

watch(section, () => void ensureLedger(), { immediate: true })

function dismissNotice(): void {
  void router.replace({ query: { ...route.query, notice: undefined } })
}

const reviewSummary = computed(() => data.value?.workspace.holding_reviews_summary)
const openEvents = computed(
  () => data.value?.inbox_center.summary.by_source.product_event?.pending ?? 0,
)
const holdingProductCount = computed(() => {
  const rows = strategy.value?.result?.monitoring.rows
  return rows ? new Set(rows.map(row => row.product_code)).size : null
})

const strategyMeta = computed(() => {
  if (strategy.value?.mode !== 'v9' || strategyError.value || strategy.value.contract_matches === false ||
      strategy.value.stale || !strategy.value.result) return null
  return {
    cash: strategy.value.result.allocation.available_cents / 100,
    holdings: holdingProductCount.value,
  }
})
const allocationMeta = computed(() => {
  const cash = strategy.value?.mode === 'v9' ? strategyMeta.value?.cash : strategy.value?.mode === 'legacy' ? data.value?.products?.allocation?.available_cash : undefined
  return cash == null ? '' : `可分配 ¥${Math.round(cash).toLocaleString('zh-CN')}`
})
const holdingsMeta = computed(() => {
  if (strategyMeta.value) return `${strategyMeta.value.holdings} 只在持`
  if (strategy.value?.mode !== 'legacy') return ''
  const summary = reviewSummary.value
  if (!summary) return ''
  return summary.replace > 0 ? `${summary.replace} 只建议替换` : `${summary.total} 只在持`
})

const navItems = computed(() => [
  {
    key: 'screening',
    label: '候选初筛',
    query: { channel: undefined, code: undefined, lot: undefined, view: undefined },
  },
  {
    key: 'allocation',
    label: '资金配置',
    meta: allocationMeta.value,
  },
  {
    key: 'holdings',
    label: '持仓复核',
    meta: holdingsMeta.value,
  },
])

function holdingsLink(
  view: 'review' | 'performance' | 'events',
): { path: string; query: Record<string, string | undefined>; hash: string } {
  return {
    path: route.path,
    query: {
      ...route.query,
      notice: undefined,
      section: 'holdings',
      view: view === 'performance' ? 'performance' : undefined,
    },
    hash: view === 'events' ? '#events' : '',
  }
}
</script>

<template>
  <div class="r2-page products-workspace">
    <R2PageHeader
      kicker="PRODUCTS &amp; ALLOCATION"
      title="选品与配置"
      description="先看公开初筛有哪些合格份额，再决定资金怎么分配到期限桶，最后复核现有持仓该继续、待核还是退出。初筛只读公开证据；配置与持仓使用本地账本，账本读不到时初筛仍可查看。"
    >
      <template #actions>
        <span class="r2-head-chip">初筛 v9 · 公开证据</span>
        <RouterLink class="button button-ghost button-small" :to="{ name: 'r2-trades' }">
          看实际持仓
        </RouterLink>
        <RouterLink
          class="button button-ghost button-small"
          :to="{ name: 'r2-evaluation', query: { section: 'proposals' } }"
        >
          决策与评估
        </RouterLink>
      </template>
    </R2PageHeader>

    <WorkspaceNav :items="navItems" :active="section" label="选品与配置分区" />

    <div
      v-if="route.query.notice === 'invalid-section'"
      class="r2-inline-notice is-warn"
      role="status"
    >
      <span>无法识别的分区参数，已回到默认分区。</span>
      <button type="button" class="link-button" @click="dismissNotice">知道了</button>
    </div>

    <section
      v-if="section === 'screening'"
      id="screening"
      class="products-section-body"
      aria-label="候选初筛"
    >
      <ScreeningView embedded />
    </section>

    <template v-else>
      <section
        v-if="ledgerError"
        class="dashboard-error-state products-ledger-error"
        role="alert"
      >
        <p class="kicker">LOCAL LEDGER</p>
        <h2>账本暂时读不到</h2>
        <p>{{ ledgerError }}</p>
        <p class="dashboard-error-hint">
          候选初筛只依赖公开初筛库，可切换到「候选初筛」继续查看；资金配置和持仓复核需要本地账本。
        </p>
        <button
          class="button button-primary button-small"
          type="button"
          data-testid="products-ledger-retry"
          @click="ensureLedger(true)"
        >
          重新读取账本
        </button>
      </section>

      <p v-else-if="ledgerLoading && !ledgerReady" class="products-skeleton" role="status">
        正在读取本地账本…
      </p>

      <section
        v-else-if="section === 'allocation'"
        id="allocation"
        class="products-section-body"
        aria-label="资金配置"
      >
        <p v-if="strategyLoading && !strategy" role="status">正在读取当前策略…</p>
        <div v-else-if="strategyError" class="rw-alert is-warn" role="alert">{{ strategyError }} <button type="button" class="link-button" @click="loadStrategy">重新读取策略</button></div>
        <StrategyWorkspacePanel v-else-if="strategy?.mode === 'v9'" :workspace="strategy" section="allocation" @refresh="loadStrategy" />
        <ProductsSection v-else-if="data && strategy?.mode === 'legacy'" :dashboard="data" />
        <p v-else-if="strategy">当前策略模式暂不提供配置建议。</p>
      </section>

      <section
        v-else-if="section === 'holdings'"
        id="holding-reviews"
        class="products-section-body r2-anchor"
        aria-label="持仓复核"
      >
        <nav class="holding-view-switch r2-view-switch" aria-label="持仓查看方式">
          <RouterLink
            class="r2-index-link"
            :aria-current="holdingsView === 'review' ? 'true' : undefined"
            :to="holdingsLink('review')"
          >
            逐只复核
            <span v-if="strategy?.mode === 'v9'">{{ holdingProductCount ?? '—' }}</span>
            <span v-else-if="reviewSummary">{{ reviewSummary.total }}</span>
          </RouterLink>
          <RouterLink
            class="r2-index-link"
            :aria-current="holdingsView === 'performance' ? 'true' : undefined"
            :to="holdingsLink('performance')"
          >
            收益排行
          </RouterLink>
          <RouterLink
            class="r2-index-link"
            :aria-current="holdingsView === 'events' ? 'true' : undefined"
            :to="holdingsLink('events')"
          >
            产品事件
            <span v-if="openEvents">{{ openEvents }}</span>
          </RouterLink>
        </nav>

        <div v-if="data && holdingsView === 'review'" :class="strategy?.mode === 'v9' ? '' : 'rw-panel'">
          <p v-if="strategyLoading && !strategy" role="status">正在读取当前策略…</p>
          <div v-else-if="strategyError" class="rw-alert is-warn" role="alert">{{ strategyError }} <button type="button" class="link-button" @click="loadStrategy">重新读取策略</button></div>
          <StrategyWorkspacePanel
            v-else-if="strategy?.mode === 'v9'"
            :workspace="strategy"
            :holding-reviews="data.workspace.holding_reviews"
            section="holdings"
            @refresh="loadStrategy"
          />
          <HoldingReviewPanel v-else-if="strategy?.mode === 'legacy'"
            :reviews="data.workspace.holding_reviews"
            :today="data.meta.today"
            :snapshot-date="data.meta.product_snapshot_date"
            :history-date="data.meta.product_history_date"
          />
          <p v-else-if="strategy">当前策略模式暂不提供持仓动作。</p>
        </div>
        <div v-else-if="data && holdingsView === 'performance'" class="rw-panel">
          <HoldingPerformancePanel
            :reviews="data.workspace.holding_reviews"
            :performance="data.workspace.holding_performance"
          />
        </div>
        <div v-else-if="data" id="events" class="rw-panel">
          <ProductEventsPanel
            :events="data.workspace.events"
            :today="data.workspace.timeline.today"
          />
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.products-workspace {
  min-width: 0;
}
.products-section-body {
  min-width: 0;
}
.products-skeleton {
  margin: 18px 0;
  padding: 22px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--card);
  color: var(--ink-soft);
  font-size: 13px;
}
.products-ledger-error {
  margin-top: 18px;
}
</style>
