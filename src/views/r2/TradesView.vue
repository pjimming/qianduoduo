<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import R2PageHeader from '@/components/r2/R2PageHeader.vue'
import R2SectionIndex from '@/components/r2/R2SectionIndex.vue'
import TradeInboxPanel from '@/components/review/TradeInboxPanel.vue'
import TradesPanel from '@/components/review/TradesPanel.vue'
import HoldingsPanel from '@/components/review/HoldingsPanel.vue'
import type { DashboardPayload } from '@/types/dashboard'

const props = defineProps<{
  dashboard: DashboardPayload
}>()

const router = useRouter()
const overview = computed(() => props.dashboard.workspace.trades)
const today = computed(() => props.dashboard.workspace.timeline.today)
const pendingInbox = computed(
  () => overview.value?.inbox.filter((item) => item.status === 'pending').length ?? 0,
)

const sections = computed(() => [
  {
    id: 'inbox',
    label: '交易收件箱',
    meta: pendingInbox.value > 0 ? `${pendingInbox.value} 张待校正` : '无待校正',
  },
  {
    id: 'trades',
    label: '交易流水',
    meta: `${overview.value?.trades.length ?? 0} 笔`,
  },
  {
    id: 'holdings',
    label: '持仓结构',
    meta: `${props.dashboard.workspace.holdings.length} 个批次`,
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
      title="截图校正、交易流水与持仓结构"
      description="交易流水是持仓的唯一事实源：待确认交易只占额度，不进入集中度、期限桶和流动性比例；确认后再生成批次。"
    >
      <template #actions>
        <RouterLink class="button button-ghost button-small" :to="{ name: 'r2-products' }">
          去产品配置
        </RouterLink>
      </template>
    </R2PageHeader>

    <R2SectionIndex :items="sections" />

    <div class="r2-stack">
      <section id="inbox" class="rw-panel r2-anchor" aria-label="交易收件箱">
        <TradeInboxPanel
          v-if="overview"
          :inbox="overview.inbox"
          :today="today"
        />
        <div v-else class="rw-panel-body">
          <p class="rw-empty">交易数据还没有加载，请稍后刷新。</p>
        </div>
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

      <section id="holdings" class="rw-panel r2-anchor" aria-label="持仓结构">
        <HoldingsPanel
          :holdings="dashboard.workspace.holdings"
          :summary="dashboard.workspace.holdings_summary"
          :today="today"
          @open-trades="openTrades"
        />
      </section>
    </div>
  </div>
</template>
