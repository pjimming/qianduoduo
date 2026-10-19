<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue'
import {
  formatDateShort,
  formatMoney,
} from '@/composables/useFormatters'
import type {
  AutomationWorkspace,
  DashboardPayload,
  ReviewData,
  ReviewWorkspace,
} from '@/types/dashboard'
import ReviewTimeline from './ReviewTimeline.vue'
import QuickEntryPanel from './QuickEntryPanel.vue'
import DecisionLogPanel from './DecisionLogPanel.vue'
import TradesPanel from './TradesPanel.vue'
import TradeInboxPanel from './TradeInboxPanel.vue'
import AutomationPanel from './AutomationPanel.vue'
import HoldingsPanel from './HoldingsPanel.vue'
import ProductEventsPanel from './ProductEventsPanel.vue'
import ReviewNotesPanel from './ReviewNotesPanel.vue'

const props = defineProps<{
  dashboard: DashboardPayload
  workspace: ReviewWorkspace
  review: ReviewData
  automation: AutomationWorkspace
}>()

const emit = defineEmits<{
  saved: [date: string]
}>()

type TabKey = 'ledger' | 'evaluation' | 'review'
type FoldKey =
  | 'inbox'
  | 'trades'
  | 'holdings'
  | 'events'
  | 'decisions'
  | 'automation'
  | 'monthly'
  | 'quarterly'

interface QuickEntryExposed {
  startRecord: (date: string) => void
  loadRecordForEdit: (date: string) => void
  resetForm: () => void
  isEditingDate: (date: string) => boolean
}

const activeTab = ref<TabKey>('ledger')
const quickRef = ref<QuickEntryExposed | null>(null)
const openFolds = reactive<Record<FoldKey, boolean>>({
  inbox: false,
  trades: false,
  holdings: false,
  events: false,
  decisions: false,
  automation: false,
  monthly: false,
  quarterly: false,
})

const trades = computed(() => props.workspace.trades?.trades ?? [])
const inbox = computed(() => props.workspace.trades?.inbox ?? [])
const pendingInbox = computed(
  () => inbox.value.filter((item) => item.status === 'pending').length,
)
const pendingTrades = computed(
  () => props.workspace.trades?.summary.pending_count ?? 0,
)
const openEvents = computed(
  () => props.workspace.events.filter((item) => item.status === '待复核').length,
)
const latestMonth = computed(() => props.workspace.notes[0]?.month ?? '—')
const latestQuarter = computed(() => props.workspace.quarterly[0]?.quarter ?? '—')
const latestDecision = computed(() => props.workspace.decisions[0]?.date ?? '—')

const tabs = computed(() => [
  {
    key: 'ledger' as const,
    label: '账本',
    count: pendingInbox.value + pendingTrades.value,
  },
  {
    key: 'evaluation' as const,
    label: '决策与评估',
    count: props.automation.pending_evaluations.length,
  },
  {
    key: 'review' as const,
    label: '月度与季度',
    count: props.automation.drafts.filter((item) => item.status === 'draft').length,
  },
])

const foldSummaries = computed<Record<FoldKey, string>>(() => {
  const eventMonth = props.dashboard.meta.today.slice(0, 7)
  const automationLast = props.automation.scheduler.last_run?.finished_at
  return {
    inbox: `${pendingInbox.value} 张待校正 · 共 ${inbox.value.length} 张`,
    trades: `${trades.value.length} 笔 · 待确认 ${pendingTrades.value} 笔`,
    holdings: `剩余本金 ¥${formatMoney(
      props.workspace.holdings_summary.total_amount,
      0,
    )} · ${props.workspace.holdings.length} 个批次`,
    events: `${openEvents.value} 条待复核 · 本月 ${
      props.workspace.events.filter((item) => item.date.startsWith(eventMonth)).length
    } 条`,
    decisions: `${props.workspace.decisions.length} 条 · 最近 ${latestDecision.value}`,
    automation: `待确认 ${
      props.automation.pending_evaluations.length
    } 条 · 上次 ${
      automationLast ? formatDateShort(automationLast.slice(0, 10)) : '未运行'
    }`,
    monthly: `${props.workspace.notes.length} 个月 · 最新 ${latestMonth.value}`,
    quarterly: `${props.workspace.quarterly.length} 个季度 · 最新 ${latestQuarter.value}`,
  }
})

function tabOf(key: FoldKey): TabKey {
  if (['inbox', 'trades', 'holdings', 'events'].includes(key)) return 'ledger'
  if (['decisions', 'automation'].includes(key)) return 'evaluation'
  return 'review'
}

function openModule(key: FoldKey): void {
  activeTab.value = tabOf(key)
  openFolds[key] = true
  void nextTick(() => {
    document
      .getElementById(`rw-fold-${key}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

function syncFold(key: FoldKey, event: Event): void {
  openFolds[key] = (event.target as HTMLDetailsElement).open
}

defineExpose({
  startRecord: (date: string) => quickRef.value?.startRecord(date),
  loadRecordForEdit: (date: string) => quickRef.value?.loadRecordForEdit(date),
  resetForm: () => quickRef.value?.resetForm(),
  isEditingDate: (date: string) => quickRef.value?.isEditingDate(date) ?? false,
})
</script>

<template>
  <section class="review-workspace" aria-labelledby="reviewWorkspaceTitle">
    <div class="section-head">
      <div>
        <p class="kicker">复盘工作台</p>
        <h2 id="reviewWorkspaceTitle">提交三件事，其余交给 AI</h2>
      </div>
      <span class="review-auto-badge">本地保存 · AI 维护</span>
    </div>

    <ReviewTimeline :timeline="workspace.timeline" />

    <QuickEntryPanel
      ref="quickRef"
      :dashboard="dashboard"
      :workspace="workspace"
      :automation="automation"
      @saved="emit('saved', $event)"
      @open-module="openModule"
    />

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

    <div class="rw-modules">
      <div v-show="activeTab === 'ledger'" class="rw-module-group">
        <details
          id="rw-fold-inbox"
          class="rw-fold"
          :open="openFolds.inbox"
          @toggle="syncFold('inbox', $event)"
        >
          <summary>
            <span>交易收件箱</span>
            <em>{{ foldSummaries.inbox }}</em>
          </summary>
          <TradeInboxPanel
            v-if="workspace.trades"
            :inbox="workspace.trades.inbox"
            :today="workspace.timeline.today"
          />
        </details>

        <details
          id="rw-fold-trades"
          class="rw-fold"
          :open="openFolds.trades"
          @toggle="syncFold('trades', $event)"
        >
          <summary>
            <span>交易流水</span>
            <em>{{ foldSummaries.trades }}</em>
          </summary>
          <TradesPanel
            v-if="workspace.trades"
            :overview="workspace.trades"
            :decisions="workspace.decisions"
            :today="workspace.timeline.today"
          />
        </details>

        <details
          id="rw-fold-holdings"
          class="rw-fold"
          :open="openFolds.holdings"
          @toggle="syncFold('holdings', $event)"
        >
          <summary>
            <span>持仓结构</span>
            <em>{{ foldSummaries.holdings }}</em>
          </summary>
          <HoldingsPanel
            :holdings="workspace.holdings"
            :summary="workspace.holdings_summary"
            :today="workspace.timeline.today"
            @open-trades="openModule('trades')"
          />
        </details>

        <details
          id="rw-fold-events"
          class="rw-fold"
          :open="openFolds.events"
          @toggle="syncFold('events', $event)"
        >
          <summary>
            <span>产品事件 / 特殊事项</span>
            <em>{{ foldSummaries.events }}</em>
          </summary>
          <ProductEventsPanel
            :events="workspace.events"
            :today="workspace.timeline.today"
          />
        </details>
      </div>

      <div v-show="activeTab === 'evaluation'" class="rw-module-group">
        <details
          id="rw-fold-decisions"
          class="rw-fold"
          :open="openFolds.decisions"
          @toggle="syncFold('decisions', $event)"
        >
          <summary>
            <span>决策日志</span>
            <em>{{ foldSummaries.decisions }}</em>
          </summary>
          <DecisionLogPanel
            :decisions="workspace.decisions"
            :today="workspace.timeline.today"
            :trades="trades"
            :automation="automation"
          />
        </details>

        <details
          id="rw-fold-automation"
          class="rw-fold"
          :open="openFolds.automation"
          @toggle="syncFold('automation', $event)"
        >
          <summary>
            <span>自动评估</span>
            <em>{{ foldSummaries.automation }}</em>
          </summary>
          <AutomationPanel
            :automation="automation"
            :decisions="workspace.decisions"
            :today="workspace.timeline.today"
          />
        </details>
      </div>

      <div v-show="activeTab === 'review'" class="rw-module-group">
        <details
          id="rw-fold-monthly"
          class="rw-fold"
          :open="openFolds.monthly"
          @toggle="syncFold('monthly', $event)"
        >
          <summary>
            <span>月度五问</span>
            <em>{{ foldSummaries.monthly }}</em>
          </summary>
          <ReviewNotesPanel
            mode="monthly"
            :notes="workspace.notes"
            :today="workspace.timeline.today"
            :review="review"
            :automation="automation"
            :workspace="workspace"
          />
        </details>

        <details
          id="rw-fold-quarterly"
          class="rw-fold"
          :open="openFolds.quarterly"
          @toggle="syncFold('quarterly', $event)"
        >
          <summary>
            <span>季度复盘</span>
            <em>{{ foldSummaries.quarterly }}</em>
          </summary>
          <ReviewNotesPanel
            mode="quarterly"
            :notes="workspace.quarterly"
            :today="workspace.timeline.today"
            :review="review"
            :automation="automation"
            :workspace="workspace"
          />
        </details>
      </div>
    </div>
  </section>
</template>
