<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type {
  Product,
  ProductBucket,
  ProductEvidenceTier,
  ProductSortKey,
  ProductView,
  SortDirection,
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
const sortKey = ref<ProductSortKey>('reference_yield_pct')
const sortDirection = ref<SortDirection>('desc')
const codeQuery = ref('')
const nameQuery = ref('')
const issuerQuery = ref('')
const selectedTerms = ref<ProductBucket[]>([])
const selectedEvidence = ref<ProductEvidenceTier[]>([])

const productSortLabels: Record<ProductSortKey, string> = {
  term: '按期限',
  return_1m: '近 1 月收益率',
  return_3m: '近 3 月收益率',
  return_6m: '近 6 月收益率',
  return_1y: '近 1 年收益率',
  reference_yield_pct: '参考年化',
  weighted_yield_pct: '加权年化',
}

const termOptions: Array<{ value: ProductBucket; label: string }> = [
  { value: 'cash', label: '日开（非配置目标）' },
  { value: 'short', label: '短期 7–30 天' },
  { value: 'medium', label: '中期 31–100 天' },
  { value: 'long', label: '长期 100 天+' },
]

const evidenceOptions: Array<{ value: ProductEvidenceTier; label: string }> = [
  { value: 'full_1y', label: '完整 1Y' },
  { value: 'six_month', label: '缺 1Y' },
  { value: 'three_month', label: '仅 3M' },
  { value: 'one_month', label: '新品观察' },
  { value: 'no_data', label: '数据待补' },
]

const sortColumns: Array<{
  key: ProductSortKey
  label: string
  title?: string
}> = [
  {
    key: 'reference_yield_pct',
    label: '参考年化',
    title: '完整数据为 50% × 3M + 30% × 6M + 20% × 1Y；缺失周期按剩余权重重新归一化',
  },
  { key: 'return_1m', label: '近 1 月' },
  { key: 'return_3m', label: '近 3 月' },
  { key: 'return_6m', label: '近 6 月' },
  { key: 'return_1y', label: '近 1 年' },
]

const filteredProducts = computed(() =>
  props.products.all.filter(
    (product) => {
      const code = codeQuery.value.trim().toLocaleLowerCase('zh-CN')
      const name = nameQuery.value.trim().toLocaleLowerCase('zh-CN')
      const issuer = issuerQuery.value.trim().toLocaleLowerCase('zh-CN')
      return (
        (!code || product.code.toLocaleLowerCase('zh-CN').includes(code)) &&
        (!name ||
          `${product.name} ${product.short_name}`
            .toLocaleLowerCase('zh-CN')
            .includes(name)) &&
        (!issuer ||
          product.issuer.toLocaleLowerCase('zh-CN').includes(issuer)) &&
        (!selectedTerms.value.length ||
          selectedTerms.value.includes(product.bucket)) &&
        (!selectedEvidence.value.length ||
          selectedEvidence.value.includes(product.evidence_tier))
      )
    },
  ),
)

const subtitle = computed(
  () =>
    `普通可买 R2 研究池 · 快照 ${props.snapshotDate || '待核'} · 历史业绩 ${
      props.historyDate || '待核'
    } · 共 ${props.products.all.length} 只`,
)

const hasActiveFilters = computed(
  () =>
    Boolean(codeQuery.value.trim()) ||
    Boolean(nameQuery.value.trim()) ||
    Boolean(issuerQuery.value.trim()) ||
    selectedTerms.value.length > 0 ||
    selectedEvidence.value.length > 0,
)

const filterCount = computed(() =>
  hasActiveFilters.value
    ? `${filteredProducts.value.length} / ${props.products.all.length} 只`
    : `${props.products.all.length} 只`,
)

const termSummary = computed(() =>
  selectionSummary(
    selectedTerms.value,
    termOptions,
    '全部期限',
  ),
)

const evidenceSummary = computed(() =>
  selectionSummary(
    selectedEvidence.value,
    evidenceOptions,
    '全部数据',
  ),
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

function selectionSummary<T extends string>(
  selected: T[],
  options: Array<{ value: T; label: string }>,
  emptyLabel: string,
): string {
  if (!selected.length) return emptyLabel
  const labels = options
    .filter((option) => selected.includes(option.value))
    .map((option) => option.label)
  return labels.length <= 2
    ? labels.join('、')
    : `${labels.slice(0, 2).join('、')} +${labels.length - 2}`
}

function resetFilters(): void {
  codeQuery.value = ''
  nameQuery.value = ''
  issuerQuery.value = ''
  selectedTerms.value = []
  selectedEvidence.value = []
}

function oneYearLabel(product: Product): string {
  if (product.return_1y !== null) return formatPct(product.return_1y, 2)
  if (Number.isFinite(product.history_months) && (product.history_months ?? 0) < 12) {
    return '未满1年'
  }
  return '待披露'
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
        <h2>普通可买 R2 研究池</h2>
        <p>{{ subtitle }}</p>
      </div>
      <button class="icon-button" type="button" aria-label="关闭" @click="requestClose">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M5 5l10 10M15 5 5 15" />
        </svg>
      </button>
    </div>
    <div class="dialog-filter-bar">
      <div class="product-filter-grid">
        <label class="filter-field">
          <span>产品代码</span>
          <input
            v-model="codeQuery"
            type="search"
            placeholder="如 ZX040231"
            aria-label="按产品代码搜索"
          />
        </label>
        <label class="filter-field">
          <span>产品名称</span>
          <input
            v-model="nameQuery"
            type="search"
            placeholder="输入产品名称"
            aria-label="按产品名称搜索"
          />
        </label>
        <label class="filter-field">
          <span>发行方</span>
          <input
            v-model="issuerQuery"
            type="search"
            placeholder="输入发行方"
            aria-label="按发行方搜索"
          />
        </label>
        <details class="multi-select" data-filter="term">
          <summary
            :class="{ 'has-value': selectedTerms.length > 0 }"
            :aria-label="`期限：${termSummary}`"
          >
            <span>期限</span>
            <strong>{{ termSummary }}</strong>
          </summary>
          <div class="multi-select-menu">
            <div class="multi-select-head">
              <strong>按期限多选</strong>
              <button type="button" @click="selectedTerms = []">清除</button>
            </div>
            <label v-for="item in termOptions" :key="item.value">
              <input
                v-model="selectedTerms"
                type="checkbox"
                :value="item.value"
              />
              <span>{{ item.label }}</span>
            </label>
          </div>
        </details>
        <details class="multi-select" data-filter="evidence">
          <summary
            :class="{ 'has-value': selectedEvidence.length > 0 }"
            :aria-label="`数据深度：${evidenceSummary}`"
          >
            <span>数据深度</span>
            <strong>{{ evidenceSummary }}</strong>
          </summary>
          <div class="multi-select-menu">
            <div class="multi-select-head">
              <strong>按数据深度多选</strong>
              <button type="button" @click="selectedEvidence = []">清除</button>
            </div>
            <label v-for="item in evidenceOptions" :key="item.value">
              <input
                v-model="selectedEvidence"
                type="checkbox"
                :value="item.value"
              />
              <span>{{ item.label }}</span>
            </label>
          </div>
        </details>
      </div>
      <div class="filter-toolbar">
        <span class="filter-count">筛选结果 {{ filterCount }}</span>
        <button
          v-if="hasActiveFilters"
          type="button"
          class="filter-reset"
          @click="resetFilters"
        >
          重置筛选
        </button>
      </div>
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
              <button
                class="table-sort-button"
                type="button"
                :title="column.title"
              >
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
            <td class="align-right money-cell">
              {{ formatPct(product.reference_yield_pct, 2) }}
            </td>
            <td class="align-right money-cell">{{ formatPct(product.return_1m, 2) }}</td>
            <td class="align-right money-cell">{{ formatPct(product.return_3m, 2) }}</td>
            <td class="align-right money-cell">{{ formatPct(product.return_6m, 2) }}</td>
            <td class="align-right money-cell">{{ oneYearLabel(product) }}</td>
            <td>
              <span
                class="status-pill"
                :class="{ 'is-new': product.evidence_tier !== 'full_1y', 'is-selected': product.selected }"
              >
                {{ product.selected ? '精选' : product.evidence_label }}
              </span>
            </td>
          </tr>
          <tr v-if="sortedProducts.length === 0">
            <td class="product-filter-empty" colspan="8">
              没有符合当前搜索和筛选条件的产品。
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="dialog-note">
      这里展示人民币、公募、R2/PR2、开放中的普通可买产品。缺 1Y 或仅有 3M
      的产品可以进入评分，但分别受 10% 单只、20% 合计上限约束；仅有 1M
      的新品只作观察，不自动分配。任何产品在买入前都要重新核对风险等级、实时额度、费率、赎回规则和产品说明书。
    </p>
  </dialog>
</template>

<style scoped>
.product-dialog {
  border: 0;
}

.dialog-filter-bar {
  display: grid;
  gap: 10px;
  padding: 14px 26px 12px;
}

.product-filter-grid {
  display: grid;
  grid-template-columns:
    minmax(130px, 0.8fr)
    minmax(190px, 1.35fr)
    minmax(150px, 1fr)
    minmax(175px, 1fr)
    minmax(175px, 1fr);
  gap: 10px;
  align-items: end;
}

.filter-field {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.filter-field > span,
.multi-select summary > span {
  color: var(--muted);
  font-size: 12px;
  font-weight: 650;
}

.filter-field input,
.multi-select summary {
  width: 100%;
  height: 36px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--card);
  color: var(--ink);
  font: inherit;
  font-size: 12px;
}

.filter-field input {
  min-width: 0;
  padding: 0 10px;
}

.filter-field input::placeholder {
  color: var(--muted-light);
}

.filter-field input:focus {
  border-color: rgba(var(--green-rgb), 0.55);
  outline: 2px solid rgba(var(--green-rgb), 0.16);
}

.multi-select {
  position: relative;
  min-width: 0;
}

.multi-select summary {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  cursor: pointer;
  list-style: none;
}

.multi-select summary::-webkit-details-marker {
  display: none;
}

.multi-select summary::after {
  content: '▾';
  color: var(--muted-light);
  font-size: 12px;
  transition: transform 140ms ease;
}

.multi-select[open] summary::after {
  transform: rotate(180deg);
}

.multi-select summary strong {
  overflow: hidden;
  color: var(--muted);
  font-weight: 550;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.multi-select summary.has-value {
  border-color: rgba(var(--green-rgb), 0.38);
  background: var(--green-wash);
}

.multi-select summary.has-value strong {
  color: var(--green);
}

.multi-select summary:focus-visible {
  outline: 2px solid rgba(var(--green-rgb), 0.3);
  outline-offset: 1px;
}

.multi-select-menu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 6px);
  left: 0;
  display: grid;
  gap: 2px;
  width: max(100%, 220px);
  max-height: 260px;
  overflow-y: auto;
  padding: 7px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
  box-shadow: 0 14px 34px rgba(18, 31, 24, 0.18);
}

.multi-select-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 5px 7px;
  border-bottom: 1px solid var(--line);
}

.multi-select-head strong {
  color: var(--ink-soft);
  font-size: 12px;
}

.multi-select-head button {
  border: 0;
  background: transparent;
  color: var(--green);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 650;
}

.multi-select-menu label {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 31px;
  padding: 5px 6px;
  border-radius: 7px;
  color: var(--ink-soft);
  cursor: pointer;
  font-size: 12px;
}

.multi-select-menu label:hover {
  background: var(--green-wash);
}

.multi-select-menu input {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--green);
}

.filter-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}

.filter-reset {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--green);
  cursor: pointer;
  font: inherit;
  font-size: 12px !important;
  font-weight: 650;
}

.filter-label,
.filter-count,
.dialog-sort-bar,
.table-sort-button,
.dialog-note,
.product-name-cell span,
.product-filter-empty {
  font-size: 12px !important;
}

.product-table {
  min-width: 940px;
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
  outline: 2px solid rgba(var(--green-rgb), 0.35);
  outline-offset: 1px;
}

.product-name-button .product-detail-link {
  color: var(--green);
  font-family: var(--sans);
  font-weight: 650;
}

@media (max-width: 1000px) {
  .product-filter-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 620px) {
  .dialog-filter-bar {
    padding: 12px 16px;
  }

  .product-filter-grid {
    grid-template-columns: 1fr;
  }

  .multi-select-menu {
    width: 100%;
  }

  .filter-toolbar {
    justify-content: space-between;
  }

  .dialog-sort-bar {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }
}
</style>
