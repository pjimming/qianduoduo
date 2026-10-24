<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { CSSProperties } from 'vue'
import type { LedgerRecord, RangeValue } from '@/types/dashboard'
import {
  formatAxisDate,
  formatCompactMoney,
  formatDateCN,
  formatDateShort,
  formatPct,
  formatSignedMoney,
  periodReturn,
  rangeRecords,
} from '@/composables/useFormatters'
import {
  chartGeometry,
  niceTicks,
  xAxisIndices,
  type ChartPoint,
  type ChartMargins,
} from '@/composables/useChartLayout'

const props = defineProps<{
  records: LedgerRecord[]
}>()

const ranges: Array<{ value: RangeValue; label: string }> = [
  { value: 7, label: '7天' },
  { value: 30, label: '30天' },
  { value: 90, label: '90天' },
  { value: 'all', label: '全部' },
]

const range = ref<RangeValue>(30)
const host = ref<HTMLDivElement | null>(null)
const wrapper = ref<HTMLDivElement | null>(null)
const svg = ref<SVGSVGElement | null>(null)
const tooltip = ref<HTMLDivElement | null>(null)
const width = ref(700)
const height = ref(312)
const tooltipVisible = ref(false)
const tooltipStyle = ref<CSSProperties>({ left: '0px', top: '0px' })
const activeRecord = ref<LedgerRecord | null>(null)
const activePoint = ref<AssetPoint | null>(null)
let observer: ResizeObserver | null = null

const chartRecords = computed(() => rangeRecords(props.records, range.value))

interface AssetPoint extends ChartPoint<LedgerRecord> {
  x: number
  y: number
}

interface AxisLabel {
  x: number
  y: number
  text: string
  anchor: 'start' | 'middle' | 'end'
}

const model = computed(() => {
  if (!chartRecords.value.length) return null
  const margins: ChartMargins = { top: 18, right: 22, bottom: 34, left: 66 }
  const geometry = chartGeometry(chartRecords.value, width.value, height.value, margins)
  const values = chartRecords.value.map((record) => record.cumulative_pnl)
  const rawMin = Math.min(0, ...values)
  const rawMax = Math.max(0, ...values)
  const rawSpan = rawMax - rawMin
  const padding = rawSpan > 0 ? rawSpan * 0.13 : 1
  const scale = niceTicks(rawMin - padding * 0.2, rawMax + padding, 4)
  const yFor = (value: number): number =>
    margins.top +
    (1 - (value - scale.min) / (scale.max - scale.min)) * geometry.plotHeight
  const points: AssetPoint[] = chartRecords.value.map((record, index) => ({
    x: geometry.xForIndex(index),
    y: yFor(record.cumulative_pnl),
    top: margins.top,
    bottom: margins.top + geometry.plotHeight,
    record,
  }))
  const line = points
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`,
    )
    .join(' ')
  const last = points.at(-1)
  const first = points[0]
  if (!last || !first) return null
  const zeroY = yFor(0)
  const area = `${line} L${last.x.toFixed(1)},${zeroY.toFixed(1)} L${first.x.toFixed(
    1,
  )},${zeroY.toFixed(1)} Z`
  const grid = scale.ticks.map((tick) => ({
    y: yFor(tick),
    label: formatCompactMoney(tick),
  }))
  const xLabels: AxisLabel[] = xAxisIndices(chartRecords.value.length, width.value).map(
    (index) => {
      const x = geometry.xForIndex(index)
      const anchor =
        x < margins.left + 20
          ? 'start'
          : x > width.value - margins.right - 20
            ? 'end'
            : 'middle'
      return {
        x,
        y: margins.top + geometry.plotHeight + 22,
        text: formatAxisDate(chartRecords.value[index]?.date ?? '', geometry.spanDays),
        anchor,
      }
    },
  )
  return {
    width: width.value,
    height: height.value,
    margins,
    geometry,
    points,
    line,
    area,
    zeroY,
    grid,
    xLabels,
    last,
  }
})

const rangeLabel = computed(() => {
  if (!chartRecords.value.length) return '暂无记录'
  const first = chartRecords.value[0]
  const last = chartRecords.value.at(-1)
  return `${formatDateShort(first?.date)} — ${formatDateShort(last?.date)} · ${
    chartRecords.value.length
  } 条`
})

const rangeDelta = computed(() => {
  if (!chartRecords.value.length) return '—'
  const totalPnl = chartRecords.value.reduce((sum, record) => sum + record.daily_pnl, 0)
  return `区间累计收益 ${formatSignedMoney(totalPnl)} · ${formatPct(
    periodReturn(chartRecords.value) * 100,
    3,
    true,
  )}`
})

function setRange(value: RangeValue): void {
  range.value = value
  tooltipVisible.value = false
}

async function updateTooltip(event: PointerEvent): Promise<void> {
  const current = model.value
  if (!current || !svg.value || !wrapper.value) return
  const rect = svg.value.getBoundingClientRect()
  const pointerX = ((event.clientX - rect.left) / rect.width) * current.width
  let nearest = current.points[0]
  let distance = Number.POSITIVE_INFINITY
  for (const point of current.points) {
    const currentDistance = Math.abs(point.x - pointerX)
    if (currentDistance < distance) {
      distance = currentDistance
      nearest = point
    }
  }
  if (!nearest) return
  activeRecord.value = nearest.record
  activePoint.value = nearest
  tooltipVisible.value = true
  await nextTick()
  const wrapperRect = wrapper.value.getBoundingClientRect()
  const localX = event.clientX - wrapperRect.left
  const localY = event.clientY - wrapperRect.top
  const tooltipWidth = Math.min(220, tooltip.value?.offsetWidth || 190)
  let left = localX + 15
  if (left + tooltipWidth + 8 > wrapperRect.width) {
    left = localX - tooltipWidth - 15
  }
  left = Math.max(8, Math.min(left, wrapperRect.width - tooltipWidth - 8))
  let top = localY - 18
  top = Math.max(
    8,
    Math.min(top, wrapperRect.height - (tooltip.value?.offsetHeight || 90) - 8),
  )
  tooltipStyle.value = { left: `${left}px`, top: `${top}px` }
}

function hideTooltip(): void {
  tooltipVisible.value = false
  activePoint.value = null
}

function measure(): void {
  if (!host.value) return
  width.value = Math.max(320, host.value.clientWidth || 700)
  const measuredHeight = host.value.clientHeight
  height.value = Math.max(252, measuredHeight || (width.value < 620 ? 252 : 312))
}

onMounted(() => {
  measure()
  if (host.value) {
    observer = new ResizeObserver(measure)
    observer.observe(host.value)
  }
})

onUnmounted(() => {
  observer?.disconnect()
  observer = null
})
</script>

<template>
  <article class="panel chart-panel">
    <div class="panel-head">
      <div>
        <p class="kicker">累计收益</p>
        <h2>累计收益曲线</h2>
      </div>
      <div class="range-switch" data-range-group="assets" aria-label="累计收益曲线时间范围">
        <button
          v-for="item in ranges"
          :key="item.value"
          type="button"
          :class="{ 'is-active': range === item.value }"
          @click="setRange(item.value)"
        >
          {{ item.label }}
        </button>
      </div>
    </div>
    <div class="chart-summary">
      <span>{{ rangeLabel }}</span>
      <span class="chart-summary-strong">{{ rangeDelta }}</span>
    </div>
    <div ref="wrapper" class="chart-wrap">
      <div ref="host" class="chart-canvas">
        <div v-if="!model" class="chart-empty" style="min-height: inherit">
          <div class="chart-empty-inner">
            <span class="chart-empty-mark">+</span>
            <p>记录第一天收益后，这里会画出累计收益曲线。</p>
          </div>
        </div>
        <svg
          v-else
          ref="svg"
          :viewBox="`0 0 ${model.width} ${model.height}`"
          role="img"
          aria-label="累计收益曲线"
        >
          <defs>
            <linearGradient id="assetAreaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--chart-area)" stop-opacity=".2" />
              <stop offset="78%" stop-color="var(--chart-area)" stop-opacity=".035" />
              <stop offset="100%" stop-color="var(--chart-area)" stop-opacity="0" />
            </linearGradient>
          </defs>
          <template v-for="tick in model.grid" :key="tick.y">
            <line
              :x1="model.margins.left"
              :x2="model.width - model.margins.right"
              :y1="tick.y"
              :y2="tick.y"
              stroke="var(--chart-grid)"
              stroke-width="1"
              stroke-dasharray="2 5"
            />
            <text
              :x="model.margins.left - 10"
              :y="tick.y + 3"
              fill="var(--chart-axis)"
              font-size="12"
              text-anchor="end"
              font-family="Cascadia Mono, Consolas, monospace"
            >
              {{ tick.label }}
            </text>
          </template>
          <line
            :x1="model.margins.left"
            :x2="model.width - model.margins.right"
            :y1="model.zeroY"
            :y2="model.zeroY"
            stroke="var(--chart-zero)"
            stroke-width="1"
            stroke-dasharray="4 5"
          />
          <path :d="model.area" fill="url(#assetAreaFill)" />
          <path
            :d="model.line"
            fill="none"
            stroke="var(--green)"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <circle
            :cx="model.last.x"
            :cy="model.last.y"
            r="8"
            fill="var(--green)"
            opacity=".1"
          />
          <circle
            :cx="model.last.x"
            :cy="model.last.y"
            r="3.2"
            fill="var(--green)"
            stroke="var(--chart-point)"
            stroke-width="1.5"
          />
          <text
            v-for="label in model.xLabels"
            :key="`${label.text}-${label.x}`"
            :x="label.x"
            :y="label.y"
            fill="var(--chart-axis)"
            font-size="12"
            :text-anchor="label.anchor"
            font-family="Cascadia Mono, Consolas, monospace"
          >
            {{ label.text }}
          </text>
          <template v-if="activePoint">
            <line
              :x1="activePoint.x"
              :x2="activePoint.x"
              :y1="activePoint.top"
              :y2="activePoint.bottom"
              stroke="var(--chart-crosshair)"
              stroke-width="1"
              stroke-dasharray="3 4"
            />
            <circle
              :cx="activePoint.x"
              :cy="activePoint.y"
              r="4.6"
              fill="var(--chart-point)"
              stroke="var(--green)"
              stroke-width="2"
            />
          </template>
          <rect
            x="0"
            y="0"
            :width="model.width"
            :height="model.height"
            fill="transparent"
            style="cursor: crosshair"
            @pointermove="updateTooltip"
            @pointerleave="hideTooltip"
            @pointercancel="hideTooltip"
          />
        </svg>
      </div>
      <div
        v-show="tooltipVisible && activeRecord"
        ref="tooltip"
        class="chart-tooltip"
        :style="tooltipStyle"
      >
        <template v-if="activeRecord">
          <strong>{{ formatDateCN(activeRecord.date) }}</strong>
          <span>
            累计收益
            <b :class="activeRecord.cumulative_pnl >= 0 ? 'positive' : 'negative'">
              {{ formatSignedMoney(activeRecord.cumulative_pnl) }}
            </b>
          </span>
          <span>当日收益 <b>{{ formatSignedMoney(activeRecord.daily_pnl) }}</b></span>
          <span>
            当日收益率
            <b>{{ formatPct(activeRecord.daily_return * 100, 4, true) }}</b>
          </span>
        </template>
      </div>
    </div>
    <div class="chart-legend">
      <span><i class="legend-line legend-net"></i>累计收益</span>
      <span class="legend-note">按每日收益累加，不含本金变化</span>
    </div>
  </article>
</template>

<style scoped>
.chart-tooltip {
  pointer-events: none;
  white-space: nowrap;
}
</style>
