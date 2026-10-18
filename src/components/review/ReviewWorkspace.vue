<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ReviewData, ReviewWorkspace } from '@/types/dashboard'
import ReviewTimeline from './ReviewTimeline.vue'
import DecisionLogPanel from './DecisionLogPanel.vue'
import HoldingsPanel from './HoldingsPanel.vue'
import ProductEventsPanel from './ProductEventsPanel.vue'
import ReviewNotesPanel from './ReviewNotesPanel.vue'

const props = defineProps<{
  workspace: ReviewWorkspace
  review: ReviewData
}>()

type TabKey = 'decisions' | 'holdings' | 'events' | 'monthly' | 'quarterly'

const activeTab = ref<TabKey>('decisions')

const tabs = computed(() => [
  { key: 'decisions' as const, label: '决策日志', count: props.workspace.decisions.length },
  { key: 'holdings' as const, label: '持仓结构', count: props.workspace.holdings.length },
  {
    key: 'events' as const,
    label: '产品事件',
    count: props.workspace.events.filter((item) => item.status === '待复核').length,
  },
  { key: 'monthly' as const, label: '月度五问', count: props.workspace.notes.length },
  { key: 'quarterly' as const, label: '季度复盘', count: props.workspace.quarterly.length },
])
</script>

<template>
  <section class="review-workspace" aria-labelledby="reviewWorkspaceTitle">
    <div class="section-head">
      <div>
        <p class="kicker">复盘工作台</p>
        <h2 id="reviewWorkspaceTitle">把判断、持仓和规则变化留下来</h2>
      </div>
      <span class="review-auto-badge">本地保存</span>
    </div>

    <ReviewTimeline :timeline="workspace.timeline" />

    <div class="rw-tabs" role="tablist" aria-label="复盘工作台分区">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="rw-tab"
        :class="{ 'is-active': activeTab === tab.key }"
        role="tab"
        :aria-selected="activeTab === tab.key"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
        <span v-if="tab.count > 0" class="rw-tab-count">{{ tab.count }}</span>
      </button>
    </div>

    <div class="rw-panel" role="tabpanel">
      <DecisionLogPanel
        v-show="activeTab === 'decisions'"
        :decisions="workspace.decisions"
        :today="workspace.timeline.today"
      />
      <HoldingsPanel
        v-show="activeTab === 'holdings'"
        :holdings="workspace.holdings"
        :summary="workspace.holdings_summary"
        :today="workspace.timeline.today"
      />
      <ProductEventsPanel
        v-show="activeTab === 'events'"
        :events="workspace.events"
        :today="workspace.timeline.today"
      />
      <ReviewNotesPanel
        v-show="activeTab === 'monthly'"
        mode="monthly"
        :notes="workspace.notes"
        :today="workspace.timeline.today"
        :review="review"
      />
      <ReviewNotesPanel
        v-show="activeTab === 'quarterly'"
        mode="quarterly"
        :notes="workspace.quarterly"
        :today="workspace.timeline.today"
        :review="review"
      />
    </div>
  </section>
</template>
