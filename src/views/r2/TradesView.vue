<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import R2PageHeader from '@/components/r2/R2PageHeader.vue'
import R2SectionIndex from '@/components/r2/R2SectionIndex.vue'
import TradeInboxPanel from '@/components/review/TradeInboxPanel.vue'
import TradesPanel from '@/components/review/TradesPanel.vue'
import HoldingsPanel from '@/components/review/HoldingsPanel.vue'
import ProductValuationPanel from '@/components/r2/ProductValuationPanel.vue'
import type { DashboardPayload } from '@/types/dashboard'

const props = defineProps<{
  dashboard: DashboardPayload
}>()

const router = useRouter()
const overview = computed(() => props.dashboard.workspace.trades)
const today = computed(() => props.dashboard.workspace.timeline.today)
const pendingInbox = computed(
  () => props.dashboard.inbox_center.summary.by_source.trade_screenshot?.pending ?? 0,
)

const sections = computed(() => [
  {
    id: 'holdings',
    label: '当前持仓',
    meta: `${props.dashboard.workspace.holdings.length} 个未赎回批次`,
  },
  {
    id: 'valuations',
    label: '产品收益',
    meta: `${props.dashboard.workspace.product_valuation_summaries.length} 只产品`,
  },
  {
    id: 'trades',
    label: '交易流水',
    meta: `${overview.value?.trades.length ?? 0} 笔`,
  },
  {
    id: 'inbox',
    label: '交易收件箱',
    meta: pendingInbox.value > 0 ? `${pendingInbox.value} 张待校正` : '无待校正',
  },
])

function openTrades(): void {
  void router.push({ name: 'r2-trades', hash: '#trades' })
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
          :to="{ name: 'r2-trades', hash: '#inbox' }"
        >
          交易截图待校正 · {{ pendingInbox }}
        </RouterLink>
        <RouterLink class="button button-ghost button-small" :to="{ name: 'r2-products' }">
          去产品配置
        </RouterLink>
      </template>
    </R2PageHeader>

    <R2SectionIndex :items="sections" />

    <div class="r2-stack">
      <section id="holdings" class="rw-panel r2-anchor" aria-label="持仓结构">
        <HoldingsPanel
          :holdings="dashboard.workspace.holdings"
          :summary="dashboard.workspace.holdings_summary"
          :today="today"
          @open-trades="openTrades"
        />
      </section>

      <section id="valuations" class="rw-panel r2-anchor" aria-label="产品收益">
        <ProductValuationPanel
          :summaries="dashboard.workspace.product_valuation_summaries"
          :reconciliation="dashboard.workspace.product_valuation_reconciliation"
          :today="today"
        />
      </section>

      <section id="trades" class="rw-panel r2-anchor" aria-label="交易流水">
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

      <section id="inbox" class="rw-panel r2-anchor" aria-label="交易收件箱">
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
