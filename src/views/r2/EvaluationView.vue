<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import R2PageHeader from '@/components/r2/R2PageHeader.vue'
import R2SectionIndex from '@/components/r2/R2SectionIndex.vue'
import DecisionLogPanel from '@/components/review/DecisionLogPanel.vue'
import AutomationPanel from '@/components/review/AutomationPanel.vue'
import type { DashboardPayload } from '@/types/dashboard'

const props = defineProps<{
  dashboard: DashboardPayload
}>()

const workspace = computed(() => props.dashboard.workspace)
const pendingEvaluations = computed(
  () => props.dashboard.inbox_center.summary.by_source.evaluation?.pending ?? 0,
)
const wrongGood = computed(
  () =>
    workspace.value.decisions.filter(
      (item) => item.rating === '流程错误，结果好',
    ).length,
)

const sections = computed(() => [
  {
    id: 'decisions',
    label: '决策日志',
    meta: `${workspace.value.decisions.length} 条`,
  },
  {
    id: 'automation',
    label: '自动评估',
    meta:
      pendingEvaluations.value > 0
        ? `${pendingEvaluations.value} 条待确认`
        : '队列为空',
  },
])
</script>

<template>
  <div class="r2-page">
    <R2PageHeader
      kicker="DECISIONS &amp; EVALUATION"
      title="决策日志与自动评估"
      description="先写下当时的理由、预期和失效条件，再由自动评估补证据。自动评估只把结果送进待确认队列，不代替人工判断。"
    >
      <template #actions>
        <RouterLink
          v-if="pendingEvaluations > 0"
          class="r2-head-chip is-warn"
          :to="{ name: 'r2-evaluation', hash: '#automation' }"
          title="自动评估只进入待确认队列，不代替人工判断"
        >
          待确认评估 · {{ pendingEvaluations }}
        </RouterLink>
        <span
          v-if="wrongGood > 0"
          class="r2-head-chip is-warn"
          title="流程错误但结果好的决策最容易让人误以为方法有效"
        >
          流程错误结果好 {{ wrongGood }} 条
        </span>
        <RouterLink class="button button-ghost button-small" :to="{ name: 'r2-review' }">
          去写复盘
        </RouterLink>
      </template>
    </R2PageHeader>

    <R2SectionIndex :items="sections" />

    <div class="r2-stack">
      <section id="decisions" class="rw-panel r2-anchor" aria-label="决策日志">
        <DecisionLogPanel
          :decisions="workspace.decisions"
          :today="workspace.timeline.today"
          :trades="workspace.trades?.trades ?? []"
          :automation="dashboard.automation"
        />
      </section>

      <section id="automation" class="rw-panel r2-anchor" aria-label="自动评估">
        <AutomationPanel
          :automation="dashboard.automation"
          :decisions="workspace.decisions"
          :today="workspace.timeline.today"
        />
      </section>
    </div>
  </div>
</template>
