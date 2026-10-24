<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  LedgerRecord,
  LedgerSortKey,
  SortDirection,
} from '@/types/dashboard'
import { formatMoney, formatPct, formatSignedMoney } from '@/composables/useFormatters'
import DataTrustTraceDialog from '@/components/DataTrustTraceDialog.vue'

const props = defineProps<{
  records: LedgerRecord[]
}>()

const emit = defineEmits<{
  edit: [date: string]
  delete: [date: string]
}>()

const sortKey = ref<LedgerSortKey>('date')
const sortDirection = ref<SortDirection>('desc')
const pageSize = ref<number | 'all'>(10)
const page = ref(1)
const jumpPage = ref<number>(1)
const traceOpen = ref(false)
const traceFactKey = ref('')
const traceTitle = ref('')

const sortableColumns: Array<{ key: LedgerSortKey; label: string; numeric: boolean }> = [
  { key: 'date', label: '日期', numeric: false },
  { key: 'holding_amount', label: '持仓金额', numeric: true },
  { key: 'daily_pnl', label: '当日收益', numeric: true },
  { key: 'daily_return', label: '日收益率', numeric: true },
  { key: 'net_value', label: '记录日参考净值', numeric: true },
]

function numericValue(record: LedgerRecord, key: LedgerSortKey): number {
  if (key === 'date') return 0
  return Number(record[key])
}

const sortedRecords = computed(() => {
  const records = [...props.records]
  records.sort((a, b) => {
    const comparison =
      sortKey.value === 'date'
        ? a.date.localeCompare(b.date)
        : numericValue(a, sortKey.value) - numericValue(b, sortKey.value) ||
          a.date.localeCompare(b.date)
    return sortDirection.value === 'asc' ? comparison : -comparison
  })
  return records
})

const pages = computed(() => {
  if (pageSize.value === 'all') return 1
  return Math.max(1, Math.ceil(sortedRecords.value.length / pageSize.value))
})

const currentPage = computed(() => Math.min(Math.max(1, page.value), pages.value))

const visibleRecords = computed(() => {
  if (pageSize.value === 'all') return sortedRecords.value
  const start = (currentPage.value - 1) * pageSize.value
  return sortedRecords.value.slice(start, start + pageSize.value)
})

const pageInfo = computed(() =>
  sortedRecords.value.length
    ? `第 ${currentPage.value} / ${pages.value} 页 · 共 ${sortedRecords.value.length} 条`
    : '—',
)

watch(
  () => [sortedRecords.value.length, pageSize.value],
  () => {
    page.value = currentPage.value
    jumpPage.value = currentPage.value
  },
  { immediate: true },
)

watch(currentPage, (value) => {
  jumpPage.value = value
})

function toggleSort(key: LedgerSortKey): void {
  if (sortKey.value === key) {
    sortDirection.value = sortDirection.value === 'desc' ? 'asc' : 'desc'
  } else {
    sortKey.value = key
    sortDirection.value = 'desc'
  }
  page.value = 1
}

function sortGlyph(key: LedgerSortKey): string {
  if (sortKey.value !== key) return '↕'
  return sortDirection.value === 'asc' ? '↑' : '↓'
}

function ariaSort(key: LedgerSortKey): 'ascending' | 'descending' | 'none' {
  if (sortKey.value !== key) return 'none'
  return sortDirection.value === 'asc' ? 'ascending' : 'descending'
}

function changePageSize(value: string): void {
  pageSize.value = value === 'all' ? 'all' : Number(value) || 10
  page.value = 1
}

function previousPage(): void {
  if (currentPage.value <= 1) return
  page.value = currentPage.value - 1
}

function nextPage(): void {
  if (currentPage.value >= pages.value) return
  page.value = currentPage.value + 1
}

function jumpToPage(): void {
  const requested = Number(jumpPage.value)
  if (!Number.isFinite(requested)) return
  page.value = Math.min(pages.value, Math.max(1, Math.trunc(requested)))
}

function resetPage(): void {
  page.value = 1
}

function openTrace(record: LedgerRecord): void {
  if (!record.id) return
  traceFactKey.value = `account_income:${record.id}`
  traceTitle.value = `${record.date} 账户收益`
  traceOpen.value = true
}

defineExpose({
  resetPage,
})
</script>

<template>
  <section class="panel ledger-panel" aria-labelledby="ledgerTitle">
    <div class="panel-head">
      <div>
        <p class="kicker">流水</p>
        <h2 id="ledgerTitle">每日记录</h2>
      </div>
      <div class="ledger-actions">
        <span class="record-count">{{ records.length }} 条</span>
      </div>
    </div>

    <div class="table-wrap">
      <table v-if="records.length" class="ledger-table">
        <colgroup>
          <col class="ledger-col-date" />
          <col class="ledger-col-principal" />
          <col class="ledger-col-pnl" />
          <col class="ledger-col-return" />
          <col class="ledger-col-net" />
          <col class="ledger-col-action" />
          <col class="ledger-col-notes" />
          <col class="ledger-col-manage" />
        </colgroup>
        <thead>
          <tr>
            <th
              v-for="column in sortableColumns"
              :key="column.key"
              class="sortable"
              :class="{ 'align-right': column.numeric, 'is-sorted': sortKey === column.key }"
              scope="col"
              :aria-sort="ariaSort(column.key)"
              @click="toggleSort(column.key)"
            >
              <button class="table-sort-button" type="button">
                {{ column.label }}
                <span class="sort-glyph">{{ sortGlyph(column.key) }}</span>
              </button>
            </th>
            <th>操作</th>
            <th>备注</th>
            <th class="align-right">管理</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in visibleRecords" :key="record.date">
            <td><span class="ledger-date">{{ record.date }}</span></td>
            <td class="align-right money-cell">¥{{ formatMoney(record.holding_amount) }}</td>
            <td
              class="align-right money-cell"
              :class="record.daily_pnl >= 0 ? 'positive' : 'negative'"
            >
              {{ formatSignedMoney(record.daily_pnl) }}
            </td>
            <td
              class="align-right money-cell"
              :class="record.daily_return >= 0 ? 'positive' : 'negative'"
            >
              {{ formatPct(record.daily_return * 100, 4, true) }}
            </td>
            <td class="align-right money-cell">¥{{ formatMoney(record.net_value) }}</td>
            <td>
              <span class="action-badge" :class="{ 'is-trade': record.action !== '无操作' }">
                {{ record.action }}
              </span>
            </td>
            <td class="notes-cell" :title="record.notes">
              {{ record.notes || '—' }}
            </td>
            <td class="align-right">
              <span class="row-actions">
                <button
                  class="icon-button"
                  type="button"
                  :aria-label="`查看 ${record.date} 的来源与修订`"
                  title="来源与修订"
                  :disabled="!record.id"
                  @click="openTrace(record)"
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M2.8 10s2.7-5 7.2-5 7.2 5 7.2 5-2.7 5-7.2 5-7.2-5-7.2-5Z" />
                    <circle cx="10" cy="10" r="2.2" />
                  </svg>
                </button>
                <button
                  class="icon-button"
                  type="button"
                  :aria-label="`修改 ${record.date} 的记录`"
                  title="修改"
                  @click="emit('edit', record.date)"
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path
                      d="m12.8 3.6 3.6 3.6M4 16l.8-4.2L13.6 3a1.4 1.4 0 0 1 2 0l1.4 1.4a1.4 1.4 0 0 1 0 2l-8.8 8.8L4 16Z"
                    />
                  </svg>
                </button>
                <button
                  class="icon-button is-danger"
                  type="button"
                  :aria-label="`删除 ${record.date} 的记录`"
                  title="删除"
                  @click="emit('delete', record.date)"
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M4 6h12M8 3.5h4M6 6l.7 10h6.6L14 6M8.2 9v4.2M11.8 9v4.2" />
                  </svg>
                </button>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty-ledger">
        <span class="empty-mark">+</span>
        <p>还没有记录。先在右侧记下第一天的收益。</p>
      </div>
    </div>

    <div v-if="records.length" class="ledger-pagination">
      <label class="ledger-page-size">
        每页
        <select
          :value="pageSize"
          aria-label="每日记录每页显示条数"
          @change="changePageSize(($event.target as HTMLSelectElement).value)"
        >
          <option value="10">10</option>
          <option value="20">20</option>
          <option value="50">50</option>
          <option value="all">全部</option>
        </select>
        条
      </label>
      <button
        class="button button-ghost button-small"
        type="button"
        :disabled="currentPage <= 1"
        @click="previousPage"
      >
        上一页
      </button>
      <span>{{ pageInfo }}</span>
      <button
        class="button button-ghost button-small"
        type="button"
        :disabled="currentPage >= pages"
        @click="nextPage"
      >
        下一页
      </button>
      <label class="ledger-page-jump">
        跳至
        <input
          v-model.number="jumpPage"
          type="number"
          min="1"
          :max="pages"
          inputmode="numeric"
          :disabled="pages <= 1"
          @keydown.enter.prevent="jumpToPage"
        />
        页
      </label>
      <button
        class="button button-ghost button-small"
        type="button"
        :disabled="pages <= 1"
        @click="jumpToPage"
      >
        跳转
      </button>
    </div>
    <DataTrustTraceDialog
      :open="traceOpen"
      fact-type="account_income"
      :fact-key="traceFactKey"
      :title="traceTitle"
      @close="traceOpen = false"
    />
  </section>
</template>

<style scoped>
.ledger-date {
  white-space: nowrap;
}

.row-actions {
  vertical-align: middle;
}
</style>
