<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import R2PageHeader from '@/components/r2/R2PageHeader.vue'
import R2SectionIndex from '@/components/r2/R2SectionIndex.vue'
import DecisionProposalPanel from '@/components/review/DecisionProposalPanel.vue'
import DecisionLogPanel from '@/components/review/DecisionLogPanel.vue'
import CalibrationPanel from '@/components/review/CalibrationPanel.vue'
import AutomationPanel from '@/components/review/AutomationPanel.vue'
import type { DashboardPayload } from '@/types/dashboard'

const props = defineProps<{
  dashboard: DashboardPayload
}>()

const workspace = computed(() => props.dashboard.workspace)
const pendingEvaluations = computed(
  () => props.dashboard.inbox_center.summary.by_source.evaluation?.pending ?? 0,
)
const pendingProposals = computed(
  () => props.dashboard.decision_proposals.summary.pending,
)
const wrongGood = computed(
  () =>
    workspace.value.decisions.filter(
      (item) => item.rating === '流程错误，结果好',
    ).length,
)

const sections = computed(() => [
  {
    id: 'proposals',
    label: '决策提案',
    meta:
      pendingProposals.value > 0
        ? `${pendingProposals.value} 条待采纳`
        : '暂无待采纳',
  },
  {
    id: 'decisions',
    label: '决策日志',
    meta: `${workspace.value.decisions.length} 条`,
  },
  {
    id: 'calibration',
    label: '预测校准',
    meta:
      props.dashboard.automation.calibration.total > 0
        ? `${props.dashboard.automation.calibration.total} 条`
        : '暂无到期预测',
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
      title="决策提案、决策日志、预测校准与自动评估"
      description="平台先提出有证据的配置或换仓提案；你采纳后仍需自行交易，再上传截图。平台匹配实际交易、记录偏差，并校准当时的可检验预测。"
    >
      <template #actions>
        <RouterLink
          v-if="pendingProposals > 0"
          class="r2-head-chip is-warn"
          :to="{ name: 'r2-evaluation', hash: '#proposals' }"
        >
          待采纳提案 · {{ pendingProposals }}
        </RouterLink>
        <RouterLink
          v-if="pendingEvaluations > 0"
          class="r2-head-chip is-warn"
          :to="{ name: 'r2-evaluation', hash: '#automation' }"
          title="待确认评估需要补齐证据后才能形成结论"
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
      <section id="proposals" class="rw-panel r2-anchor" aria-label="决策提案">
        <DecisionProposalPanel
          :proposals="dashboard.decision_proposals"
          :decisions="workspace.decisions"
        />
      </section>

      <section id="decisions" class="rw-panel r2-anchor" aria-label="决策日志">
        <DecisionLogPanel
          :decisions="workspace.decisions"
          :today="workspace.timeline.today"
          :trades="workspace.trades?.trades ?? []"
          :automation="dashboard.automation"
        />
      </section>

      <section id="calibration" class="rw-panel r2-anchor" aria-label="预测校准">
        <CalibrationPanel :report="dashboard.automation.calibration" />
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
