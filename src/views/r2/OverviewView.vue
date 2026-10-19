<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import HeroSection from '@/components/HeroSection.vue'
import StatsGrid from '@/components/StatsGrid.vue'
import AssetChart from '@/components/AssetChart.vue'
import PnlChart from '@/components/PnlChart.vue'
import type { DashboardPayload } from '@/types/dashboard'

const props = defineProps<{
  dashboard: DashboardPayload
}>()

const pendingInbox = computed(
  () =>
    props.dashboard.workspace.trades?.inbox.filter(
      (item) => item.status === 'pending',
    ).length ?? 0,
)
const pendingTrades = computed(
  () => props.dashboard.workspace.trades?.summary.pending_count ?? 0,
)
const pendingBuyAmount = computed(
  () => props.dashboard.workspace.trades?.summary.pending_buy_amount ?? 0,
)
const openEvents = computed(
  () =>
    props.dashboard.workspace.events.filter((item) => item.status === '待复核')
      .length,
)
const pendingEvaluations = computed(
  () => props.dashboard.automation.pending_evaluations.length,
)

const shortcuts = computed(() => [
  {
    key: 'daily',
    to: { name: 'r2-daily' },
    label: '今日收益',
    value: props.dashboard.meta.has_today_record ? '已记' : '待记',
    hint: props.dashboard.meta.has_today_record
      ? '今天已有记录，可继续补截图或特殊事项'
      : '花一分钟记下今天的盈亏',
    tone: props.dashboard.meta.has_today_record ? 'is-done' : 'is-warn',
  },
  {
    key: 'trades',
    to: { name: 'r2-trades' },
    label: '交易待确认',
    value: `${pendingTrades.value} 笔`,
    hint:
      pendingTrades.value > 0
        ? `待确认买入 ¥${pendingBuyAmount.value.toLocaleString('zh-CN')} · 截图待校正 ${pendingInbox.value} 张`
        : `截图待校正 ${pendingInbox.value} 张`,
    tone: pendingTrades.value + pendingInbox.value > 0 ? 'is-warn' : 'is-done',
  },
  {
    key: 'products',
    to: { name: 'r2-products' },
    label: '产品待复核',
    value: `${openEvents.value} 条`,
    hint:
      openEvents.value > 0
        ? '费率、额度、赎回规则等变化需要确认'
        : '暂无待复核的产品事件',
    tone: openEvents.value > 0 ? 'is-warn' : 'is-done',
  },
  {
    key: 'evaluation',
    to: { name: 'r2-evaluation' },
    label: '评估待确认',
    value: `${pendingEvaluations.value} 条`,
    hint:
      pendingEvaluations.value > 0
        ? '自动评估停在队列里，等人工判断'
        : '自动评估队列为空',
    tone: pendingEvaluations.value > 0 ? 'is-warn' : 'is-done',
  },
])
</script>

<template>
  <div class="r2-page r2-page-overview">
    <HeroSection :today="dashboard.meta.today" :summary="dashboard.summary" />
    <StatsGrid
      :summary="dashboard.summary"
      :windows="dashboard.windows"
      :records="dashboard.records"
    />

    <section class="r2-overview-charts" aria-label="收益图表">
      <AssetChart :records="dashboard.records" />
      <PnlChart :records="dashboard.records" />
    </section>

    <section class="r2-jump-grid" aria-label="今天先做什么">
      <RouterLink
        v-for="item in shortcuts"
        :key="item.key"
        :to="item.to"
        class="r2-jump-card"
        :class="item.tone"
      >
        <span class="r2-jump-label">{{ item.label }}</span>
        <strong>{{ item.value }}</strong>
        <small>{{ item.hint }}</small>
      </RouterLink>
    </section>
  </div>
</template>
