<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import R2PageHeader from '@/components/r2/R2PageHeader.vue'
import WorkspaceNav from '@/components/r2/WorkspaceNav.vue'
import DecisionProposalPanel from '@/components/review/DecisionProposalPanel.vue'
import DecisionLogPanel from '@/components/review/DecisionLogPanel.vue'
import CalibrationPanel from '@/components/review/CalibrationPanel.vue'
import AutomationPanel from '@/components/review/AutomationPanel.vue'
import { useDashboardStore } from '@/stores/dashboard'
import type { DashboardPayload } from '@/types/dashboard'

const props = defineProps<{
  dashboard?: DashboardPayload | null
}>()

const route = useRoute()
const router = useRouter()
const store = useDashboardStore()
const { dashboard: storeDashboard } = storeToRefs(store)

const data = computed<DashboardPayload | null>(
  () => storeDashboard.value ?? props.dashboard ?? null,
)

const SECTIONS = ['proposals', 'decisions', 'results'] as const
type Section = (typeof SECTIONS)[number]

const section = computed<Section>(() => {
  const value = typeof route.query.section === 'string' ? route.query.section : ''
  return (SECTIONS as readonly string[]).includes(value) ? (value as Section) : 'proposals'
})

const resultsView = computed<'evaluations' | 'calibration'>(() =>
  route.query.view === 'calibration' ? 'calibration' : 'evaluations',
)

const decisions = computed(() => data.value?.workspace.decisions ?? [])
const pendingProposals = computed(
  () => data.value?.decision_proposals.summary.pending ?? 0,
)
const pendingEvaluations = computed(
  () => data.value?.inbox_center.summary.by_source.evaluation?.pending ?? 0,
)
const wrongGood = computed(
  () => decisions.value.filter((decision) => decision.rating === '流程错误，结果好').length,
)

const navItems = computed(() => [
  {
    key: 'proposals',
    label: '待处理提案',
    meta: pendingProposals.value ? `${pendingProposals.value} 条待处理` : '',
  },
  {
    key: 'decisions',
    label: '决策记录',
    meta: decisions.value.length ? `${decisions.value.length} 条` : '',
  },
  {
    key: 'results',
    label: '评估与校准',
    meta: wrongGood.value
      ? `${wrongGood.value} 条待校准`
      : pendingEvaluations.value
        ? `${pendingEvaluations.value} 条待评估`
        : '',
  },
])

function resultsLink(view: 'evaluations' | 'calibration') {
  return {
    path: route.path,
    query: {
      ...route.query,
      notice: undefined,
      section: 'results',
      view,
    },
    hash: '',
  }
}

function dismissNotice(): void {
  void router.replace({ query: { ...route.query, notice: undefined } })
}
</script>

<template>
  <div class="r2-page evaluation-workspace">
    <R2PageHeader
      kicker="DECISIONS &amp; EVALUATION"
      title="决策与评估"
      description="把待执行提案、已执行决策和结果评价分开看：提案只在你确认后进入待执行；决策记录保留原因、预期与验证；结果区回看流程与收益是否一致。"
    >
      <template #actions>
        <span class="r2-head-chip">
          待处理提案 <strong>{{ pendingProposals }}</strong>
        </span>
        <RouterLink class="button button-ghost button-small" :to="{ name: 'r2-trades' }">
          去成交与上传
        </RouterLink>
      </template>
    </R2PageHeader>

    <WorkspaceNav :items="navItems" :active="section" label="决策与评估分区" />

    <div
      v-if="route.query.notice === 'invalid-section'"
      class="r2-inline-notice is-warn"
      role="status"
    >
      <span>无法识别的分区参数，已回到默认分区。</span>
      <button type="button" class="link-button" @click="dismissNotice">知道了</button>
    </div>

    <p v-if="!data" class="evaluation-skeleton" role="status">正在读取账本…</p>

    <template v-else>
      <section
        v-if="section === 'proposals'"
        id="proposals"
        class="evaluation-section r2-anchor"
        aria-label="待处理提案"
      >
        <div class="rw-panel">
          <DecisionProposalPanel
            :proposals="data.decision_proposals"
            :decisions="decisions"
          />
        </div>
      </section>

      <section
        v-else-if="section === 'decisions'"
        id="decisions"
        class="evaluation-section r2-anchor"
        aria-label="决策记录"
      >
        <div class="rw-panel">
          <DecisionLogPanel
            :decisions="decisions"
            :today="data.meta.today"
            :trades="data.workspace.trades?.trades ?? []"
            :automation="data.automation"
          />
        </div>
      </section>

      <section
        v-else
        id="results"
        class="evaluation-section r2-anchor"
        aria-label="评估与校准"
      >
        <nav class="results-view-switch r2-view-switch" aria-label="结果查看方式">
          <RouterLink
            class="r2-index-link"
            :aria-current="resultsView === 'evaluations' ? 'true' : undefined"
            :to="resultsLink('evaluations')"
          >
            结果评价
            <span v-if="pendingEvaluations">{{ pendingEvaluations }} 条待评估</span>
          </RouterLink>
          <RouterLink
            class="r2-index-link"
            :aria-current="resultsView === 'calibration' ? 'true' : undefined"
            :to="resultsLink('calibration')"
          >
            评价校准
            <span v-if="wrongGood">{{ wrongGood }} 条待校准</span>
          </RouterLink>
        </nav>

        <div v-if="resultsView === 'evaluations'" id="automation" class="rw-panel">
          <AutomationPanel
            :automation="data.automation"
            :decisions="decisions"
            :today="data.meta.today"
          />
        </div>
        <div v-else id="calibration" class="rw-panel">
          <CalibrationPanel :report="data.automation.calibration" />
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.evaluation-workspace {
  min-width: 0;
}
.evaluation-section {
  min-width: 0;
}
.evaluation-skeleton {
  margin: 18px 0;
  padding: 22px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--card);
  color: var(--ink-soft);
  font-size: 13px;
}
</style>
