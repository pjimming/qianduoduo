<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import R2PageHeader from '@/components/r2/R2PageHeader.vue'
import WorkspaceNav from '@/components/r2/WorkspaceNav.vue'
import ReviewTimeline from '@/components/review/ReviewTimeline.vue'
import ReviewSection from '@/components/ReviewSection.vue'
import ReviewNotesPanel from '@/components/review/ReviewNotesPanel.vue'
import type { DashboardPayload } from '@/types/dashboard'

const props = defineProps<{
  dashboard: DashboardPayload
}>()

const route = useRoute()
const router = useRouter()
const workspace = computed(() => props.dashboard.workspace)
const latestMonth = computed(() => workspace.value.notes[0]?.month ?? '暂无')
const latestQuarter = computed(() => workspace.value.quarterly[0]?.quarter ?? '暂无')

const SECTIONS = ['score', 'rhythm', 'monthly-notes', 'quarterly-notes'] as const
type Section = (typeof SECTIONS)[number]

const section = computed<Section>(() => {
  const value = typeof route.query.section === 'string' ? route.query.section : ''
  return (SECTIONS as readonly string[]).includes(value) ? (value as Section) : 'score'
})

const navItems = computed(() => [
  {
    key: 'score',
    label: '日周月评分',
    meta: `${props.dashboard.review.monthly.length} 个月`,
  },
  {
    key: 'rhythm',
    label: '复盘节奏',
    meta: `${workspace.value.timeline.nodes.length} 个节点`,
  },
  {
    key: 'monthly-notes',
    label: '月度五问',
    meta: `${workspace.value.notes.length} 个月已保存`,
  },
  {
    key: 'quarterly-notes',
    label: '季度复盘',
    meta: `${workspace.value.quarterly.length} 个季度已保存`,
  },
])

function dismissNotice(): void {
  void router.replace({ query: { ...route.query, notice: undefined } })
}

function handleRecord(date: string): void {
  void router.push({ name: 'r2-daily', query: { section: 'today', date } })
}
</script>

<template>
  <div class="r2-page">
    <R2PageHeader
      kicker="REVIEW"
      title="日、周、月复盘的评分与记录"
      description="先看自动评分、记录缺口和提醒，再写月度五问与季度清单。评分只用于个人复盘，不构成收益承诺。"
    >
      <template #actions>
        <RouterLink class="button button-ghost button-small" :to="{ name: 'r2-daily' }">
          去补记
        </RouterLink>
      </template>
    </R2PageHeader>

    <WorkspaceNav :items="navItems" :active="section" label="复盘分区" />

    <div
      v-if="route.query.notice === 'invalid-section'"
      class="rw-alert is-warn review-notice"
      role="status"
    >
      <span>无法识别的分区参数，已回到默认分区。</span>
      <button type="button" class="link-button" @click="dismissNotice">知道了</button>
    </div>

    <div class="r2-stack">
      <section
        v-if="section === 'score'"
        id="score"
        class="review-module-card r2-anchor"
        aria-label="自动复盘评分"
      >
        <ReviewSection
          :review="dashboard.review"
          :notes="workspace.notes"
          :today="dashboard.meta.today"
          :reporting-date="dashboard.meta.reporting_date"
          @record="handleRecord"
        />
      </section>

      <section
        v-else-if="section === 'rhythm'"
        id="rhythm"
        class="review-module-card r2-anchor"
        aria-label="复盘节奏"
      >
        <header class="review-module-head">
          <div class="rw-card-heading">
            <p class="kicker">REVIEW RHYTHM</p>
            <h3 class="rw-panel-title">复盘节奏</h3>
            <p class="rw-panel-sub">
              每天记一笔、每周查一次、每月评分、每季复核；时间轴会标出当前该做哪一层。
            </p>
          </div>
        </header>
        <ReviewTimeline :timeline="workspace.timeline" />
      </section>

      <section
        v-else-if="section === 'monthly-notes'"
        id="monthly-notes"
        class="rw-panel r2-anchor"
        aria-label="月度五问"
      >
        <header class="review-notes-head">
          <span class="r2-fold-kicker">MONTHLY REVIEW</span>
          <strong>月度五问</strong>
          <small>
            每月 10 分钟回答五问 · 已保存 {{ workspace.notes.length }} 个月 · 最新
            {{ latestMonth }}
          </small>
        </header>
        <ReviewNotesPanel
          mode="monthly"
          :notes="workspace.notes"
          :today="workspace.timeline.today"
          :review="dashboard.review"
          :automation="dashboard.automation"
          :workspace="workspace"
        />
      </section>

      <section
        v-else
        id="quarterly-notes"
        class="rw-panel r2-anchor"
        aria-label="季度复盘"
      >
        <header class="review-notes-head">
          <span class="r2-fold-kicker">QUARTERLY REVIEW</span>
          <strong>季度复盘</strong>
          <small>
            每季 30 分钟复核结构 · 已保存 {{ workspace.quarterly.length }} 个季度 · 最新
            {{ latestQuarter }}
          </small>
        </header>
        <ReviewNotesPanel
          mode="quarterly"
          :notes="workspace.quarterly"
          :today="workspace.timeline.today"
          :review="dashboard.review"
          :automation="dashboard.automation"
          :workspace="workspace"
        />
      </section>
    </div>
  </div>
</template>

<style scoped>
.review-notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  width: fit-content;
  max-width: 100%;
  margin-bottom: 14px;
}

.review-notes-head {
  display: grid;
  gap: 3px;
  padding: 18px 22px 0;
}

.review-notes-head strong {
  color: var(--ink-soft);
  font-size: 14px;
}

.review-notes-head small {
  color: var(--muted);
  font-size: 12px;
}
</style>
