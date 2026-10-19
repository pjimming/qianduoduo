<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  AutomationWorkspace,
  ReviewData,
  ReviewWorkspace,
} from '@/types/dashboard'
import ReviewTimeline from './ReviewTimeline.vue'
import DecisionLogPanel from './DecisionLogPanel.vue'
import TradesPanel from './TradesPanel.vue'
import TradeInboxPanel from './TradeInboxPanel.vue'
import AutomationPanel from './AutomationPanel.vue'
import HoldingsPanel from './HoldingsPanel.vue'
import ProductEventsPanel from './ProductEventsPanel.vue'
import ReviewNotesPanel from './ReviewNotesPanel.vue'

const props = defineProps<{
  workspace: ReviewWorkspace
  review: ReviewData
  automation: AutomationWorkspace
}>()

type TabKey =
  | 'decisions'
  | 'trades'
  | 'inbox'
  | 'holdings'
  | 'events'
  | 'automation'
  | 'monthly'
  | 'quarterly'

const activeTab = ref<TabKey>('decisions')

const tabs = computed(() => [
  { key: 'decisions' as const, label: '决策日志', count: props.workspace.decisions.length },
  {
    key: 'trades' as const,
    label: '交易流水',
    count: props.workspace.trades?.trades.length ?? 0,
  },
  {
    key: 'inbox' as const,
    label: '交易收件箱',
    count:
      props.workspace.trades?.inbox.filter((item) => item.status === 'pending').length ??
      0,
  },
  { key: 'holdings' as const, label: '持仓结构', count: props.workspace.holdings.length },
  {
    key: 'events' as const,
    label: '产品事件',
    count: props.workspace.events.filter((item) => item.status === '待复核').length,
  },
  {
    key: 'automation' as const,
    label: '自动评估',
    count: props.automation.pending_evaluations.length,
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
        :trades="workspace.trades?.trades || []"
        :automation="automation"
      />
      <TradesPanel
        v-if="workspace.trades"
        v-show="activeTab === 'trades'"
        :overview="workspace.trades"
        :decisions="workspace.decisions"
        :today="workspace.timeline.today"
      />
      <TradeInboxPanel
        v-if="workspace.trades"
        v-show="activeTab === 'inbox'"
        :inbox="workspace.trades.inbox"
        :today="workspace.timeline.today"
      />
      <HoldingsPanel
        v-show="activeTab === 'holdings'"
        :holdings="workspace.holdings"
        :summary="workspace.holdings_summary"
        :today="workspace.timeline.today"
        @open-trades="activeTab = 'trades'"
      />
      <ProductEventsPanel
        v-show="activeTab === 'events'"
        :events="workspace.events"
        :today="workspace.timeline.today"
      />
      <AutomationPanel
        v-show="activeTab === 'automation'"
        :automation="automation"
        :decisions="workspace.decisions"
        :today="workspace.timeline.today"
      />
      <ReviewNotesPanel
        v-show="activeTab === 'monthly'"
        mode="monthly"
        :notes="workspace.notes"
        :today="workspace.timeline.today"
        :review="review"
        :automation="automation"
        :workspace="workspace"
      />
      <ReviewNotesPanel
        v-show="activeTab === 'quarterly'"
        mode="quarterly"
        :notes="workspace.quarterly"
        :today="workspace.timeline.today"
        :review="review"
        :automation="automation"
        :workspace="workspace"
      />
    </div>
  </section>
</template>
