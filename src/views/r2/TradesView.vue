<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import R2PageHeader from '@/components/r2/R2PageHeader.vue'
import WorkspaceNav from '@/components/r2/WorkspaceNav.vue'
import TradeInboxPanel from '@/components/review/TradeInboxPanel.vue'
import TradesPanel from '@/components/review/TradesPanel.vue'
import HoldingsPanel from '@/components/review/HoldingsPanel.vue'
import CurrentHoldingsValuationPanel from '@/components/r2/CurrentHoldingsValuationPanel.vue'
import ProductValuationPanel from '@/components/r2/ProductValuationPanel.vue'
import type { DashboardPayload } from '@/types/dashboard'

const props = defineProps<{
  dashboard: DashboardPayload
}>()

const route = useRoute()
const router = useRouter()
const overview = computed(() => props.dashboard.workspace.trades)
const reportingDate = computed(() => props.dashboard.meta.reporting_date)
const today = computed(() => props.dashboard.workspace.timeline.today)
const pendingInbox = computed(
  () => props.dashboard.inbox_center.summary.by_source.trade_screenshot?.pending ?? 0,
)

const SECTIONS = ['current-value', 'holdings', 'valuations', 'trades', 'inbox'] as const
type Section = (typeof SECTIONS)[number]

const section = computed<Section>(() => {
  const value = typeof route.query.section === 'string' ? route.query.section : ''
  return (SECTIONS as readonly string[]).includes(value) ? (value as Section) : 'current-value'
})

const currentValueMeta = computed(() => {
  const valuation = props.dashboard.workspace.current_holdings_valuation
  if (!valuation.available) return '暂无确认持仓'
  return `收益截至 ${valuation.income_as_of_date ?? valuation.as_of_date}`
})

const navItems = computed(() => [
  {
    key: 'current-value',
    label: '当前净值',
    meta: currentValueMeta.value,
    query: { product: undefined },
  },
  {
    key: 'holdings',
    label: '当前持仓',
    meta: `${props.dashboard.workspace.holdings.length} 个未赎回批次`,
    query: { product: undefined },
  },
  {
    key: 'valuations',
    label: '产品收益',
    meta: `${props.dashboard.workspace.product_valuation_summaries.length} 只产品`,
  },
  {
    key: 'trades',
    label: '交易流水',
    meta: `${overview.value?.trades.length ?? 0} 笔`,
    query: { product: undefined },
  },
  {
    key: 'inbox',
    label: '交易收件箱',
    meta: pendingInbox.value > 0 ? `${pendingInbox.value} 张待校正` : '无待校正',
    query: { product: undefined },
  },
])

function dismissNotice(): void {
  void router.replace({ query: { ...route.query, notice: undefined } })
}

function openTrades(): void {
  void router.push({
    name: 'r2-trades',
    query: { ...route.query, product: undefined, section: 'trades' },
  })
}
</script>

<template>
  <div class="r2-page">
    <R2PageHeader
      kicker="TRADES &amp; HOLDINGS"
      title="当前持仓、产品收益与交易记录"
      description="交易流水是持仓的唯一事实源：待确认买入只占额度，待确认赎回不改持仓；确认后才生成或扣减未赎回成本批次。"
    >
      <template #actions>
        <RouterLink
          v-if="pendingInbox > 0"
          class="r2-head-chip is-warn"
          :to="{ name: 'r2-trades', query: { section: 'inbox' } }"
        >
          交易截图待校正 · {{ pendingInbox }}
        </RouterLink>
        <RouterLink
          class="button button-ghost button-small"
          :to="{ name: 'r2-products', query: { view: 'performance' }, hash: '#holding-reviews' }"
        >
          持仓收益排行
        </RouterLink>
        <RouterLink class="button button-ghost button-small" :to="{ name: 'r2-products' }">
          去产品配置
        </RouterLink>
      </template>
    </R2PageHeader>

    <WorkspaceNav :items="navItems" :active="section" label="交易与持仓分区" />

    <div
      v-if="route.query.notice === 'invalid-section'"
      class="rw-alert is-warn trades-notice"
      role="status"
    >
      <span>无法识别的分区参数，已回到默认分区。</span>
      <button type="button" class="link-button" @click="dismissNotice">知道了</button>
    </div>

    <div class="r2-stack">
      <section
        v-if="section === 'current-value'"
        id="current-value"
        class="rw-panel r2-anchor"
        aria-label="当前已确认持仓净值"
      >
        <CurrentHoldingsValuationPanel
          :valuation="dashboard.workspace.current_holdings_valuation"
        />
      </section>

      <section
        v-else-if="section === 'holdings'"
        id="holdings"
        class="rw-panel r2-anchor"
        aria-label="持仓结构"
      >
        <HoldingsPanel
          :holdings="dashboard.workspace.holdings"
          :summary="dashboard.workspace.holdings_summary"
          :today="today"
          @open-trades="openTrades"
        />
      </section>

      <section
        v-else-if="section === 'valuations'"
        id="valuations"
        class="rw-panel r2-anchor"
        aria-label="产品收益"
      >
        <ProductValuationPanel
          :summaries="dashboard.workspace.product_valuation_summaries"
          :reconciliation="dashboard.workspace.product_valuation_reconciliation"
          :today="today"
          :reporting-date="reportingDate"
          :holdings="dashboard.workspace.holdings"
        />
      </section>

      <section
        v-else-if="section === 'trades'"
        id="trades"
        class="rw-panel r2-anchor"
        aria-label="交易流水"
      >
        <TradesPanel
          v-if="overview"
          :overview="overview"
          :decisions="dashboard.workspace.decisions"
          :today="today"
        />
        <div v-else class="rw-panel-body">
          <p class="rw-empty">交易数据还没有加载，请稍后刷新。</p>
        </div>
      </section>

      <section
        v-else
        id="inbox"
        class="rw-panel r2-anchor"
        aria-label="交易收件箱"
      >
        <TradeInboxPanel
          v-if="overview"
          :inbox="overview.inbox"
          :decisions="dashboard.workspace.decisions"
          :today="today"
        />
        <div v-else class="rw-panel-body">
          <p class="rw-empty">交易数据还没有加载，请稍后刷新。</p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.trades-notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  width: fit-content;
  max-width: 100%;
  margin-bottom: 14px;
}
</style>
