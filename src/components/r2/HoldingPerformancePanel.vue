<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatMoney, formatPct } from '@/composables/useFormatters'
import type { HoldingPerformance, HoldingReview } from '@/types/dashboard'

const props = defineProps<{
  reviews: HoldingReview[]
  performance?: HoldingPerformance
}>()

const periods = [
  { key: 'weekly', label: '最近 7 笔' },
  { key: 'return_1m', label: '近 1 月' },
  { key: 'return_3m', label: '近 3 月' },
  { key: 'return_6m', label: '近 6 月' },
  { key: 'return_1y', label: '近 1 年' },
  { key: 'return_since_inception', label: '成立以来' },
] as const

const statusLabels = {
  ready: '',
  'short-holding': '持仓不足 7 天',
  'cross-boundary': '合并收益跨区间',
  waiting: '等待收益披露',
  missing: '暂无可估算收益',
}

type Period = (typeof periods)[number]['key']
type WeeklyEstimate = HoldingPerformance['weekly_by_code'][string]

const sortPeriod = ref<Period>('weekly')
const descending = ref(true)
const rows = computed(() => {
  const products = new Map<string, { review: HoldingReview; amount: number }>()
  for (const review of props.reviews) {
    const key = review.product_code || review.lot_id
    const product = products.get(key)
    if (product) product.amount += review.amount
    else products.set(key, { review, amount: review.amount })
  }

  return [...products].map(([key, { review, amount }]) => ({
    key,
    review,
    amount,
    weekly: props.performance?.weekly_by_code[review.product_code],
  }))
})

function annualized(row: { review: HoldingReview; weekly?: WeeklyEstimate }, period: Period) {
  return (period === 'weekly' ? row.weekly?.annualized_pct : row.review.current[period]) ?? null
}

const sortedRows = computed(() =>
  [...rows.value].sort((a, b) => {
    const left = annualized(a, sortPeriod.value)
    const right = annualized(b, sortPeriod.value)
    if (left === null && right !== null) return 1
    if (left !== null && right === null) return -1
    const difference = (left ?? 0) - (right ?? 0)
    return (descending.value ? -difference : difference) || a.key.localeCompare(b.key)
  }),
)

function sortBy(period: Period) {
  descending.value = sortPeriod.value === period ? !descending.value : true
  sortPeriod.value = period
}
</script>

<template>
  <div class="rw-panel-body holding-performance">
    <div class="rw-card-heading">
      <h2 class="rw-panel-title performance-heading">持仓收益排行</h2>
      <p class="performance-note">
        各产品按最近 7 笔账本收益估算年化，不足 7 笔按已有记录计算。
      </p>
      <p class="performance-note">
        其余周期为产品披露的历史年化，成立以来的起点因产品而异。
      </p>
    </div>

    <div v-if="!rows.length" class="rw-empty">有已确认的持仓后，这里会显示产品收益排行。</div>
    <template v-else>
      <p id="holding-performance-help" class="performance-note performance-help">
        点击年化收益列表头排序。“—”表示未披露。
      </p>
      <div
        class="rw-table-wrap performance-table-wrap"
        role="region"
        aria-label="持仓年化收益表格"
        tabindex="0"
      >
        <table class="rw-table performance-table" aria-label="持仓产品收益排行" aria-describedby="holding-performance-help">
          <thead>
            <tr>
              <th scope="col" class="performance-product">产品</th>
              <th
                v-for="period in periods"
                :key="period.key"
                scope="col"
                class="performance-return"
                :class="{ 'performance-weekly': period.key === 'weekly' }"
                :aria-sort="sortPeriod === period.key ? (descending ? 'descending' : 'ascending') : undefined"
              >
                <button type="button" class="performance-sort" @click="sortBy(period.key)">
                  <span>
                    {{ period.label }}
                    <small v-if="period.key === 'weekly'">账本估算</small>
                  </span>
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                    <path v-if="sortPeriod !== period.key" d="M5 12V4L2.5 6.5M11 4v8l2.5-2.5" />
                    <path v-else-if="descending" d="M8 2v11m-4-4 4 4 4-4" />
                    <path v-else d="M8 14V3M4 7l4-4 4 4" />
                  </svg>
                </button>
              </th>
              <th scope="col" class="is-number performance-date">披露数据日</th>
              <th scope="col" class="is-number performance-principal">持仓本金</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in sortedRows" :key="row.key">
              <td class="performance-product">
                <strong>{{ row.review.product_name }}</strong>
                <small>{{ row.review.product_code || '无代码' }}</small>
              </td>
              <td
                v-for="period in periods"
                :key="period.key"
                class="performance-return"
                :class="{ 'performance-sorted': sortPeriod === period.key }"
              >
                <span v-if="period.key === 'weekly' && row.weekly?.annualized_pct == null" class="performance-status">
                  {{ statusLabels[row.weekly?.status ?? 'missing'] }}
                </span>
                <span v-else class="performance-value">{{ formatPct(annualized(row, period.key), 2) }}</span>
                <small v-if="period.key === 'weekly' && row.weekly?.record_count" class="performance-sample">
                  {{ row.weekly.record_count }} 笔 · 截至 {{ row.weekly.end_date }}
                </small>
              </td>
              <td class="is-number">{{ row.review.current.data_date || '—' }}</td>
              <td class="is-number">¥{{ formatMoney(row.amount, 2) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.performance-heading {
  margin: 0;
}

.performance-note {
  margin: 0;
  color: var(--ink-soft);
  font-size: 13px;
}

.performance-sample {
  display: block;
  font-size: 12px;
  white-space: normal;
  font-variant-numeric: tabular-nums;
}

.performance-help {
  margin-top: 10px;
}

.performance-table-wrap {
  min-width: 0;
  margin-top: 8px;
}

.performance-table-wrap:focus-visible {
  outline: 2px solid var(--green);
  outline-offset: 2px;
}

.performance-table {
  min-width: 910px;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
}

.performance-table :is(th, td) {
  padding: 9px 8px;
  border-bottom-color: var(--line);
  color: var(--ink-soft);
}

.performance-table .performance-product {
  position: sticky;
  inset-inline-start: 0;
  z-index: 1;
  width: 22%;
  border-inline-end: 1px solid var(--line);
  background: var(--card);
  white-space: normal;
  overflow-wrap: anywhere;
}

.performance-table th.performance-product {
  background: var(--card-soft);
}

.performance-table .performance-return {
  text-align: right;
}

.performance-table th.performance-return {
  padding: 0;
}

.performance-weekly {
  width: 118px;
}

.performance-date {
  width: 96px;
}

.performance-principal {
  width: 110px;
}

.performance-sort {
  display: flex;
  width: 100%;
  min-height: 48px;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  padding: 6px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: right;
  cursor: pointer;
}

.performance-sort small {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  font-weight: 400;
}

.performance-sort svg {
  flex: 0 0 14px;
  width: 14px;
  height: 14px;
}

.performance-sort:hover,
.performance-table th[aria-sort] .performance-sort {
  background: var(--green-soft);
  color: var(--ink);
}

.performance-sort:focus-visible {
  outline: 2px solid var(--green);
  outline-offset: -2px;
}

.performance-value {
  font: 13px var(--mono);
}

.performance-sorted .performance-value {
  color: var(--ink);
  font-weight: 700;
}

.performance-status {
  font-size: 12px;
  white-space: normal;
}

.performance-table td small {
  margin-top: 3px;
  color: var(--ink-soft);
}

</style>
