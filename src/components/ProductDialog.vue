<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
type QuickFilterField = 'code' | 'name' | 'issuer'
type FilterField = QuickFilterField | 'term' | 'evidence'
type FilterOption = {
  value: string
  label: string
  detail?: string
  keywords?: string
  searchText?: string
  allowSubsequence?: boolean
}

const codeSearch = ref('')
const nameSearch = ref('')
const issuerSearch = ref('')
const selectedCodes = ref<string[]>([])
const selectedNames = ref<string[]>([])
const selectedIssuers = ref<string[]>([])
const selectedTerms = ref<ProductBucket[]>([])
const selectedEvidence = ref<ProductEvidenceTier[]>([])
const activeOptionField = ref<QuickFilterField | null>(null)
const activeOptionIndex = ref(-1)
const codeInputRef = ref<HTMLInputElement | null>(null)
const nameInputRef = ref<HTMLInputElement | null>(null)
const issuerInputRef = ref<HTMLInputElement | null>(null)

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

const codeOptions = computed(() =>
  uniqueOptions(
    props.products.all.map((product) => ({
      value: product.code,
      label: product.code,
      detail: product.name,
      keywords: product.short_name,
      searchText: product.code,
      allowSubsequence: false,
    })),
  ),
)

const nameOptions = computed(() =>
  uniqueOptions(
    props.products.all.map((product) => ({
      value: product.name,
      label: product.name,
      detail: `${product.code} · ${product.issuer}`,
      keywords: product.short_name,
      searchText: `${product.name} ${product.short_name}`,
    })),
  ),
)

const issuerOptions = computed(() =>
  uniqueOptions(
    props.products.all.map((product) => ({
      value: product.issuer,
      label: product.issuer,
      searchText: product.issuer,
    })),
  ),
)

const filteredProducts = computed(() =>
  props.products.all.filter(
    (product) => {
      return (
        matchesFieldFilter(
          product.code,
          selectedCodes.value,
          codeSearch.value,
          product.code,
          false,
        ) &&
        matchesFieldFilter(
          `${product.name} ${product.short_name}`,
          selectedNames.value,
          nameSearch.value,
          product.name,
        ) &&
        matchesFieldFilter(
          product.issuer,
          selectedIssuers.value,
          issuerSearch.value,
        ) &&
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
    selectedCodes.value.length > 0 ||
    selectedNames.value.length > 0 ||
    selectedIssuers.value.length > 0 ||
    Boolean(codeSearch.value.trim()) ||
    Boolean(nameSearch.value.trim()) ||
    Boolean(issuerSearch.value.trim()) ||
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
    if (!open) closeAllFilterMenus()
    if (open && !props.detailOpen && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      closingForDetail = false
      dialog.close()
    }
  },
  { immediate: true },
)

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown, true)
  window.addEventListener('resize', closeAllFilterMenus)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
  window.removeEventListener('resize', closeAllFilterMenus)
})

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

function uniqueOptions(options: FilterOption[]): FilterOption[] {
  const byValue = new Map<string, FilterOption>()
  for (const option of options) {
    if (!option.value || byValue.has(option.value)) continue
    byValue.set(option.value, option)
  }
  return [...byValue.values()].sort((a, b) =>
    a.label.localeCompare(b.label, 'zh-CN'),
  )
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ').trim()
}

function fuzzyMatchScore(
  value: string,
  query: string,
  allowSubsequence = true,
): number {
  const normalizedValue = normalizeSearchText(value)
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return 1
  if (!normalizedValue) return 0

  const directIndex = normalizedValue.indexOf(normalizedQuery)
  if (directIndex === 0) {
    return 1000 - (normalizedValue.length - normalizedQuery.length)
  }
  if (directIndex > 0) {
    return 800 - directIndex - (normalizedValue.length - normalizedQuery.length) / 10
  }
  if (!allowSubsequence) return 0

  const tokens = normalizedQuery.split(' ').filter(Boolean)
  if (tokens.length > 1 && tokens.every((token) => normalizedValue.includes(token))) {
    return 600 - tokens.reduce((total, token) => total + normalizedValue.indexOf(token), 0)
  }

  let queryIndex = 0
  let firstMatch = -1
  let previousMatch = -1
  let gaps = 0
  const compactQuery = normalizedQuery.replace(/\s+/g, '')
  const compactValue = normalizedValue.replace(/\s+/g, '')
  for (let valueIndex = 0; valueIndex < compactValue.length; valueIndex += 1) {
    if (compactValue[valueIndex] !== compactQuery[queryIndex]) continue
    if (firstMatch === -1) firstMatch = valueIndex
    if (previousMatch >= 0) gaps += valueIndex - previousMatch - 1
    previousMatch = valueIndex
    queryIndex += 1
    if (queryIndex === compactQuery.length) {
      return Math.max(1, 400 - gaps - firstMatch)
    }
  }
  return 0
}

function matchesFieldFilter(
  searchableValue: string,
  selected: string[],
  query: string,
  selectedValue = searchableValue,
  allowSubsequence = true,
): boolean {
  if (selected.includes(selectedValue)) return true
  if (query.trim()) {
    return fuzzyMatchScore(searchableValue, query, allowSubsequence) > 0
  }
  return selected.length === 0
}

function rankedOptions(options: FilterOption[], query: string): FilterOption[] {
  return options
    .map((option) => ({
      option,
      score: fuzzyMatchScore(
        option.searchText ??
          `${option.label} ${option.detail ?? ''} ${option.keywords ?? ''}`,
        query,
        option.allowSubsequence !== false,
      ),
    }))
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.option.label.localeCompare(b.option.label, 'zh-CN'),
    )
    .map((item) => item.option)
}

const matchingQuickOptions = computed<Record<QuickFilterField, FilterOption[]>>(
  () => ({
    code: rankedOptions(codeOptions.value, codeSearch.value),
    name: rankedOptions(nameOptions.value, nameSearch.value),
    issuer: rankedOptions(issuerOptions.value, issuerSearch.value),
  }),
)

const visibleQuickOptions = computed<Record<QuickFilterField, FilterOption[]>>(
  () => ({
    code: matchingQuickOptions.value.code.slice(0, 80),
    name: matchingQuickOptions.value.name.slice(0, 80),
    issuer: matchingQuickOptions.value.issuer.slice(0, 80),
  }),
)

const matchingQuickOptionTotals = computed<Record<QuickFilterField, number>>(
  () => ({
    code: matchingQuickOptions.value.code.length,
    name: matchingQuickOptions.value.name.length,
    issuer: matchingQuickOptions.value.issuer.length,
  }),
)

function selectedValuesFor(field: QuickFilterField): string[] {
  if (field === 'code') return selectedCodes.value
  if (field === 'name') return selectedNames.value
  return selectedIssuers.value
}

function selectedOptionsFor(field: QuickFilterField): FilterOption[] {
  const options =
    field === 'code'
      ? codeOptions.value
      : field === 'name'
        ? nameOptions.value
        : issuerOptions.value
  return selectedValuesFor(field).map(
    (value) =>
      options.find((option) => option.value === value) ?? {
        value,
        label: value,
      },
  )
}

function filterInput(field: QuickFilterField): HTMLInputElement | null {
  if (field === 'code') return codeInputRef.value
  if (field === 'name') return nameInputRef.value
  return issuerInputRef.value
}

function closeDetailsMenus(except?: FilterField): void {
  dialogRef.value
    ?.querySelectorAll<HTMLDetailsElement>('details.multi-select[open]')
    .forEach((details) => {
      if (details.dataset.filter !== except) details.open = false
    })
}

function clearQuickSearch(field: QuickFilterField): void {
  if (field === 'code') codeSearch.value = ''
  else if (field === 'name') nameSearch.value = ''
  else issuerSearch.value = ''
}

function clearCommittedQuickSearch(field: QuickFilterField | null): void {
  if (!field || !selectedValuesFor(field).length) return
  clearQuickSearch(field)
}

function closeAllFilterMenus(): void {
  clearCommittedQuickSearch(activeOptionField.value)
  activeOptionField.value = null
  activeOptionIndex.value = -1
  closeDetailsMenus()
}

function openOptionFilter(field: QuickFilterField): void {
  if (activeOptionField.value !== field) {
    clearCommittedQuickSearch(activeOptionField.value)
  }
  closeDetailsMenus()
  activeOptionField.value = field
  activeOptionIndex.value = visibleQuickOptions.value[field].length ? 0 : -1
  void nextTick(() => {
    filterInput(field)?.focus({ preventScroll: true })
    positionFilterMenu(field)
  })
}

function positionFilterMenu(field: FilterField): void {
  const root = dialogRef.value
  if (!root) return
  const trigger = root.querySelector<HTMLElement>(
    field === 'term' || field === 'evidence'
      ? `details[data-filter="${field}"] > summary`
      : `[data-filter="${field}"] .option-control`,
  )
  const menu = root.querySelector<HTMLElement>(
    field === 'term' || field === 'evidence'
      ? `details[data-filter="${field}"] .multi-select-menu`
      : `[data-filter="${field}"] .option-menu`,
  )
  if (!trigger || !menu) return

  const triggerRect = trigger.getBoundingClientRect()
  const spaceBelow = window.innerHeight - triggerRect.bottom - 10
  const spaceAbove = triggerRect.top - 10
  menu.style.maxHeight = ''
  const naturalHeight = Math.min(menu.scrollHeight, 320)
  const opensUp = spaceBelow < naturalHeight && spaceAbove > spaceBelow + 80
  const availableSpace = opensUp ? spaceAbove : spaceBelow
  menu.style.maxHeight = `${Math.max(180, Math.min(320, availableSpace))}px`
  menu.classList.toggle('opens-up', opensUp)
}

function handleDetailsToggle(
  field: 'term' | 'evidence',
  event: Event,
): void {
  if (!(event.currentTarget as HTMLDetailsElement).open) return
  void nextTick(() => positionFilterMenu(field))
}

function handleOptionControlClick(field: QuickFilterField, event: MouseEvent): void {
  const target = event.target
  if (target instanceof Element && target.closest('button')) return
  openOptionFilter(field)
}

function handleQuickSearchInput(field: QuickFilterField): void {
  if (activeOptionField.value && activeOptionField.value !== field) {
    clearCommittedQuickSearch(activeOptionField.value)
  }
  closeDetailsMenus()
  activeOptionField.value = field
  activeOptionIndex.value = visibleQuickOptions.value[field].length ? 0 : -1
}

function setSelectedValues(field: QuickFilterField, values: string[]): void {
  if (field === 'code') selectedCodes.value = values
  else if (field === 'name') selectedNames.value = values
  else selectedIssuers.value = values
}

function clearQuickFilter(field: QuickFilterField): void {
  setSelectedValues(field, [])
  clearQuickSearch(field)
}

function removeSelectedOption(field: QuickFilterField, value: string): void {
  setSelectedValues(
    field,
    selectedValuesFor(field).filter((selected) => selected !== value),
  )
  openOptionFilter(field)
}

function toggleOption(field: QuickFilterField, value: string): void {
  const selected = selectedValuesFor(field)
  setSelectedValues(
    field,
    selected.includes(value)
      ? selected.filter((item) => item !== value)
      : [...selected, value],
  )
  activeOptionField.value = field
  activeOptionIndex.value = visibleQuickOptions.value[field].length ? 0 : -1
  void nextTick(() => filterInput(field)?.focus({ preventScroll: true }))
}

function allMatchingOptionsSelected(field: QuickFilterField): boolean {
  const matchingValues = matchingQuickOptions.value[field].map(
    (option) => option.value,
  )
  return (
    matchingValues.length > 0 &&
    matchingValues.every((value) => selectedValuesFor(field).includes(value))
  )
}

function toggleAllQuickOptions(field: QuickFilterField): void {
  const matchingValues = matchingQuickOptions.value[field].map(
    (option) => option.value,
  )
  if (!matchingValues.length) return
  const selected = selectedValuesFor(field)
  const removeMatches = allMatchingOptionsSelected(field)
  const matchingSet = new Set(matchingValues)
  const nextValues = removeMatches
    ? selected.filter((value) => !matchingSet.has(value))
    : [...new Set([...selected, ...matchingValues])]
  setSelectedValues(field, nextValues)
  if (removeMatches) clearQuickSearch(field)
  activeOptionField.value = field
  activeOptionIndex.value = visibleQuickOptions.value[field].length ? 0 : -1
  void nextTick(() => filterInput(field)?.focus({ preventScroll: true }))
}

function toggleAllTerms(): void {
  selectedTerms.value =
    selectedTerms.value.length === termOptions.length
      ? []
      : termOptions.map((option) => option.value)
}

function toggleAllEvidence(): void {
  selectedEvidence.value =
    selectedEvidence.value.length === evidenceOptions.length
      ? []
      : evidenceOptions.map((option) => option.value)
}

function handleQuickFilterKeydown(
  field: QuickFilterField,
  event: KeyboardEvent,
): void {
  const options = visibleQuickOptions.value[field]
  if (event.key === 'Escape') {
    closeAllFilterMenus()
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (activeOptionField.value !== field) openOptionFilter(field)
    if (!options.length) return
    const direction = event.key === 'ArrowDown' ? 1 : -1
    activeOptionIndex.value =
      (Math.max(0, activeOptionIndex.value) + direction + options.length) %
      options.length
    return
  }
  if (event.key === 'Enter' && activeOptionField.value === field) {
    const option = options[activeOptionIndex.value]
    if (!option) return
    event.preventDefault()
    toggleOption(field, option.value)
    return
  }
  const search =
    field === 'code'
      ? codeSearch.value
      : field === 'name'
        ? nameSearch.value
        : issuerSearch.value
  if (event.key === 'Backspace' && !search) {
    const lastValue = selectedValuesFor(field).at(-1)
    if (lastValue) removeSelectedOption(field, lastValue)
  }
}

function optionDomId(field: QuickFilterField, index: number): string {
  return `product-filter-${field}-option-${index}`
}

function activeOptionDescendant(field: QuickFilterField): string | undefined {
  if (activeOptionField.value !== field || activeOptionIndex.value < 0) return undefined
  return optionDomId(field, activeOptionIndex.value)
}

function prepareDetailsFilter(field: 'term' | 'evidence'): void {
  clearCommittedQuickSearch(activeOptionField.value)
  activeOptionField.value = null
  activeOptionIndex.value = -1
  closeDetailsMenus(field)
}

function handleDocumentPointerDown(event: PointerEvent): void {
  const target = event.target
  if (target instanceof Element && target.closest('[data-filter]')) return
  closeAllFilterMenus()
}

function resetFilters(): void {
  codeSearch.value = ''
  nameSearch.value = ''
  issuerSearch.value = ''
  selectedCodes.value = []
  selectedNames.value = []
  selectedIssuers.value = []
  selectedTerms.value = []
  selectedEvidence.value = []
  closeAllFilterMenus()
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
        <div class="filter-field" data-filter="code">
          <span id="product-filter-code-label">产品代码</span>
          <div
            class="option-select"
            :class="{ 'is-open': activeOptionField === 'code' }"
          >
            <div
              class="option-control"
              @click="handleOptionControlClick('code', $event)"
            >
              <span
                v-for="option in selectedOptionsFor('code').slice(0, 2)"
                :key="option.value"
                class="option-chip"
              >
                <span>{{ option.label }}</span>
                <button
                  type="button"
                  :aria-label="`移除产品代码 ${option.value}`"
                  @click.stop="removeSelectedOption('code', option.value)"
                >
                  ×
                </button>
              </span>
              <span
                v-if="selectedCodes.length > 2"
                class="option-chip option-chip-count"
              >
                +{{ selectedCodes.length - 2 }}
              </span>
              <input
                ref="codeInputRef"
                v-model="codeSearch"
                type="search"
                role="combobox"
                :placeholder="selectedCodes.length ? '继续搜索' : '如 ZX040231'"
                aria-label="按产品代码搜索"
                aria-autocomplete="list"
                aria-controls="product-filter-code-options"
                :aria-expanded="activeOptionField === 'code'"
                :aria-activedescendant="activeOptionDescendant('code')"
                @focus="handleQuickSearchInput('code')"
                @input="handleQuickSearchInput('code')"
                @keydown="handleQuickFilterKeydown('code', $event)"
              />
            </div>
            <div
              v-if="activeOptionField === 'code'"
              id="product-filter-code-options"
              class="option-menu"
              role="listbox"
              aria-label="产品代码选项"
              aria-multiselectable="true"
            >
              <div class="option-menu-head">
                <strong>按产品代码多选</strong>
                <button
                  v-if="selectedCodes.length || codeSearch"
                  type="button"
                  @click="clearQuickFilter('code')"
                >
                  清除
                </button>
              </div>
              <div class="option-menu-list">
                <button
                  v-for="(option, index) in visibleQuickOptions.code"
                  :id="optionDomId('code', index)"
                  :key="option.value"
                  type="button"
                  role="option"
                  class="option-menu-item"
                  :class="{ 'is-active': activeOptionIndex === index }"
                  :aria-selected="selectedCodes.includes(option.value)"
                  @mousedown.prevent
                  @mouseenter="activeOptionIndex = index"
                  @click="toggleOption('code', option.value)"
                >
                  <span class="option-check" aria-hidden="true">
                    {{ selectedCodes.includes(option.value) ? '✓' : '' }}
                  </span>
                  <span class="option-copy">
                    <strong>{{ option.label }}</strong>
                    <small v-if="option.detail">{{ option.detail }}</small>
                  </span>
                </button>
                <p v-if="visibleQuickOptions.code.length === 0" class="option-empty">
                  没有匹配的产品代码
                </p>
                <p
                  v-else-if="matchingQuickOptionTotals.code > visibleQuickOptions.code.length"
                  class="option-limit"
                >
                  显示前 {{ visibleQuickOptions.code.length }} 项，请继续输入以缩小范围
                </p>
              </div>
              <div class="option-menu-footer">
                <button
                  type="button"
                  class="select-all-option"
                  :class="{ 'is-selected': allMatchingOptionsSelected('code') }"
                  :disabled="matchingQuickOptionTotals.code === 0"
                  :aria-pressed="allMatchingOptionsSelected('code')"
                  @mousedown.prevent
                  @click="toggleAllQuickOptions('code')"
                >
                  <span class="option-check" aria-hidden="true">
                    {{ allMatchingOptionsSelected('code') ? '✓' : '' }}
                  </span>
                  <span>
                    {{
                      allMatchingOptionsSelected('code')
                        ? '取消全选'
                        : '全选筛选项'
                    }}
                  </span>
                  <small>当前匹配 {{ matchingQuickOptionTotals.code }} 项</small>
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class="filter-field" data-filter="name">
          <span id="product-filter-name-label">产品名称</span>
          <div
            class="option-select"
            :class="{ 'is-open': activeOptionField === 'name' }"
          >
            <div
              class="option-control"
              @click="handleOptionControlClick('name', $event)"
            >
              <span
                v-for="option in selectedOptionsFor('name').slice(0, 2)"
                :key="option.value"
                class="option-chip option-chip-name"
              >
                <span>{{ option.label }}</span>
                <button
                  type="button"
                  :aria-label="`移除产品名称 ${option.value}`"
                  @click.stop="removeSelectedOption('name', option.value)"
                >
                  ×
                </button>
              </span>
              <span
                v-if="selectedNames.length > 2"
                class="option-chip option-chip-count"
              >
                +{{ selectedNames.length - 2 }}
              </span>
              <input
                ref="nameInputRef"
                v-model="nameSearch"
                type="search"
                role="combobox"
                :placeholder="selectedNames.length ? '继续搜索' : '输入产品名称'"
                aria-label="按产品名称搜索"
                aria-autocomplete="list"
                aria-controls="product-filter-name-options"
                :aria-expanded="activeOptionField === 'name'"
                :aria-activedescendant="activeOptionDescendant('name')"
                @focus="handleQuickSearchInput('name')"
                @input="handleQuickSearchInput('name')"
                @keydown="handleQuickFilterKeydown('name', $event)"
              />
            </div>
            <div
              v-if="activeOptionField === 'name'"
              id="product-filter-name-options"
              class="option-menu option-menu-wide"
              role="listbox"
              aria-label="产品名称选项"
              aria-multiselectable="true"
            >
              <div class="option-menu-head">
                <strong>按产品名称多选</strong>
                <button
                  v-if="selectedNames.length || nameSearch"
                  type="button"
                  @click="clearQuickFilter('name')"
                >
                  清除
                </button>
              </div>
              <div class="option-menu-list">
                <button
                  v-for="(option, index) in visibleQuickOptions.name"
                  :id="optionDomId('name', index)"
                  :key="option.value"
                  type="button"
                  role="option"
                  class="option-menu-item"
                  :class="{ 'is-active': activeOptionIndex === index }"
                  :aria-selected="selectedNames.includes(option.value)"
                  @mousedown.prevent
                  @mouseenter="activeOptionIndex = index"
                  @click="toggleOption('name', option.value)"
                >
                  <span class="option-check" aria-hidden="true">
                    {{ selectedNames.includes(option.value) ? '✓' : '' }}
                  </span>
                  <span class="option-copy">
                    <strong>{{ option.label }}</strong>
                    <small v-if="option.detail">{{ option.detail }}</small>
                  </span>
                </button>
                <p v-if="visibleQuickOptions.name.length === 0" class="option-empty">
                  没有匹配的产品名称
                </p>
                <p
                  v-else-if="matchingQuickOptionTotals.name > visibleQuickOptions.name.length"
                  class="option-limit"
                >
                  显示前 {{ visibleQuickOptions.name.length }} 项，请继续输入以缩小范围
                </p>
              </div>
              <div class="option-menu-footer">
                <button
                  type="button"
                  class="select-all-option"
                  :class="{ 'is-selected': allMatchingOptionsSelected('name') }"
                  :disabled="matchingQuickOptionTotals.name === 0"
                  :aria-pressed="allMatchingOptionsSelected('name')"
                  @mousedown.prevent
                  @click="toggleAllQuickOptions('name')"
                >
                  <span class="option-check" aria-hidden="true">
                    {{ allMatchingOptionsSelected('name') ? '✓' : '' }}
                  </span>
                  <span>
                    {{
                      allMatchingOptionsSelected('name')
                        ? '取消全选'
                        : '全选筛选项'
                    }}
                  </span>
                  <small>当前匹配 {{ matchingQuickOptionTotals.name }} 项</small>
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class="filter-field" data-filter="issuer">
          <span id="product-filter-issuer-label">发行方</span>
          <div
            class="option-select"
            :class="{ 'is-open': activeOptionField === 'issuer' }"
          >
            <div
              class="option-control"
              @click="handleOptionControlClick('issuer', $event)"
            >
              <span
                v-for="option in selectedOptionsFor('issuer').slice(0, 2)"
                :key="option.value"
                class="option-chip"
              >
                <span>{{ option.label }}</span>
                <button
                  type="button"
                  :aria-label="`移除发行方 ${option.value}`"
                  @click.stop="removeSelectedOption('issuer', option.value)"
                >
                  ×
                </button>
              </span>
              <span
                v-if="selectedIssuers.length > 2"
                class="option-chip option-chip-count"
              >
                +{{ selectedIssuers.length - 2 }}
              </span>
              <input
                ref="issuerInputRef"
                v-model="issuerSearch"
                type="search"
                role="combobox"
                :placeholder="selectedIssuers.length ? '继续搜索' : '输入发行方'"
                aria-label="按发行方搜索"
                aria-autocomplete="list"
                aria-controls="product-filter-issuer-options"
                :aria-expanded="activeOptionField === 'issuer'"
                :aria-activedescendant="activeOptionDescendant('issuer')"
                @focus="handleQuickSearchInput('issuer')"
                @input="handleQuickSearchInput('issuer')"
                @keydown="handleQuickFilterKeydown('issuer', $event)"
              />
            </div>
            <div
              v-if="activeOptionField === 'issuer'"
              id="product-filter-issuer-options"
              class="option-menu"
              role="listbox"
              aria-label="发行方选项"
              aria-multiselectable="true"
            >
              <div class="option-menu-head">
                <strong>按发行方多选</strong>
                <button
                  v-if="selectedIssuers.length || issuerSearch"
                  type="button"
                  @click="clearQuickFilter('issuer')"
                >
                  清除
                </button>
              </div>
              <div class="option-menu-list">
                <button
                  v-for="(option, index) in visibleQuickOptions.issuer"
                  :id="optionDomId('issuer', index)"
                  :key="option.value"
                  type="button"
                  role="option"
                  class="option-menu-item"
                  :class="{ 'is-active': activeOptionIndex === index }"
                  :aria-selected="selectedIssuers.includes(option.value)"
                  @mousedown.prevent
                  @mouseenter="activeOptionIndex = index"
                  @click="toggleOption('issuer', option.value)"
                >
                  <span class="option-check" aria-hidden="true">
                    {{ selectedIssuers.includes(option.value) ? '✓' : '' }}
                  </span>
                  <span class="option-copy">
                    <strong>{{ option.label }}</strong>
                    <small v-if="option.detail">{{ option.detail }}</small>
                  </span>
                </button>
                <p v-if="visibleQuickOptions.issuer.length === 0" class="option-empty">
                  没有匹配的发行方
                </p>
                <p
                  v-else-if="matchingQuickOptionTotals.issuer > visibleQuickOptions.issuer.length"
                  class="option-limit"
                >
                  显示前 {{ visibleQuickOptions.issuer.length }} 项，请继续输入以缩小范围
                </p>
              </div>
              <div class="option-menu-footer">
                <button
                  type="button"
                  class="select-all-option"
                  :class="{ 'is-selected': allMatchingOptionsSelected('issuer') }"
                  :disabled="matchingQuickOptionTotals.issuer === 0"
                  :aria-pressed="allMatchingOptionsSelected('issuer')"
                  @mousedown.prevent
                  @click="toggleAllQuickOptions('issuer')"
                >
                  <span class="option-check" aria-hidden="true">
                    {{ allMatchingOptionsSelected('issuer') ? '✓' : '' }}
                  </span>
                  <span>
                    {{
                      allMatchingOptionsSelected('issuer')
                        ? '取消全选'
                        : '全选筛选项'
                    }}
                  </span>
                  <small>当前匹配 {{ matchingQuickOptionTotals.issuer }} 项</small>
                </button>
              </div>
            </div>
          </div>
        </div>
        <details
          class="multi-select"
          data-filter="term"
          @toggle="handleDetailsToggle('term', $event)"
        >
          <summary
            :class="{ 'has-value': selectedTerms.length > 0 }"
            :aria-label="`期限：${termSummary}`"
            @click="prepareDetailsFilter('term')"
          >
            <span>期限</span>
            <strong>{{ termSummary }}</strong>
          </summary>
          <div class="multi-select-menu">
            <div class="multi-select-head">
              <strong>按期限多选</strong>
              <button type="button" @click="selectedTerms = []">清除</button>
            </div>
            <div class="multi-select-options">
              <label v-for="item in termOptions" :key="item.value">
                <input
                  v-model="selectedTerms"
                  type="checkbox"
                  :value="item.value"
                />
                <span>{{ item.label }}</span>
              </label>
            </div>
            <div class="multi-select-footer">
              <button
                type="button"
                class="select-all-option"
                :class="{ 'is-selected': selectedTerms.length === termOptions.length }"
                :aria-pressed="selectedTerms.length === termOptions.length"
                @click="toggleAllTerms"
              >
                <span class="option-check" aria-hidden="true">
                  {{ selectedTerms.length === termOptions.length ? '✓' : '' }}
                </span>
                <span>
                  {{
                    selectedTerms.length === termOptions.length
                      ? '取消全选'
                      : '全选筛选项'
                  }}
                </span>
                <small>已选 {{ selectedTerms.length }} / {{ termOptions.length }}</small>
              </button>
            </div>
          </div>
        </details>
        <details
          class="multi-select"
          data-filter="evidence"
          @toggle="handleDetailsToggle('evidence', $event)"
        >
          <summary
            :class="{ 'has-value': selectedEvidence.length > 0 }"
            :aria-label="`数据深度：${evidenceSummary}`"
            @click="prepareDetailsFilter('evidence')"
          >
            <span>数据深度</span>
            <strong>{{ evidenceSummary }}</strong>
          </summary>
          <div class="multi-select-menu">
            <div class="multi-select-head">
              <strong>按数据深度多选</strong>
              <button type="button" @click="selectedEvidence = []">清除</button>
            </div>
            <div class="multi-select-options">
              <label v-for="item in evidenceOptions" :key="item.value">
                <input
                  v-model="selectedEvidence"
                  type="checkbox"
                  :value="item.value"
                />
                <span>{{ item.label }}</span>
              </label>
            </div>
            <div class="multi-select-footer">
              <button
                type="button"
                class="select-all-option"
                :class="{
                  'is-selected': selectedEvidence.length === evidenceOptions.length,
                }"
                :aria-pressed="selectedEvidence.length === evidenceOptions.length"
                @click="toggleAllEvidence"
              >
                <span class="option-check" aria-hidden="true">
                  {{ selectedEvidence.length === evidenceOptions.length ? '✓' : '' }}
                </span>
                <span>
                  {{
                    selectedEvidence.length === evidenceOptions.length
                      ? '取消全选'
                      : '全选筛选项'
                  }}
                </span>
                <small>
                  已选 {{ selectedEvidence.length }} / {{ evidenceOptions.length }}
                </small>
              </button>
            </div>
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
  gap: 12px;
  padding: 16px 26px 13px;
  background: linear-gradient(180deg, var(--card) 0%, var(--card-soft) 155%);
}

.product-filter-grid {
  display: grid;
  grid-template-columns:
    minmax(130px, 0.8fr)
    minmax(190px, 1.35fr)
    minmax(150px, 1fr)
    minmax(175px, 1fr)
    minmax(175px, 1fr);
  gap: 12px;
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
  font-weight: 700;
  letter-spacing: 0.01em;
}

.option-control,
.multi-select summary {
  width: 100%;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: linear-gradient(180deg, var(--card), var(--card-soft));
  color: var(--ink);
  font: inherit;
  font-size: 12px;
  transition:
    border-color 150ms ease,
    background 150ms ease,
    box-shadow 150ms ease;
}

.option-select {
  position: relative;
  min-width: 0;
}

.option-control {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-height: 40px;
  padding: 4px 9px;
  cursor: text;
}

.option-control:hover,
.multi-select summary:hover {
  border-color: rgba(var(--green-rgb), 0.35);
}

.option-control:focus-within,
.option-select.is-open .option-control {
  border-color: rgba(var(--green-rgb), 0.55);
  outline: 0;
  background: var(--card);
  box-shadow: 0 0 0 3px rgba(var(--green-rgb), 0.1);
}

.option-control input {
  flex: 1 1 70px;
  min-width: 52px;
  height: 28px;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 12px;
}

.option-control input::placeholder {
  color: var(--muted-light);
}

.option-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 100%;
  min-height: 26px;
  padding: 1px 4px 1px 8px;
  border: 1px solid rgba(var(--green-rgb), 0.22);
  border-radius: 7px;
  background: linear-gradient(180deg, var(--green-wash), var(--green-soft));
  color: var(--green);
  font-size: 12px;
  font-weight: 700;
}

.option-chip > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.option-chip-name {
  max-width: 160px;
}

.option-chip-count {
  padding-right: 7px;
}

.option-chip button {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: currentColor;
  cursor: pointer;
  font: inherit;
  font-size: 14px;
  line-height: 1;
}

.option-chip button:hover,
.option-chip button:focus-visible {
  background: rgba(var(--green-rgb), 0.14);
  outline: 0;
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
  height: 40px;
  padding: 0 10px;
  cursor: pointer;
  list-style: none;
}

.multi-select summary::-webkit-details-marker {
  display: none;
}

.multi-select summary::after {
  content: '';
  width: 6px;
  height: 6px;
  border-right: 1.5px solid var(--muted);
  border-bottom: 1.5px solid var(--muted);
  transform: translateY(-2px) rotate(45deg);
  transition: transform 150ms ease;
}

.multi-select[open] summary {
  border-color: rgba(var(--green-rgb), 0.55);
  background: var(--card);
  box-shadow: 0 0 0 3px rgba(var(--green-rgb), 0.1);
}

.multi-select[open] summary::after {
  transform: translateY(2px) rotate(225deg);
}

.multi-select summary strong {
  overflow: hidden;
  color: var(--muted);
  font-weight: 600;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.multi-select summary.has-value {
  border-color: rgba(var(--green-rgb), 0.38);
  background: linear-gradient(180deg, var(--green-wash), var(--green-soft));
}

.multi-select summary.has-value strong {
  color: var(--green);
}

.multi-select summary:focus-visible {
  outline: 2px solid rgba(var(--green-rgb), 0.3);
  outline-offset: 1px;
}

.option-menu,
.multi-select-menu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 7px);
  left: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: max(100%, 220px);
  max-height: 320px;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  background: var(--card);
  box-shadow:
    0 22px 54px rgba(18, 31, 24, 0.2),
    0 3px 10px rgba(18, 31, 24, 0.07);
}

.option-menu {
  width: max(100%, 360px);
}

.option-menu-wide {
  width: max(100%, 430px);
}

.option-menu.opens-up,
.multi-select-menu.opens-up {
  top: auto;
  bottom: calc(100% + 7px);
}

.option-menu-head,
.multi-select-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px 9px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(180deg, var(--card), var(--card-soft));
}

.option-menu-head strong,
.multi-select-head strong {
  color: var(--ink);
  font-size: 12px;
  font-weight: 750;
  letter-spacing: 0.01em;
}

.option-menu-head button,
.multi-select-head button {
  min-height: 26px;
  padding: 3px 8px;
  border: 1px solid rgba(var(--green-rgb), 0.12);
  border-radius: 999px;
  background: var(--green-wash);
  color: var(--green);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
}

.option-menu-head button:hover,
.multi-select-head button:hover {
  border-color: rgba(var(--green-rgb), 0.25);
  background: var(--green-soft);
}

.option-menu-list,
.multi-select-options {
  display: grid;
  align-content: start;
  gap: 3px;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: rgba(var(--green-rgb), 0.28) transparent;
  overscroll-behavior: contain;
}

.option-menu-list::-webkit-scrollbar,
.multi-select-options::-webkit-scrollbar {
  width: 7px;
}

.option-menu-list::-webkit-scrollbar-thumb,
.multi-select-options::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: rgba(var(--green-rgb), 0.28);
  background-clip: content-box;
}

.option-menu-list::-webkit-scrollbar-track,
.multi-select-options::-webkit-scrollbar-track {
  background: transparent;
}

.option-menu-item {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: start;
  align-self: start;
  gap: 8px;
  width: 100%;
  height: max-content;
  min-height: 42px;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--ink-soft);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  text-align: left;
}

.option-menu-item:hover,
.option-menu-item.is-active {
  border-color: rgba(var(--green-rgb), 0.1);
  background: linear-gradient(180deg, var(--green-wash), var(--card-soft));
}

.option-menu-item[aria-selected='true'] {
  border-color: rgba(var(--green-rgb), 0.18);
  background: var(--green-wash);
}

.option-menu-item:focus-visible {
  outline: 2px solid rgba(var(--green-rgb), 0.32);
  outline-offset: -2px;
}

.option-check {
  display: grid;
  place-items: center;
  width: 17px;
  height: 17px;
  margin-top: 1px;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  background: var(--card);
  color: transparent;
  font-size: 11px;
  font-weight: 800;
  line-height: 1;
  text-align: center;
}

.option-menu-item[aria-selected='true'] .option-check,
.select-all-option.is-selected .option-check {
  border-color: var(--green);
  background: var(--green);
  color: #fff;
}

.option-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.option-copy strong {
  overflow-wrap: anywhere;
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 700;
  line-height: 1.42;
}

.option-copy small {
  overflow-wrap: anywhere;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
}

.option-empty,
.option-limit {
  margin: 0;
  padding: 20px 10px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.55;
  text-align: center;
}

.option-limit {
  margin-top: 3px;
  padding: 10px;
  border-top: 1px dashed var(--line);
  background: var(--card-soft);
}

.option-menu-footer,
.multi-select-footer {
  margin: 0;
  padding: 7px;
  border-top: 1px solid var(--line);
  background: linear-gradient(180deg, var(--card-soft), var(--card));
}

.select-all-option {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 38px;
  padding: 7px 8px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--card);
  color: var(--ink-soft);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  text-align: left;
}

.select-all-option > span:nth-child(2) {
  font-weight: 650;
}

.select-all-option small {
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--card-soft);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
}

.select-all-option:hover,
.select-all-option.is-selected {
  border-color: rgba(var(--green-rgb), 0.2);
  background: var(--green-wash);
}

.select-all-option.is-selected > span:nth-child(2),
.select-all-option.is-selected small {
  color: var(--green);
}

.select-all-option.is-selected small {
  background: rgba(var(--green-rgb), 0.08);
}

.select-all-option:focus-visible {
  outline: 2px solid rgba(var(--green-rgb), 0.32);
  outline-offset: -2px;
}

.select-all-option:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

.multi-select-menu label {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: 9px;
  color: var(--ink-soft);
  cursor: pointer;
  font-size: 12px;
  transition:
    border-color 120ms ease,
    background 120ms ease;
}

.multi-select-menu label:hover,
.multi-select-menu label:has(input:checked) {
  border-color: rgba(var(--green-rgb), 0.1);
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

  .option-menu,
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
