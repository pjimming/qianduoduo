<script setup lang="ts">
import { computed } from 'vue'
import type {
  CurrentHoldingsValuation,
  LedgerRecord,
  Summary,
} from '@/types/dashboard'
import {
  formatDateShort,
  formatMoney,
  formatPct,
  formatPp,
  formatSignedMoney,
} from '@/composables/useFormatters'

const props = defineProps<{
  summary: Summary
  windows: Record<'7' | '30' | '90', Summary>
  records: LedgerRecord[]
  valuation: CurrentHoldingsValuation
}>()

const hasRecords = computed(() => props.records.length > 0)
const lastRecord = computed(() => props.records.at(-1) ?? null)
const window30 = computed(() => props.windows['30'])
const annualized = computed(() => window30.value.annualized_pct)
const valuationBadge = computed(() => {
  if (!props.valuation.available) return '暂无确认持仓'
  if (!props.valuation.income_as_of_date) return '暂无收益记录'
  return `收益截至 ${formatDateShort(props.valuation.income_as_of_date)}`
})

const annualizedSub = computed(() => {
  if (annualized.value === null) return '至少需要两天记录'
  if (window30.value.target_gap_pct === null) return '近 30 日 · 样本不足'
  return `近 30 日 · 距 3% ${formatPp(window30.value.target_gap_pct, 2, true)}`
})

const sparkline = computed(() => {
  const values = props.records.slice(-24).map((record) => record.cumulative_pnl)
  if (values.length < 2) return null
  const width = 180
  const height = 44
  const padding = 4
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || Math.max(max * 0.001, 1)
  const points = values.map((value, index) => ({
    x: padding + (index / (values.length - 1)) * (width - padding * 2),
    y: height - padding - ((value - min) / span) * (height - padding * 2),
  }))
  const line = points
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`,
    )
    .join(' ')
  const first = points[0]
  const last = points.at(-1)
  if (!first || !last) return null
  return {
    line,
    area: `${line} L${last.x.toFixed(1)},${height} L${first.x.toFixed(1)},${height} Z`,
    last,
  }
})

function tone(value: number | null): string {
  if (value === null || value === 0) return 'neutral'
  return value > 0 ? 'positive' : 'negative'
}
</script>

<template>
  <section class="stats-grid" aria-label="收益概览">
    <article class="stat-card stat-primary">
      <div class="stat-head stat-primary-head">
        <span>已确认持仓净值</span>
        <span class="soft-badge stat-date-badge">{{ valuationBadge }}</span>
      </div>
      <strong class="stat-value">
        {{
          valuation.available && valuation.current_value !== null
            ? `¥${formatMoney(valuation.current_value)}`
            : '—'
        }}
      </strong>
      <div
        v-if="valuation.available && valuation.current_value !== null"
        class="stat-primary-breakdown"
        aria-label="已确认持仓构成"
      >
        <span class="stat-primary-metric">
          <span>本金</span>
          <strong>¥{{ formatMoney(valuation.active_cost) }}</strong>
        </span>
        <span class="stat-primary-metric is-gain">
          <span>产品收益</span>
          <strong>{{ formatSignedMoney(valuation.product_income) }}</strong>
        </span>
      </div>
      <p v-else class="stat-sub">尚无已确认产品持仓</p>
      <div v-if="sparkline" class="stat-spark-band">
        <span class="stat-spark-label">收益走势</span>
        <svg
          class="stat-spark"
          viewBox="0 0 180 44"
          role="img"
          aria-label="已确认持仓收益走势"
        >
          <defs>
            <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--green)" stop-opacity=".24" />
              <stop offset="100%" stop-color="var(--green)" stop-opacity="0" />
            </linearGradient>
          </defs>
          <path :d="sparkline.area" fill="url(#sparkFill)" />
          <path
            :d="sparkline.line"
            fill="none"
            stroke="var(--green)"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <circle
            :cx="sparkline.last.x"
            :cy="sparkline.last.y"
            r="2.6"
            fill="var(--green)"
            stroke="var(--chart-point)"
            stroke-width="1.2"
          />
        </svg>
      </div>
    </article>

    <article class="stat-card">
      <div class="stat-head"><span>累计收益</span><span class="stat-index">01</span></div>
      <strong class="stat-value" :class="tone(hasRecords ? summary.total_pnl : null)">
        {{ hasRecords ? formatSignedMoney(summary.total_pnl) : '—' }}
      </strong>
      <p class="stat-sub">
        {{
          hasRecords
            ? `${summary.calendar_days} 天 · ${summary.record_count} 条记录 · ${formatPct(
                summary.period_return_pct,
                3,
                true,
              )}`
            : '记录期累计'
        }}
      </p>
    </article>

    <article class="stat-card">
      <div class="stat-head"><span>最新日收益</span><span class="stat-index">02</span></div>
      <strong class="stat-value" :class="tone(hasRecords ? summary.latest_daily_pnl : null)">
        {{ hasRecords ? formatSignedMoney(summary.latest_daily_pnl) : '—' }}
      </strong>
      <p class="stat-sub">
        {{
          hasRecords && lastRecord
            ? `${formatDateShort(lastRecord.date)} · 日收益率 ${formatPct(
                summary.latest_daily_return * 100,
                4,
                true,
              )}`
            : '等待第一条记录'
        }}
      </p>
    </article>

    <article class="stat-card">
      <div class="stat-head"><span>近 30 日年化</span><span class="stat-index">03</span></div>
      <strong class="stat-value" :class="tone(annualized)">
        {{ annualized === null ? '—' : formatPct(annualized, 2, true) }}
      </strong>
      <p class="stat-sub">{{ annualizedSub }}</p>
    </article>

    <article class="stat-card">
      <div class="stat-head"><span>最大回撤</span><span class="stat-index">04</span></div>
      <strong class="stat-value" :class="tone(hasRecords ? summary.max_drawdown_pct : null)">
        {{ hasRecords ? formatPct(summary.max_drawdown_pct, 4) : '—' }}
      </strong>
      <p class="stat-sub">
        {{
          hasRecords
            ? `负收益 ${summary.negative_days}/${summary.record_count} 天 · 最差 ${formatSignedMoney(
                summary.worst_day,
              )}`
            : '按日收益复利净值计算'
        }}
      </p>
    </article>
  </section>
</template>

<style scoped>
.stat-spark {
  overflow: visible;
}
</style>
