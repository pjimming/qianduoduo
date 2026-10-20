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
const inboxSummary = computed(() => props.dashboard.inbox_center.summary)

const shortcuts = computed(() => [
  {
    key: 'trade-capture',
    to: { name: 'r2-daily', hash: '#capture-trade' },
    label: '交易截图',
    value: '完成操作后上传',
    hint: `待平台识别 ${pendingInbox.value} 张 · 高置信度自动进入持仓`,
    tone: pendingInbox.value > 0 ? 'is-warn' : 'is-done',
  },
  {
    key: 'income-capture',
    to: { name: 'r2-daily', hash: '#capture-income' },
    label: '收益截图',
    value: props.dashboard.meta.has_reporting_record ? '已自动记录' : '上传截图',
    hint: `${props.dashboard.meta.reporting_date} · 平台识别后更新收益曲线`,
    tone: props.dashboard.meta.has_reporting_record ? 'is-done' : 'is-warn',
  },
  {
    key: 'inbox',
    to: { name: 'r2-inbox' },
    label: '其余由平台完成',
    value: inboxSummary.value.pending_count
      ? `${inboxSummary.value.pending_count} 项例外待看`
      : '无需你维护',
    hint: `未读 ${inboxSummary.value.unread_count} · 交易、持仓、决策、追踪、评估、复盘已自动汇总`,
    tone: inboxSummary.value.pending_count > 0 ? 'is-warn' : 'is-done',
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

    <section class="r2-jump-grid is-capture-only" aria-label="你只需要做什么">
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
    <p class="overview-automation-note">
      当前平台状态：交易待确认 {{ pendingTrades }} 笔、
      待确认买入 ¥{{ pendingBuyAmount.toLocaleString('zh-CN') }}、
      待复核产品 {{ openEvents }} 条、自动评估 {{ pendingEvaluations }}
      条。这些项目由 AI 继续处理，只有无法自行消化的例外才会进入消息中心。
    </p>
  </div>
</template>
