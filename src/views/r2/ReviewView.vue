<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import R2PageHeader from '@/components/r2/R2PageHeader.vue'
import R2SectionIndex from '@/components/r2/R2SectionIndex.vue'
import ReviewTimeline from '@/components/review/ReviewTimeline.vue'
import ReviewSection from '@/components/ReviewSection.vue'
import ReviewNotesPanel from '@/components/review/ReviewNotesPanel.vue'
import type { DashboardPayload } from '@/types/dashboard'

const props = defineProps<{
  dashboard: DashboardPayload
}>()

const router = useRouter()
const workspace = computed(() => props.dashboard.workspace)
const latestMonth = computed(() => workspace.value.notes[0]?.month ?? '暂无')
const latestQuarter = computed(() => workspace.value.quarterly[0]?.quarter ?? '暂无')

const sections = computed(() => [
  {
    id: 'rhythm',
    label: '复盘节奏',
    meta: `${workspace.value.timeline.nodes.length} 个节点`,
  },
  {
    id: 'score',
    label: '日周月评分',
    meta: `${props.dashboard.review.monthly.length} 个月`,
  },
  {
    id: 'monthly-notes',
    label: '月度五问',
    meta: `${workspace.value.notes.length} 个月已保存`,
  },
  {
    id: 'quarterly-notes',
    label: '季度复盘',
    meta: `${workspace.value.quarterly.length} 个季度已保存`,
  },
])

function handleRecord(date: string): void {
  void router.push({ name: 'r2-daily', query: { date } })
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

    <R2SectionIndex :items="sections" />

    <div class="r2-stack">
      <section id="rhythm" class="review-module-card r2-anchor" aria-label="复盘节奏">
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

      <section id="score" class="review-module-card r2-anchor" aria-label="自动复盘评分">
        <ReviewSection
          :review="dashboard.review"
          :notes="workspace.notes"
          :today="dashboard.meta.today"
          :reporting-date="dashboard.meta.reporting_date"
          @record="handleRecord"
        />
      </section>

      <details id="monthly-notes" class="rw-panel r2-fold r2-anchor">
        <summary>
          <span>
            <span class="r2-fold-kicker">MONTHLY REVIEW</span>
            <strong>月度五问</strong>
            <small>
              每月 10 分钟回答五问 · 已保存 {{ workspace.notes.length }} 个月 · 最新
              {{ latestMonth }}
            </small>
          </span>
          <em aria-hidden="true"></em>
        </summary>
        <ReviewNotesPanel
          mode="monthly"
          :notes="workspace.notes"
          :today="workspace.timeline.today"
          :review="dashboard.review"
          :automation="dashboard.automation"
          :workspace="workspace"
        />
      </details>

      <details id="quarterly-notes" class="rw-panel r2-fold r2-anchor">
        <summary>
          <span>
            <span class="r2-fold-kicker">QUARTERLY REVIEW</span>
            <strong>季度复盘</strong>
            <small>
              每季 30 分钟复核结构 · 已保存 {{ workspace.quarterly.length }} 个季度 · 最新
              {{ latestQuarter }}
            </small>
          </span>
          <em aria-hidden="true"></em>
        </summary>
        <ReviewNotesPanel
          mode="quarterly"
          :notes="workspace.quarterly"
          :today="workspace.timeline.today"
          :review="dashboard.review"
          :automation="dashboard.automation"
          :workspace="workspace"
        />
      </details>
    </div>
  </div>
</template>
