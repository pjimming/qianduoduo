<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import R2PageHeader from '@/components/r2/R2PageHeader.vue'
import R2SectionIndex from '@/components/r2/R2SectionIndex.vue'
import ProductsSection from '@/components/ProductsSection.vue'
import ProductEventsPanel from '@/components/review/ProductEventsPanel.vue'
import HoldingReviewPanel from '@/components/r2/HoldingReviewPanel.vue'
import type { DashboardPayload } from '@/types/dashboard'

const props = defineProps<{
  dashboard: DashboardPayload
}>()

const openEvents = computed(
  () => props.dashboard.inbox_center.summary.by_source.product_event?.pending ?? 0,
)

const reviewSummary = computed(() => props.dashboard.workspace.holding_reviews_summary)

const sections = computed(() => [
  {
    id: 'holding-reviews',
    label: '持仓复核与替换',
    meta:
      reviewSummary.value.replace > 0
        ? `${reviewSummary.value.replace} 只建议替换`
        : `${reviewSummary.value.total} 只在持`,
  },
  { id: 'products', label: '配置与候选池' },
  {
    id: 'events',
    label: '特殊事项',
    meta: openEvents.value > 0 ? `${openEvents.value} 条待复核` : '无待复核',
  },
])
</script>

<template>
  <div class="r2-page">
    <R2PageHeader
      kicker="PRODUCTS &amp; ALLOCATION"
      title="持仓复核、目标配置与产品事件"
      description="先核对当前持仓与同期限候选，日开持仓改看短期限（7–30 天）候选，再查看新增资金如何分配；公开数据只提供研究排序和分配上限，买入前仍需在招行 App 核对额度、费率和赎回规则。"
    >
      <template #actions>
        <RouterLink
          v-if="reviewSummary.replace > 0"
          class="r2-head-chip is-warn"
          :to="{ name: 'r2-products', hash: '#holding-reviews' }"
        >
          建议替换 · {{ reviewSummary.replace }}
        </RouterLink>
        <RouterLink
          v-if="openEvents > 0"
          class="r2-head-chip is-warn"
          :to="{ name: 'r2-products', hash: '#events' }"
        >
          特殊事项待复核 · {{ openEvents }}
        </RouterLink>
        <RouterLink class="button button-ghost button-small" :to="{ name: 'r2-trades' }">
          看持仓
        </RouterLink>
      </template>
    </R2PageHeader>

    <R2SectionIndex :items="sections" />

    <div class="r2-stack">
      <section id="holding-reviews" class="rw-panel r2-anchor" aria-label="持仓复核与替换">
        <HoldingReviewPanel
          :reviews="dashboard.workspace.holding_reviews"
          :today="dashboard.meta.today"
          :snapshot-date="dashboard.meta.product_snapshot_date"
          :history-date="dashboard.meta.product_history_date"
        />
      </section>

      <section id="products" class="r2-anchor" aria-label="配置与候选池">
        <ProductsSection :dashboard="dashboard" />
      </section>

      <section id="events" class="rw-panel r2-anchor" aria-label="产品事件">
        <ProductEventsPanel
          :events="dashboard.workspace.events"
          :today="dashboard.workspace.timeline.today"
        />
      </section>
    </div>
  </div>
</template>
