<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { StockReport } from '@/data/stockReports'

const props = defineProps<{
  reports: StockReport[]
  currentSlug: string
}>()

const router = useRouter()
const open = ref(false)
const query = ref('')
const activeIndex = ref(0)
const rootRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)

const current = computed(
  () => props.reports.find((report) => report.slug === props.currentSlug) ?? null,
)

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return props.reports
  return props.reports.filter((report) =>
    [report.title, report.date, report.publishedAt, report.category, report.keywords]
      .join(' ')
      .toLowerCase()
      .includes(needle),
  )
})

watch(query, () => {
  activeIndex.value = 0
})

watch(
  () => props.currentSlug,
  () => {
    closePanel()
  },
)

function openPanel(): void {
  open.value = true
  query.value = ''
  const index = props.reports.findIndex((report) => report.slug === props.currentSlug)
  activeIndex.value = index >= 0 ? index : 0
  void nextTick(() => inputRef.value?.focus())
}

function closePanel(): void {
  open.value = false
}

function toggle(): void {
  if (open.value) closePanel()
  else openPanel()
}

function move(delta: number): void {
  if (!filtered.value.length) return
  activeIndex.value =
    (activeIndex.value + delta + filtered.value.length) % filtered.value.length
  void nextTick(() => {
    listRef.value
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex.value}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  })
}

function choose(report: StockReport): void {
  closePanel()
  if (report.slug === props.currentSlug) return
  void router.push({
    name: 'investment-report',
    params: { slug: report.slug },
  })
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const report = filtered.value[activeIndex.value]
    if (report) choose(report)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    closePanel()
    triggerRef.value?.focus()
  }
}

function handlePointerDown(event: PointerEvent): void {
  if (rootRef.value && !rootRef.value.contains(event.target as Node)) {
    closePanel()
  }
}

watch(open, (value) => {
  if (value) document.addEventListener('pointerdown', handlePointerDown)
  else document.removeEventListener('pointerdown', handlePointerDown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePointerDown)
})
</script>

<template>
  <div ref="rootRef" class="report-switcher">
    <button
      ref="triggerRef"
      class="report-switcher-trigger"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="report-switcher-current">
        <small>切换报告</small>
        <strong>{{ current?.title ?? '选择报告' }}</strong>
      </span>
      <span class="report-switcher-chevron" aria-hidden="true">⌄</span>
    </button>

    <div v-if="open" class="report-switcher-pop">
      <label class="report-switcher-search">
        <span class="report-switcher-search-icon" aria-hidden="true">⌕</span>
        <input
          ref="inputRef"
          v-model="query"
          type="search"
          placeholder="搜索标题、日期、方向或关键词…"
          autocomplete="off"
          aria-label="搜索调研报告"
          @keydown="handleKeydown"
        />
        <button
          v-if="query"
          class="report-switcher-clear"
          type="button"
          aria-label="清空搜索"
          @click="query = ''"
        >
          ×
        </button>
      </label>

      <div ref="listRef" class="report-switcher-list" role="listbox" aria-label="调研报告">
        <button
          v-for="(report, index) in filtered"
          :key="report.slug"
          class="report-switcher-item"
          :class="{
            'is-active': index === activeIndex,
            'is-current': report.slug === currentSlug,
          }"
          type="button"
          role="option"
          :data-index="index"
          :aria-selected="report.slug === currentSlug"
          @mouseenter="activeIndex = index"
          @click="choose(report)"
        >
          <span class="report-switcher-meta">
            {{ report.publishedAt }} · {{ report.category }}
            <b v-if="report.slug === currentSlug">当前</b>
          </span>
          <span class="report-switcher-title">{{ report.title }}</span>
        </button>
        <p v-if="!filtered.length" class="report-switcher-empty">
          没有匹配的报告，试试公司名、日期或产业链关键词。
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.report-switcher {
  position: relative;
  flex: 1 1 240px;
  max-width: 400px;
  min-width: 0;
}

.report-switcher-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(255, 254, 250, 0.78);
  color: var(--ink-soft);
  cursor: pointer;
  text-align: left;
  transition:
    border-color 150ms ease,
    background 150ms ease;
}

.report-switcher-trigger:hover,
.report-switcher-trigger[aria-expanded='true'] {
  border-color: var(--line-strong);
  background: var(--card);
}

.report-switcher-trigger:focus-visible {
  outline: 3px solid rgba(23, 100, 86, 0.18);
  outline-offset: 2px;
}

.report-switcher-current {
  display: grid;
  min-width: 0;
  gap: 0;
}

.report-switcher-current small {
  color: var(--muted-light);
  font-family: var(--mono);
  font-size: 8.5px;
  letter-spacing: 0.06em;
  line-height: 1.2;
}

.report-switcher-current strong {
  overflow: hidden;
  color: var(--ink);
  font-size: 11.5px;
  font-weight: 650;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.report-switcher-chevron {
  flex: 0 0 auto;
  color: var(--muted-light);
  font-size: 13px;
  line-height: 1;
}

.report-switcher-pop {
  position: absolute;
  top: calc(100% + 7px);
  left: 0;
  z-index: 90;
  width: min(430px, calc(100vw - 28px));
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 15px;
  background: var(--card);
  box-shadow: 0 22px 54px rgba(33, 53, 43, 0.2);
}

.report-switcher-search {
  position: relative;
  display: flex;
  align-items: center;
}

.report-switcher-search-icon {
  position: absolute;
  left: 11px;
  color: var(--muted-light);
  font-size: 15px;
  pointer-events: none;
}

.report-switcher-search input {
  width: 100%;
  height: 36px;
  padding: 0 32px 0 31px;
  border: 1px solid var(--line);
  border-radius: 9px;
  outline: none;
  background: var(--card-soft);
  color: var(--ink);
  font-size: 12px;
}

.report-switcher-search input:focus {
  border-color: rgba(23, 100, 86, 0.42);
  box-shadow: 0 0 0 3px rgba(23, 100, 86, 0.08);
}

.report-switcher-search input::-webkit-search-cancel-button {
  display: none;
}

.report-switcher-clear {
  position: absolute;
  right: 6px;
  display: grid;
  width: 24px;
  height: 24px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 15px;
}

.report-switcher-clear:hover {
  background: var(--green-wash);
  color: var(--green-deep);
}

.report-switcher-list {
  display: grid;
  gap: 2px;
  max-height: min(52vh, 430px);
  margin-top: 7px;
  overflow: auto;
}

.report-switcher-item {
  display: grid;
  gap: 1px;
  padding: 7px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ink-soft);
  cursor: pointer;
  text-align: left;
}

.report-switcher-item:hover,
.report-switcher-item.is-active {
  background: var(--green-wash);
}

.report-switcher-meta {
  color: var(--muted-light);
  font-family: var(--mono);
  font-size: 9px;
}

.report-switcher-meta b {
  margin-left: 5px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--green-soft);
  color: var(--green-deep);
  font-family: var(--sans);
  font-size: 9px;
  font-weight: 700;
}

.report-switcher-title {
  overflow: hidden;
  font-size: 12px;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.report-switcher-item.is-current .report-switcher-title {
  color: var(--green-deep);
  font-weight: 650;
}

.report-switcher-empty {
  margin: 12px 8px;
  color: var(--muted);
  font-size: 11px;
  text-align: center;
}

@media (max-width: 760px) {
  .report-switcher {
    max-width: none;
  }

  .report-switcher-pop {
    right: 0;
    width: auto;
  }
}
</style>
