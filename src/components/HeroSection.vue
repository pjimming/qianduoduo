<script setup lang="ts">
import { computed } from 'vue'
import type { Summary } from '@/types/dashboard'
import { formatDateCN, formatPct, formatPp } from '@/composables/useFormatters'

const props = defineProps<{
  today: string
  summary: Summary
}>()

const targetBarStyle = computed(() => {
  const annualized = props.summary.annualized_pct
  const value =
    annualized === null ? 0 : Math.max(0, Math.min(100, (annualized / 3) * 100))
  return { width: `${value}%` }
})

const targetHint = computed(() => {
  const summary = props.summary
  if (!summary.record_count) {
    return '记录满 28 天、20 条后，年化与目标差距才具参考意义。'
  }
  if (summary.record_count < 2) {
    return '已经记下第一天。再记录一天后，就能看到年化参考值。'
  }
  if (!summary.sample_sufficient) {
    return `已记录 ${summary.calendar_days} 天 / ${summary.record_count} 条；满 28 天后，目标差距更适合做判断。`
  }
  if (summary.target_gap_pct !== null && summary.target_gap_pct >= 0) {
    return `记录期年化高于 3% 目标 ${formatPp(
      summary.target_gap_pct,
      2,
      true,
    )}，仍需同时看回撤和流动性。`
  }
  if (summary.target_gap_pct !== null) {
    return `距 3% 目标还差 ${formatPp(
      Math.abs(summary.target_gap_pct),
      2,
    )}；不要用杠杆或短期年化补缺口。`
  }
  return '记录满 28 天、20 条后，年化与目标差距才具参考意义。'
})
</script>

<template>
  <section class="hero">
    <div class="hero-copy">
      <p class="eyebrow">R2 DAILY LEDGER · <span>{{ formatDateCN(today) }}</span></p>
      <h1>每天一笔，<br /><em>看见复利。</em></h1>
    </div>

    <aside class="target-card" aria-label="3% 年化目标进度">
      <div class="target-head">
        <span class="target-label">3% 进取目标</span>
        <span class="target-status">{{ summary.target_status }}</span>
      </div>
      <div class="target-value-row">
        <strong>{{ formatPct(summary.annualized_pct, 2, true) }}</strong>
        <span>记录期年化（参考）</span>
      </div>
      <div class="target-track" aria-hidden="true">
        <span :style="targetBarStyle"></span>
      </div>
      <p class="target-hint">{{ targetHint }}</p>
      <p class="target-disclaimer">目标不是承诺。R2 不保本，短期年化噪音较大。</p>
    </aside>
  </section>
</template>

<style scoped>
.target-track span {
  display: block;
}
</style>
