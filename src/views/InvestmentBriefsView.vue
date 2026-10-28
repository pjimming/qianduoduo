<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  findMarketBrief,
  marketBriefEntries,
  renderMarketBrief,
} from '@/data/marketBriefs'

const route = useRoute()
const router = useRouter()
const selectedDate = ref(
  normalizeRouteDate() ?? marketBriefEntries[0]?.date ?? '',
)
const renderedTitle = ref('')
const markdownHtml = shallowRef('')
const hasTables = ref(false)
const loading = ref(false)
const errorMessage = ref('')
const requestSequence = ref(0)

const selectedIndex = computed(() =>
  marketBriefEntries.findIndex((entry) => entry.date === selectedDate.value),
)
const selectedEntry = computed(() => findMarketBrief(selectedDate.value))
const newerDate = computed(
  () =>
    selectedIndex.value > 0
      ? marketBriefEntries[selectedIndex.value - 1]?.date
      : undefined,
)
const olderDate = computed(
  () =>
    selectedIndex.value >= 0 &&
    selectedIndex.value < marketBriefEntries.length - 1
      ? marketBriefEntries[selectedIndex.value + 1]?.date
      : undefined,
)
const visibleTitle = computed(
  () =>
    renderedTitle.value ||
    (selectedDate.value ? `${formatDate(selectedDate.value)} 市场简报` : '每日市场简报'),
)

function formatDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00+08:00`)
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    weekday: 'short',
    timeZone: 'Asia/Shanghai',
  }).format(parsed)
  return `${date} · ${weekday}`
}

function normalizeRouteDate(): string | undefined {
  const rawDate = Array.isArray(route.query.date)
    ? route.query.date[0]
    : route.query.date
  return typeof rawDate === 'string' && findMarketBrief(rawDate)
    ? rawDate
    : undefined
}

async function loadSelectedBrief(): Promise<void> {
  const entry = selectedEntry.value
  if (!entry) {
    renderedTitle.value = ''
    markdownHtml.value = ''
    hasTables.value = false
    return
  }

  const sequence = ++requestSequence.value
  loading.value = true
  errorMessage.value = ''
  try {
    const source = await entry.load()
    if (sequence !== requestSequence.value) return
    const rendered = renderMarketBrief(source)
    renderedTitle.value = rendered.title
    markdownHtml.value = rendered.html
    hasTables.value = rendered.hasTables
  } catch (error) {
    if (sequence !== requestSequence.value) return
    renderedTitle.value = ''
    markdownHtml.value = ''
    hasTables.value = false
    errorMessage.value =
      error instanceof Error ? error.message : 'Markdown 文件读取失败'
  } finally {
    if (sequence === requestSequence.value) loading.value = false
  }
}

function selectRelativeDate(date: string | undefined): void {
  if (date) selectedDate.value = date
}

watch(
  selectedDate,
  (date, previousDate) => {
    if (!date) return
    void loadSelectedBrief()
    if (date === previousDate) return
    void router.replace({
      name: 'investment-briefs',
      query: { ...route.query, date },
    })
  },
  { immediate: true },
)

watch(
  () => route.query.date,
  () => {
    const routeDate = normalizeRouteDate()
    if (!routeDate) {
      const latestDate = marketBriefEntries[0]?.date
      if (latestDate && selectedDate.value !== latestDate) {
        selectedDate.value = latestDate
      }
      return
    }
    if (routeDate !== selectedDate.value) selectedDate.value = routeDate
  },
)

onMounted(() => {
  document.title = '钱多多 · 投资 · 每日市场简报'
  const routeDate = normalizeRouteDate()
  const latestDate = marketBriefEntries[0]?.date
  if (routeDate && routeDate !== selectedDate.value) {
    selectedDate.value = routeDate
  } else if (!routeDate && latestDate && selectedDate.value !== latestDate) {
    selectedDate.value = latestDate
  }
})
</script>

<template>
  <section class="briefs-page">
    <header class="briefs-head">
      <div class="briefs-heading">
        <p class="research-kicker">DAILY MARKET NOTE · 收盘后更新</p>
        <h1>{{ visibleTitle }}</h1>
        <p class="briefs-lede">
          一页读取市场状态、关键事件、报告库关联与下一交易日关注点
          <span>· {{ marketBriefEntries.length }} 篇本地 Markdown</span>
        </p>
      </div>

      <div
        v-if="marketBriefEntries.length"
        class="briefs-date-control"
        aria-label="选择简报日期"
      >
        <label for="market-brief-date">选择日期</label>
        <div class="briefs-date-picker">
          <button
            class="briefs-step"
            type="button"
            :disabled="!newerDate"
            :aria-label="newerDate ? `打开 ${formatDate(newerDate)} 的更新简报` : '已经是最新简报'"
            @click="selectRelativeDate(newerDate)"
          >
            ←
          </button>
          <select
            id="market-brief-date"
            v-model="selectedDate"
            aria-describedby="brief-date-help"
          >
            <option
              v-for="entry in marketBriefEntries"
              :key="entry.date"
              :value="entry.date"
            >
              {{ formatDate(entry.date) }}
            </option>
          </select>
          <button
            class="briefs-step"
            type="button"
            :disabled="!olderDate"
            :aria-label="olderDate ? `打开 ${formatDate(olderDate)} 的较早简报` : '已经是最早简报'"
            @click="selectRelativeDate(olderDate)"
          >
            →
          </button>
        </div>
      </div>
    </header>

    <div v-if="marketBriefEntries.length" class="briefs-utility">
      <span id="brief-date-help" class="briefs-source">
        {{ selectedEntry?.fileName }}
      </span>
      <div class="briefs-status">
        <span class="briefs-status-dot" aria-hidden="true"></span>
        <span>{{ loading ? '正在读取 Markdown' : '已按日期加载原文' }}</span>
      </div>
    </div>

    <div
      v-if="errorMessage"
      class="briefs-message briefs-message-error"
      role="alert"
    >
      <strong>简报读取失败</strong>
      <p>{{ errorMessage }}</p>
      <button class="button button-ghost button-small" type="button" @click="loadSelectedBrief">
        重新读取
      </button>
    </div>

    <div
      v-else-if="!marketBriefEntries.length"
      class="briefs-message"
    >
      <strong>还没有每日简报</strong>
      <p>在 <code>market-briefs/</code> 中添加名为 <code>YYYY-MM-DD.md</code> 的 Markdown 文件，刷新后即可按日期阅读。</p>
    </div>

    <article
      v-else
      class="briefs-paper"
      :aria-busy="loading"
      aria-live="polite"
    >
      <div class="briefs-paper-rule">
        <span>MARKET BRIEF</span>
        <span>{{ selectedDate }}</span>
      </div>
      <p v-if="hasTables" class="briefs-table-hint">
        宽表可在表格区域内横向滚动，页面主体不会横向溢出。
      </p>
      <div v-if="markdownHtml" class="brief-markdown" v-html="markdownHtml"></div>
      <div v-else-if="loading" class="briefs-loading" aria-live="polite">
        <span></span>
        <p>正在渲染 {{ selectedDate }} 的 Markdown 简报…</p>
      </div>
    </article>

    <p class="briefs-footnote">
      Markdown 原文件保存在本机工作区，不进入 R2 账本；页面中的市场结论仅供参考，不构成投资建议。
    </p>
  </section>
</template>

<style scoped>
.briefs-page {
  width: min(1420px, 100%);
  min-height: calc(100vh - 160px);
  margin: 0 auto;
  padding: 22px 0 44px;
}

.briefs-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 34px;
  padding: 3px 2px 18px;
  border-bottom: 1px solid var(--line);
}

.briefs-heading {
  flex: 1 1 auto;
  min-width: 0;
}

.briefs-heading h1 {
  max-width: 900px;
  margin: 5px 0 0;
  color: var(--ink);
  font-family: var(--serif);
  font-size: clamp(30px, 3.4vw, 44px);
  font-weight: 400;
  letter-spacing: -0.04em;
  line-height: 1.08;
}

.briefs-lede {
  display: flex;
  flex-wrap: wrap;
  gap: 0 6px;
  max-width: 820px;
  margin: 9px 0 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.55;
}

.briefs-lede span {
  color: var(--muted-light);
  font-family: var(--mono);
  font-size: 12px;
}

.briefs-date-control {
  display: grid;
  flex: 0 0 auto;
  gap: 5px;
  min-width: 292px;
}

.briefs-date-control label {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.briefs-date-picker {
  display: flex;
  align-items: stretch;
  gap: 6px;
}

.briefs-date-picker select {
  min-height: 40px;
  padding: 8px 38px 8px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 11px;
  background: var(--field-bg);
  color: var(--ink);
  font: inherit;
  font-size: 13px;
  font-weight: 650;
}

.briefs-date-picker select:focus-visible,
.briefs-step:focus-visible,
.brief-markdown :deep(a:focus-visible) {
  outline: 3px solid var(--focus-ring);
  outline-offset: 2px;
}

.briefs-step {
  width: 40px;
  border: 1px solid var(--line-strong);
  border-radius: 11px;
  background: var(--card);
  color: var(--ink);
  cursor: pointer;
  font-size: 16px;
}

.briefs-step:hover:not(:disabled) {
  border-color: var(--green);
  background: var(--green-wash);
}

.briefs-step:disabled {
  cursor: not-allowed;
  opacity: 0.38;
}

.briefs-source {
  color: var(--muted-light);
  font-family: var(--mono);
  font-size: 12px;
}

.briefs-utility {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 38px;
  margin: 0 2px 10px;
}

.briefs-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 999px;
  background: var(--surface-muted);
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}

.briefs-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 0 4px rgba(var(--green-rgb), 0.12);
}

.briefs-paper {
  position: relative;
  min-height: 420px;
  padding: 24px clamp(22px, 3vw, 54px) 44px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background:
    linear-gradient(90deg, rgba(var(--green-rgb), 0.045) 1px, transparent 1px),
    rgba(var(--card-rgb), 0.94);
  background-size: 44px 100%;
  box-shadow: var(--shadow-soft);
}

.briefs-paper-rule {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 13px;
  border-bottom: 1px solid var(--line);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.1em;
}

.briefs-table-hint {
  margin: 13px 0 0;
  color: var(--muted);
  font-size: 12px;
}

.briefs-loading {
  display: grid;
  min-height: 300px;
  place-items: center;
  align-content: center;
  gap: 12px;
  color: var(--muted);
  font-size: 13px;
}

.briefs-loading span {
  width: 28px;
  height: 28px;
  border: 3px solid var(--line);
  border-top-color: var(--green);
  border-radius: 50%;
  animation: brief-spin 700ms linear infinite;
}

.briefs-message {
  display: grid;
  justify-items: start;
  gap: 7px;
  margin-top: 18px;
  padding: 24px;
  border: 1px dashed var(--line-strong);
  border-radius: 18px;
  background: rgba(var(--card-rgb), 0.84);
  color: var(--ink-soft);
}

.briefs-message strong {
  color: var(--ink);
  font-size: 15px;
}

.briefs-message p {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
}

.briefs-message-error {
  border-color: rgba(var(--loss-rgb), 0.42);
  background: var(--surface-danger);
}

.briefs-footnote {
  margin: 12px 3px 0;
  color: var(--muted-light);
  font-size: 12px;
  line-height: 1.55;
}

.brief-markdown {
  width: 100%;
  max-width: 1240px;
  margin: 0 auto;
  padding-top: 12px;
  color: var(--ink-soft);
  font-size: 14px;
  line-height: 1.82;
}

.brief-markdown :deep(h1),
.brief-markdown :deep(h2),
.brief-markdown :deep(h3),
.brief-markdown :deep(h4) {
  color: var(--ink);
  font-family: var(--serif);
  font-weight: 600;
  letter-spacing: -0.025em;
  line-height: 1.3;
}

.brief-markdown :deep(h1) {
  margin: 18px 0;
  font-size: 30px;
}

.brief-markdown :deep(h2) {
  margin: 30px 0 12px;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--line);
  font-size: 21px;
}

.brief-markdown :deep(h3) {
  margin: 22px 0 8px;
  font-size: 17px;
}

.brief-markdown :deep(p) {
  margin: 10px 0;
}

.brief-markdown :deep(ul),
.brief-markdown :deep(ol) {
  display: grid;
  gap: 6px;
  margin: 10px 0;
  padding-left: 1.45em;
}

.brief-markdown :deep(li) {
  padding-left: 2px;
}

.brief-markdown :deep(strong) {
  color: var(--ink);
  font-weight: 700;
}

.brief-markdown :deep(a) {
  color: var(--green-deep);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}

.brief-markdown :deep(blockquote) {
  margin: 18px 0;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-left: 4px solid var(--amber);
  border-radius: 0 12px 12px 0;
  background: var(--surface-warning);
  color: var(--ink-soft);
}

.brief-markdown :deep(blockquote p) {
  margin: 0;
}

.brief-markdown :deep(code) {
  padding: 2px 5px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--surface-muted);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 12px;
}

.brief-markdown :deep(pre) {
  max-width: 100%;
  padding: 14px;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-quiet);
}

.brief-markdown :deep(pre code) {
  padding: 0;
  border: 0;
  background: transparent;
}

.brief-markdown :deep(.brief-table-scroll) {
  max-width: 100%;
  margin: 16px 0;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: rgba(var(--card-rgb), 0.72);
}

.brief-markdown :deep(.brief-table-scroll:focus-visible) {
  outline: 3px solid var(--focus-ring);
  outline-offset: 2px;
}

.brief-markdown :deep(table) {
  width: 100%;
  min-width: 720px;
  border-collapse: collapse;
  font-size: 13px;
}

.brief-markdown :deep(th),
.brief-markdown :deep(td) {
  padding: 9px 11px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}

.brief-markdown :deep(th) {
  background: var(--surface-muted);
  color: var(--ink);
  font-weight: 700;
}

.brief-markdown :deep(tr:last-child td) {
  border-bottom: 0;
}

.brief-markdown :deep(hr) {
  margin: 26px 0;
  border: 0;
  border-top: 1px solid var(--line);
}

@keyframes brief-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 760px) {
  .briefs-page {
    padding-top: 14px;
  }

  .briefs-head {
    display: grid;
    align-items: start;
    gap: 14px;
    padding: 2px 1px 15px;
  }

  .briefs-heading h1 {
    font-size: clamp(27px, 8.6vw, 36px);
  }

  .briefs-date-control {
    width: 100%;
    min-width: 0;
  }

  .briefs-date-picker {
    width: 100%;
  }

  .briefs-date-picker select {
    flex: 1;
    min-width: 0;
  }

  .briefs-utility {
    align-items: flex-start;
    flex-direction: column;
    gap: 5px;
    padding: 8px 1px 10px;
  }

  .briefs-status {
    align-self: flex-start;
  }

  .briefs-paper {
    padding: 18px 15px 28px;
    border-radius: 16px;
  }

  .briefs-paper-rule {
    flex-wrap: wrap;
  }

  .brief-markdown {
    font-size: 14px;
    line-height: 1.75;
  }

  .brief-markdown :deep(h2) {
    margin-top: 25px;
    font-size: 19px;
  }

  .brief-markdown :deep(table) {
    min-width: 620px;
  }
}

@media print {
  .briefs-date-control,
  .briefs-utility,
  .briefs-footnote {
    display: none;
  }

  .briefs-page {
    width: 100%;
    padding: 0;
  }

  .briefs-head {
    border-bottom: 0;
  }

  .briefs-paper {
    box-shadow: none;
  }
}
</style>
