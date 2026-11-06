<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import R2PageHeader from '@/components/r2/R2PageHeader.vue'
import R2SectionIndex from '@/components/r2/R2SectionIndex.vue'
import ProductsSection from '@/components/ProductsSection.vue'
import ProductEventsPanel from '@/components/review/ProductEventsPanel.vue'
import HoldingReviewPanel from '@/components/r2/HoldingReviewPanel.vue'
import HoldingPerformancePanel from '@/components/r2/HoldingPerformancePanel.vue'
import type { DashboardPayload } from '@/types/dashboard'

const props = defineProps<{
  dashboard: DashboardPayload
}>()

const route = useRoute()
const holdingPanel = ref<HTMLElement | null>(null)
const showingPerformance = computed(() => route.query.view === 'performance')

onMounted(() => {
  if (showingPerformance.value && route.hash === '#holding-reviews') {
    holdingPanel.value?.scrollIntoView({ behavior: 'instant' })
  }
})

const openEvents = computed(
  () => props.dashboard.inbox_center.summary.by_source.product_event?.pending ?? 0,
)

const reviewSummary = computed(() => props.dashboard.workspace.holding_reviews_summary)

const sections = computed(() => [
  { id: 'products', label: '配置目标与期限桶' },
  {
    id: 'holding-reviews',
    label: '当前持仓 vs 同桶候选',
    meta:
      reviewSummary.value.replace > 0
        ? `${reviewSummary.value.replace} 只建议替换`
        : `${reviewSummary.value.total} 只在持`,
  },
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
      title="配置目标、持仓复核与产品事件"
      description="先确认新资金的期限桶配置并查看观察名单，再核对当前持仓与同桶候选；短、中、长期限桶统一按 30、100、360 天比较，本次切换等待期不计收益，到期自动续作不重复扣空档。日开持仓改看短期限候选；买入前仍需在招行 App 核对额度、费率和交易规则。"
    >
      <template #actions>
        <RouterLink class="button button-ghost button-small" :to="{ name: 'r2-screening' }">
          选品初筛
        </RouterLink>
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
      <section id="products" class="r2-anchor" aria-label="配置目标与候选池">
        <ProductsSection :dashboard="dashboard">
          <template #after-allocation>
            <section
              id="holding-reviews"
              ref="holdingPanel"
              class="rw-panel r2-anchor"
              aria-label="持仓表现与复核"
            >
              <nav class="holding-view-switch" aria-label="持仓查看方式">
                <RouterLink
                  class="r2-index-link"
                  :aria-current="showingPerformance ? undefined : 'true'"
                  :to="{ name: 'r2-products', hash: '#holding-reviews' }"
                >逐只复核</RouterLink>
                <RouterLink
                  class="r2-index-link"
                  :aria-current="showingPerformance ? 'true' : undefined"
                  :to="{ name: 'r2-products', query: { view: 'performance' }, hash: '#holding-reviews' }"
                >收益排行</RouterLink>
              </nav>
              <HoldingReviewPanel
                v-show="!showingPerformance"
                :reviews="dashboard.workspace.holding_reviews"
                :today="dashboard.meta.today"
                :snapshot-date="dashboard.meta.product_snapshot_date"
                :history-date="dashboard.meta.product_history_date"
              />
              <HoldingPerformancePanel
                v-show="showingPerformance"
                :reviews="dashboard.workspace.holding_reviews"
                :performance="dashboard.workspace.holding_performance"
              />
            </section>
          </template>
        </ProductsSection>
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

<style scoped>
.holding-view-switch {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 16px 0;
}

.holding-view-switch .r2-index-link:not([aria-current='true']) {
  border-color: var(--muted);
  background: var(--card);
  color: var(--ink-soft);
}

.holding-view-switch .r2-index-link {
  min-height: 36px;
  border-radius: 10px;
}

.holding-view-switch .r2-index-link:not([aria-current='true']):hover {
  background: var(--green-wash);
}

.holding-view-switch .r2-index-link[aria-current='true'] {
  border-color: var(--green);
  background: var(--green-soft);
  color: var(--ink);
}

.holding-view-switch .r2-index-link:focus-visible {
  outline: 2px solid var(--green);
  outline-offset: 2px;
}
</style>
