<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from 'vue'
import type { CSSProperties } from 'vue'
import type { LedgerRecord, RangeValue } from '@/types/dashboard'
import {
  formatAxisDate,
  formatAxisPct,
  formatCompactMoney,
  formatDateCN,
  formatDateShort,
  formatMoney,
  formatPct,
  formatSignedMoney,
  rangeRecords,
} from '@/composables/useFormatters'
import {
  chartGeometry,
  niceStep,
  xAxisIndices,
  type ChartMargins,
  type ChartPoint,
} from '@/composables/useChartLayout'

const props = defineProps<{
  records: LedgerRecord[]
  range: RangeValue
}>()
const emit = defineEmits<{
  'update:range': [value: RangeValue]
}>()

const ranges: Array<{ value: RangeValue; label: string }> = [
  { value: 7, label: '7天' },
  { value: 30, label: '30天' },
  { value: 90, label: '90天' },
  { value: 'all', label: '全部' },
]

const host = ref<HTMLDivElement | null>(null)
const wrapper = ref<HTMLDivElement | null>(null)
const svg = ref<SVGSVGElement | null>(null)
const tooltip = ref<HTMLDivElement | null>(null)
const width = ref(900)
const tooltipVisible = ref(false)
const tooltipStyle = ref<CSSProperties>({ left: '0px', top: '0px' })
const activeRecord = ref<LedgerRecord | null>(null)
const activePoint = ref<ChartPoint<LedgerRecord> | null>(null)
let observer: ResizeObserver | null = null

const chartRecords = computed(() => rangeRecords(props.records, props.range))
const height = computed(() => (width.value < 760 ? 300 : 340))

interface AxisLabel {
  x: number
  y: number
  text: string
  anchor: 'start' | 'middle' | 'end'
}

function buildAxisScale(
  values: number[],
  top: number,
  bottom: number,
  zeroY: number,
) {
  const positiveMax = Math.max(0, ...values)
  const negativeMax = Math.abs(Math.min(0, ...values))
  const positiveRange = positiveMax > 0 ? positiveMax * 1.08 : 1
  const negativeRange =
    negativeMax > 0 ? negativeMax * 1.08 : positiveRange / 4
  const step = niceStep(
    Math.max(positiveRange, negativeRange) / 4,
  )
  const positiveLimit = Math.max(
    step,
    Math.ceil(positiveRange / step) * step,
  )
  const negativeLimit = Math.max(
    step,
    Math.ceil(negativeRange / step) * step,
  )
  const positiveHeight = Math.max(1, zeroY - top)
  const negativeHeight = Math.max(1, bottom - zeroY)
  const ticks: number[] = []
  for (
    let value = -negativeLimit;
    value <= positiveLimit + step * 0.5;
    value += step
  ) {
    ticks.push(Number(value.toPrecision(12)))
  }
  return {
    y(value: number): number {
      if (value >= 0) {
        return zeroY - (value / positiveLimit) * positiveHeight
      }
      return zeroY + (Math.abs(value) / negativeLimit) * negativeHeight
    },
    ticks,
  }
}

const model = computed(() => {
  if (!chartRecords.value.length) return null
  const margins: ChartMargins = { top: 20, right: 78, bottom: 34, left: 86 }
  const geometry = chartGeometry(chartRecords.value, width.value, height.value, margins)
  const pnlValues = chartRecords.value.map((record) => record.daily_pnl)
  const rateValues = chartRecords.value.map((record) => record.daily_return * 100)
  const pnlPositive = Math.max(0, ...pnlValues)
  const pnlNegative = Math.abs(Math.min(0, ...pnlValues))
  const ratePositive = Math.max(0, ...rateValues)
  const rateNegative = Math.abs(Math.min(0, ...rateValues))
  const negativeShare = Math.max(
    pnlPositive + pnlNegative > 0
      ? pnlNegative / (pnlPositive + pnlNegative)
      : 0,
    ratePositive + rateNegative > 0
      ? rateNegative / (ratePositive + rateNegative)
      : 0,
  )
  const zeroFromTop = 0.25 + (1 - negativeShare) * 0.5
  const zeroY = margins.top + geometry.plotHeight * zeroFromTop
  const pnlScale = buildAxisScale(
    pnlValues,
    margins.top,
    margins.top + geometry.plotHeight,
    zeroY,
  )
  const rateScale = buildAxisScale(
    rateValues,
    margins.top,
    margins.top + geometry.plotHeight,
    zeroY,
  )
  const yPnl = pnlScale.y
  const yRate = rateScale.y

  const grid = pnlScale.ticks.map((tick) => ({
    y: yPnl(tick),
    label: formatCompactMoney(tick),
  }))
  const rightGrid = rateScale.ticks.map((tick) => ({
    y: yRate(tick),
    label: formatAxisPct(tick),
  }))
  const step = geometry.plotWidth / Math.max(chartRecords.value.length, 1)
  const barWidth = Math.max(2.5, Math.min(22, step * 0.56))
  const bars = chartRecords.value.map((record, index) => {
    const x = geometry.xForIndex(index) - barWidth / 2
    const yValue = yPnl(record.daily_pnl)
    return {
      x,
      y: Math.min(yValue, zeroY),
      width: barWidth,
      height: Math.max(1, Math.abs(yValue - zeroY)),
      rx: Math.min(3, barWidth / 2),
      color: record.daily_pnl >= 0 ? 'var(--gain)' : 'var(--loss)',
      opacity: record.daily_pnl === 0 ? 0.26 : 0.82,
      date: record.date,
    }
  })
  const ratePoints: Array<ChartPoint<LedgerRecord>> = chartRecords.value.map(
    (record, index) => ({
      x: geometry.xForIndex(index),
      y: yRate(record.daily_return * 100),
      top: margins.top,
      bottom: margins.top + geometry.plotHeight,
      record,
    }),
  )
  const rateLine = ratePoints
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`,
    )
    .join(' ')
  const rateDots =
    chartRecords.value.length <= 45
      ? ratePoints.map((point) => ({ x: point.x, y: point.y, date: point.record.date }))
      : []
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
    zeroY,
    grid,
    rightGrid,
    bars,
    ratePoints,
    rateLine,
    rateDots,
    xLabels,
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

const rangeSummary = computed(() => {
  if (!chartRecords.value.length) return '—'
  const totalPnl = chartRecords.value.reduce((sum, record) => sum + record.daily_pnl, 0)
  const positiveDays = chartRecords.value.filter((record) => record.daily_pnl > 0).length
  const negativeDays = chartRecords.value.filter((record) => record.daily_pnl < 0).length
  return `合计 ${formatSignedMoney(totalPnl)} · 正收益 ${positiveDays} 天 / 负收益 ${negativeDays} 天`
})

function setRange(value: RangeValue): void {
  emit('update:range', value)
  tooltipVisible.value = false
}

async function updateTooltip(event: PointerEvent): Promise<void> {
  const current = model.value
  if (!current || !svg.value || !wrapper.value) return
  const rect = svg.value.getBoundingClientRect()
  const pointerX = ((event.clientX - rect.left) / rect.width) * current.width
  let nearest = current.ratePoints[0]
  let distance = Number.POSITIVE_INFINITY
  for (const point of current.ratePoints) {
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
  width.value = Math.max(320, host.value.clientWidth || 900)
}

watch(
  () => props.range,
  () => {
    tooltipVisible.value = false
    activePoint.value = null
  },
)

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
  <section class="panel chart-panel wide-panel">
    <div class="panel-head">
      <div>
        <p class="kicker">收益波动</p>
        <h2>每日收益与收益率</h2>
      </div>
      <div class="range-switch" data-range-group="pnl" aria-label="收益曲线时间范围">
        <button
          v-for="item in ranges"
          :key="item.value"
          type="button"
          :class="{ 'is-active': range === item.value }"
          :aria-pressed="range === item.value"
          @click="setRange(item.value)"
        >
          {{ item.label }}
        </button>
      </div>
    </div>
    <div class="chart-summary">
      <span>{{ rangeLabel }}</span>
      <span class="chart-summary-strong">{{ rangeSummary }}</span>
    </div>
    <div ref="wrapper" class="chart-wrap chart-wrap-tall">
      <div ref="host" class="chart-canvas">
        <div v-if="!model" class="chart-empty" style="min-height: inherit">
          <div class="chart-empty-inner">
            <span class="chart-empty-mark">+</span>
            <p>每一笔收益和收益率，会在这里按日排成柱子和折线。</p>
          </div>
        </div>
        <svg
          v-else
          ref="svg"
          :viewBox="`0 0 ${model.width} ${model.height}`"
          role="img"
          aria-label="每日收益柱状图与日收益率折线"
        >
          <template v-for="tick in model.grid" :key="`pnl-${tick.y}`">
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
              :x="model.margins.left - 16"
              :y="tick.y + 3"
              fill="var(--chart-axis)"
              font-size="12"
              text-anchor="end"
              font-family="Cascadia Mono, Consolas, monospace"
            >
              {{ tick.label }}
            </text>
          </template>
          <text
            v-for="tick in model.rightGrid"
            :key="`rate-${tick.y}`"
            :x="model.width - model.margins.right + 16"
            :y="tick.y + 3"
            fill="var(--chart-rate-axis)"
            font-size="12"
            text-anchor="start"
            font-family="Cascadia Mono, Consolas, monospace"
          >
            {{ tick.label }}
          </text>
          <line
            :x1="model.margins.left"
            :x2="model.width - model.margins.right"
            :y1="model.zeroY"
            :y2="model.zeroY"
            stroke="var(--chart-zero)"
            stroke-width="1"
          />
          <rect
            v-for="bar in model.bars"
            :key="`bar-${bar.date}`"
            :x="bar.x"
            :y="bar.y"
            :width="bar.width"
            :height="bar.height"
            :rx="bar.rx"
            :fill="bar.color"
            :opacity="bar.opacity"
          />
          <path
            :d="model.rateLine"
            fill="none"
            stroke="var(--amber)"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <circle
            v-for="point in model.rateDots"
            :key="`dot-${point.date}`"
            :cx="point.x"
            :cy="point.y"
            r="2.2"
            fill="var(--chart-point)"
            stroke="var(--amber)"
            stroke-width="1.4"
          />
          <text
            v-for="label in model.xLabels"
            :key="`x-${label.text}-${label.x}`"
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
            当日收益
            <b :class="activeRecord.daily_pnl >= 0 ? 'positive' : 'negative'">
              {{ formatSignedMoney(activeRecord.daily_pnl) }}
            </b>
          </span>
          <span>
            日收益率 <b>{{ formatPct(activeRecord.daily_return * 100, 4, true) }}</b>
          </span>
          <span>持仓金额 <b>¥{{ formatMoney(activeRecord.holding_amount) }}</b></span>
        </template>
      </div>
    </div>
    <div class="chart-legend">
      <span><i class="legend-bar legend-gain"></i>正收益</span>
      <span><i class="legend-bar legend-loss"></i>负收益</span>
      <span><i class="legend-line legend-rate"></i>当日收益率（右轴）</span>
    </div>
  </section>
</template>

<style scoped>
.chart-tooltip {
  pointer-events: none;
  white-space: nowrap;
}
</style>
