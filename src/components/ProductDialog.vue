<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type {
  Product,
  ProductSortKey,
  ProductView,
  SortDirection,
  TermFilter,
} from '@/types/dashboard'
import { formatPct, formatTerm } from '@/composables/useFormatters'

const props = defineProps<{
  open: boolean
  detailOpen: boolean
  detailCloseVersion: number
  products: ProductView
  snapshotDate: string | null
  historyDate: string | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  detail: [product: Product]
}>()

const dialogRef = ref<HTMLDialogElement | null>(null)
const tableWrapRef = ref<HTMLDivElement | null>(null)
const suspendedForDetail = ref(false)
let closingForDetail = false
let savedScrollTop = 0
let savedScrollLeft = 0
let savedProductCode = ''
const sortKey = ref<ProductSortKey>('return_1y')
const sortDirection = ref<SortDirection>('desc')
const termFilter = ref<TermFilter>('all')

const productSortLabels: Record<ProductSortKey, string> = {
  term: '按期限',
  return_1m: '近 1 月收益率',
  return_3m: '近 3 月收益率',
  return_6m: '近 6 月收益率',
  return_1y: '近 1 年收益率',
}

const filters: Array<{ value: TermFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'cash', label: '日开/现金' },
  { value: 'short', label: '短期 7–30 天' },
  { value: 'medium', label: '中期 31–100 天' },
  { value: 'long', label: '长期 100 天+' },
]

const sortColumns: Array<{ key: ProductSortKey; label: string }> = [
  { key: 'return_1m', label: '近 1 月' },
  { key: 'return_3m', label: '近 3 月' },
  { key: 'return_6m', label: '近 6 月' },
  { key: 'return_1y', label: '近 1 年' },
]

const filteredProducts = computed(() =>
  termFilter.value === 'all'
    ? props.products.all
    : props.products.all.filter((product) => product.bucket === termFilter.value),
)

const subtitle = computed(
  () =>
    `普通可买候选池 · 快照 ${props.snapshotDate || '待核'} · 历史业绩 ${
      props.historyDate || '待核'
    } · 共 ${props.products.all.length} 只`,
)

const filterCount = computed(() =>
  termFilter.value === 'all'
    ? `${props.products.all.length} 只`
    : `${filteredProducts.value.length} / ${props.products.all.length} 只`,
)

const sortStateText = computed(() => {
  const directionText =
    sortKey.value === 'term'
      ? sortDirection.value === 'asc'
        ? '短到长'
        : '长到短'
      : sortDirection.value === 'asc'
        ? '升序'
        : '降序'
  return `当前：${productSortLabels[sortKey.value]} · ${directionText}`
})

function compareProducts(a: Product, b: Product): number {
  const nameCompare = a.name.localeCompare(b.name, 'zh-CN')
  if (sortKey.value === 'term') {
    const diff = (a.term_days ?? 9999) - (b.term_days ?? 9999)
    if (diff !== 0) return sortDirection.value === 'asc' ? diff : -diff
    return nameCompare
  }
  const aValue = a[sortKey.value]
  const bValue = b[sortKey.value]
  const aMissing = !Number.isFinite(aValue)
  const bMissing = !Number.isFinite(bValue)
  if (aMissing || bMissing) {
    if (aMissing === bMissing) return nameCompare
    return aMissing ? 1 : -1
  }
  const diff = Number(aValue) - Number(bValue)
  if (diff !== 0) return sortDirection.value === 'asc' ? diff : -diff
  return nameCompare
}

const sortedProducts = computed(() => [...filteredProducts.value].sort(compareProducts))

watch(
  () => props.open,
  async (open) => {
    await nextTick()
    const dialog = dialogRef.value
    if (!dialog) return
    if (open && !props.detailOpen && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      closingForDetail = false
      dialog.close()
    }
  },
  { immediate: true },
)

watch(
  () => props.detailOpen,
  (open) => {
    if (open) {
      if (!suspendedForDetail.value && props.open && dialogRef.value?.open) {
        capturePoolPosition('')
        suspendedForDetail.value = true
        closingForDetail = true
        dialogRef.value.close()
      }
    }
  },
  { immediate: true },
)

watch(
  () => props.detailCloseVersion,
  () => {
    if (suspendedForDetail.value && !props.detailOpen) void resumePool()
  },
)

function capturePoolPosition(productCode: string): void {
  savedScrollTop = dialogRef.value?.scrollTop ?? 0
  savedScrollLeft = tableWrapRef.value?.scrollLeft ?? 0
  savedProductCode = productCode
}

function findProductButton(code: string): HTMLButtonElement | null {
  if (!code || !dialogRef.value) return null
  return (
    Array.from(
      dialogRef.value.querySelectorAll<HTMLButtonElement>('[data-product-code]'),
    ).find((button) => button.dataset.productCode === code) ?? null
  )
}

async function resumePool(): Promise<void> {
  suspendedForDetail.value = false
  if (!props.open) return
  await nextTick()
  const dialog = dialogRef.value
  if (!dialog) return
  if (!dialog.open) dialog.showModal()
  await nextTick()
  dialog.scrollTop = savedScrollTop
  if (tableWrapRef.value) tableWrapRef.value.scrollLeft = savedScrollLeft
  findProductButton(savedProductCode)?.focus({ preventScroll: true })
}

function openDetail(product: Product): void {
  if (props.detailOpen) return
  capturePoolPosition(product.code)
  suspendedForDetail.value = true
  closingForDetail = true
  dialogRef.value?.close()
  emit('detail', product)
}

function requestClose(): void {
  emit('update:open', false)
}

function handleClose(): void {
  if (closingForDetail) {
    closingForDetail = false
    return
  }
  if (props.open) requestClose()
}

function toggleSort(key: ProductSortKey): void {
  if (sortKey.value === key) {
    sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDirection.value = key === 'term' ? 'asc' : 'desc'
  }
}

function sortGlyph(key: ProductSortKey): string {
  if (sortKey.value !== key) return '↕'
  return sortDirection.value === 'asc' ? '↑' : '↓'
}

function ariaSort(key: ProductSortKey): 'ascending' | 'descending' | 'none' {
  if (sortKey.value !== key) return 'none'
  return sortDirection.value === 'asc' ? 'ascending' : 'descending'
}

function onDialogClick(event: MouseEvent): void {
  const dialog = dialogRef.value
  if (!dialog) return
  const rect = dialog.getBoundingClientRect()
  const outside =
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  if (outside) requestClose()
}
</script>

<template>
  <dialog ref="dialogRef" class="product-dialog" @click="onDialogClick" @close="handleClose">
    <div class="dialog-head">
      <div>
        <p class="kicker">历史快照</p>
        <h2>普通可买 R2 候选池</h2>
        <p>{{ subtitle }}</p>
      </div>
      <button class="icon-button" type="button" aria-label="关闭" @click="requestClose">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M5 5l10 10M15 5 5 15" />
        </svg>
      </button>
    </div>
    <div class="dialog-filter-bar">
      <span class="filter-label">期限筛选</span>
      <div class="term-filter" role="group" aria-label="按期限筛选产品">
        <button
          v-for="item in filters"
          :key="item.value"
          type="button"
          :class="{ 'is-active': termFilter === item.value }"
          @click="termFilter = item.value"
        >
          {{ item.label }}
        </button>
      </div>
      <span class="filter-count">{{ filterCount }}</span>
    </div>
    <div class="dialog-sort-bar">
      <span>点击产品名称查看详情；点击收益率列切换排序，空缺值排在最后</span>
      <strong>{{ sortStateText }}</strong>
    </div>
    <div ref="tableWrapRef" class="table-wrap dialog-table-wrap">
      <table class="product-table">
        <thead>
          <tr>
            <th
              class="sortable"
              scope="col"
              :aria-sort="ariaSort('term')"
              :class="{ 'is-sorted': sortKey === 'term' }"
              @click="toggleSort('term')"
            >
              <button class="table-sort-button" type="button">
                期限 <span class="sort-glyph">{{ sortGlyph('term') }}</span>
              </button>
            </th>
            <th>产品</th>
            <th
              v-for="column in sortColumns"
              :key="column.key"
              class="align-right sortable"
              scope="col"
              :aria-sort="ariaSort(column.key)"
              :class="{ 'is-sorted': sortKey === column.key }"
              @click="toggleSort(column.key)"
            >
              <button class="table-sort-button" type="button">
                {{ column.label }} <span class="sort-glyph">{{ sortGlyph(column.key) }}</span>
              </button>
            </th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="product in sortedProducts" :key="product.code">
            <td>
              <span class="term-badge">{{ formatTerm(product.term_days, product.bucket) }}</span>
            </td>
            <td class="product-name-cell">
              <button
                type="button"
                class="product-name-button"
                :data-product-code="product.code"
                :aria-label="`查看 ${product.name}（${product.code}）详情`"
                @click.stop="openDetail(product)"
              >
                <strong>{{ product.name }}</strong>
                <span>{{ product.code }} · {{ product.risk_level || '风险待核' }}</span>
                <span class="product-detail-link">查看详情 →</span>
              </button>
            </td>
            <td class="align-right money-cell">{{ formatPct(product.return_1m, 2) }}</td>
            <td class="align-right money-cell">{{ formatPct(product.return_3m, 2) }}</td>
            <td class="align-right money-cell">{{ formatPct(product.return_6m, 2) }}</td>
            <td class="align-right money-cell">{{ formatPct(product.return_1y, 2) }}</td>
            <td>
              <span
                class="status-pill"
                :class="{ 'is-new': !product.observation_ready, 'is-selected': product.selected }"
              >
                {{ product.selected ? '精选' : product.status || '候选' }}
              </span>
            </td>
          </tr>
          <tr v-if="sortedProducts.length === 0">
            <td class="product-filter-empty" colspan="7">这个期限暂时没有产品。</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="dialog-note">
      这里展示的是普通可买候选池；精选标记来自首页当前的期限桶规则。候选池已经剔除美元、私行/私募、成立不足 12 个月和缺历史数据的产品。任何产品在买入前都要重新核对风险等级、实时额度、费率、赎回规则和产品说明书。
    </p>
  </dialog>
</template>

<style scoped>
.product-dialog {
  border: 0;
}

.term-filter button {
  cursor: pointer;
}

.product-name-button {
  display: grid;
  gap: 2px;
  width: calc(100% + 12px);
  margin: -4px -6px;
  padding: 4px 6px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition:
    background 140ms ease,
    color 140ms ease;
}

.product-name-button:hover {
  background: var(--green-wash);
}

.product-name-button:hover strong,
.product-name-button:focus-visible strong {
  color: var(--green);
}

.product-name-button:focus-visible {
  outline: 2px solid rgba(23, 100, 86, 0.35);
  outline-offset: 1px;
}

.product-name-button .product-detail-link {
  color: var(--green);
  font-family: var(--sans);
  font-weight: 650;
}

@media (max-width: 620px) {
  .dialog-sort-bar {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }
}
</style>
