<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  analysisPeriods, isCalendarDate, loadMarketAnalyses, loadMarketBriefDates,
  renderMarketBrief, type AnalysisType, type MarketAnalysis,
} from '@/data/marketBriefs'

const route = useRoute()
const router = useRouter()
const dates = ref<string[]>([])
const selectedDate = ref(routeDate() ?? '')
const selectedType = ref<AnalysisType>(routeType())
const analyses = shallowRef<MarketAnalysis[]>([])
const loading = ref(true)
const loadingDates = ref(true)
const errorMessage = ref('')
let detailController: AbortController | undefined
let datesController: AbortController | undefined
let initialized = false
let disposed = false
const selectedIndex = computed(() => dates.value.indexOf(selectedDate.value))
const newerDate = computed(() => selectedIndex.value > 0 ? dates.value[selectedIndex.value - 1] : undefined)
const olderDate = computed(() => selectedIndex.value >= 0 ? dates.value[selectedIndex.value + 1] : undefined)
const selectedAnalysis = computed(() => analyses.value.find(a => a.analysis_type === selectedType.value))
const periodLabel = computed(() => analysisPeriods.find(p => p.type === selectedType.value)!.label)
const rendered = computed(() => selectedAnalysis.value ? renderMarketBrief(selectedAnalysis.value.content_markdown) : null)
const visibleTitle = computed(() => rendered.value?.headline || rendered.value?.title || periodLabel.value)
const publishedTime = computed(() => selectedAnalysis.value ? new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(selectedAnalysis.value.published_at)) : '')
const visibleKicker = computed(() => selectedDate.value ? `DAILY MARKET NOTE · ${formatDate(selectedDate.value)}` : 'DAILY MARKET NOTE')

function formatDate(date: string): string {
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(`${date}T00:00:00+08:00`))
  return `${date} · ${weekday}`
}
function routeDate(): string | undefined {
  const value = route.query.date
  return typeof value === 'string' && isCalendarDate(value) ? value : undefined
}
function routeType(): AnalysisType {
  const value = route.query.period
  return analysisPeriods.some(p => p.type === value) ? value as AnalysisType : 'market_overview'
}
function syncRoute(): void {
  if (!selectedDate.value) return
  if (route.query.date === selectedDate.value && route.query.period === selectedType.value) return
  void router.replace({ name: 'investment-briefs', query: {
    ...route.query, date: selectedDate.value, period: selectedType.value,
  } })
}
async function loadSelectedBrief(): Promise<void> {
  detailController?.abort()
  analyses.value = []
  errorMessage.value = ''
  if (!selectedDate.value) { loading.value = false; return }
  const controller = new AbortController()
  detailController = controller
  loading.value = true
  try {
    const data = await loadMarketAnalyses(selectedDate.value, controller.signal)
    if (disposed || controller.signal.aborted) return
    analyses.value = data.analyses
  } catch (error) {
    if (disposed || controller.signal.aborted) return
    errorMessage.value = error instanceof Error ? error.message : '分析读取失败，请重新读取'
  } finally {
    if (!disposed && detailController === controller) loading.value = false
  }
}
async function refreshDates(): Promise<void> {
  datesController?.abort()
  detailController?.abort()
  analyses.value = []
  loadingDates.value = true
  loading.value = true
  errorMessage.value = ''
  const controller = new AbortController()
  datesController = controller
  try {
    const data = await loadMarketBriefDates(controller.signal)
    if (disposed || controller.signal.aborted) return
    dates.value = data.dates
    initialized = false
    selectedDate.value = routeDate() ?? data.dates[0] ?? ''
    // 首次装载由这里读取，后续日期切换由 watcher 读取。
    await loadSelectedBrief()
    if (disposed || controller.signal.aborted) return
    initialized = true
    syncRoute()
  } catch (error) {
    if (disposed || controller.signal.aborted) return
    errorMessage.value = error instanceof Error ? error.message : '日期列表读取失败'
    loading.value = false
  } finally {
    if (!disposed && datesController === controller) loadingDates.value = false
  }
}
watch(selectedDate, () => { if (initialized) { void loadSelectedBrief(); syncRoute() } })
watch(selectedType, () => { if (initialized) syncRoute() })
watch(() => [route.query.date, route.query.period], () => {
  selectedType.value = routeType()
  if (initialized) selectedDate.value = routeDate() ?? dates.value[0] ?? ''
})
watch([visibleTitle, () => route.fullPath], ([title]) => {
  document.title = `${title} · 每日市场简报`
}, { immediate: true, flush: 'post' })
onMounted(() => { void refreshDates() })
onUnmounted(() => { disposed = true; detailController?.abort(); datesController?.abort() })
</script>

<template>
  <section class="briefs-page">
    <header class="briefs-head">
      <div class="briefs-heading">
        <p class="research-kicker briefs-kicker">{{ visibleKicker }}</p>
        <h1>{{ visibleTitle }}</h1>
        <p class="briefs-lede">投资科学每日市场分析，按日期查看早盘、午盘与收盘原文。</p>
      </div>
      <div v-if="dates.length" class="briefs-date-control">
        <label for="market-brief-date">选择日期</label>
        <div class="briefs-date-picker">
          <button class="briefs-step" type="button" :disabled="!newerDate || loadingDates" aria-label="较新日期" @click="selectedDate = newerDate!">←</button>
          <select id="market-brief-date" v-model="selectedDate" :disabled="loadingDates" aria-describedby="brief-date-help">
            <option v-if="selectedDate && !dates.includes(selectedDate)" :value="selectedDate">{{ formatDate(selectedDate) }}（未收录）</option>
            <option v-for="date in dates" :key="date" :value="date">{{ formatDate(date) }}</option>
          </select>
          <button class="briefs-step" type="button" :disabled="!olderDate || loadingDates" aria-label="较早日期" @click="selectedDate = olderDate!">→</button>
        </div>
      </div>
    </header>

    <div class="briefs-periods" role="group" aria-label="分析时段">
      <button v-for="period in analysisPeriods" :key="period.type" type="button"
        :aria-pressed="selectedType === period.type" @click="selectedType = period.type">
        {{ period.label }}
      </button>
    </div>
    <div class="briefs-utility">
      <span id="brief-date-help" class="briefs-source">来源：投资科学<span v-if="publishedTime"> · 发布于 {{ publishedTime }}（北京时间）</span></span>
      <button class="button button-ghost button-small" type="button" :disabled="loading" @click="refreshDates">{{ loading ? '正在读取…' : '刷新分析' }}</button>
    </div>

    <div v-if="errorMessage" class="briefs-message briefs-message-error" role="alert">
      <strong>分析读取失败</strong><p>{{ errorMessage }}</p>
      <button class="button button-ghost button-small" type="button" @click="refreshDates">重新读取</button>
    </div>
    <div v-else-if="!loading && !dates.length" class="briefs-message">
      <strong>暂时没有市场分析</strong><p>源站尚未提供可阅读的日期，可稍后刷新。</p>
    </div>
    <div v-else-if="!loading && !selectedAnalysis" class="briefs-message" role="status">
      <strong>{{ selectedDate }} 的{{ periodLabel }}尚未发布</strong>
      <p>可切换其他时段或日期，稍后刷新查看更新。</p>
    </div>
    <article v-else class="briefs-paper" :aria-busy="loading" aria-live="polite">
      <div class="briefs-paper-rule"><span>{{ periodLabel }}</span><span>{{ selectedDate }}</span></div>
      <p v-if="rendered?.hasTables" class="briefs-table-hint">宽表可在表格区域内横向滚动。</p>
      <div v-if="rendered" class="brief-markdown" v-html="rendered.html"></div>
      <div v-else class="briefs-loading"><span></span><p>正在读取{{ periodLabel }}…</p></div>
    </article>
    <p class="briefs-footnote">内容由投资科学提供，钱多多展示源站原文；市场分析仅供参考，不构成投资建议。</p>
  </section>
</template>
<style scoped>
.briefs-periods {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 18px 0 10px;
}

.briefs-periods button {
  min-height: 40px;
  padding: 8px 16px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--card);
  color: var(--ink-soft);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}

.briefs-periods button[aria-pressed='true'] {
  border-color: var(--green);
  background: var(--green-wash);
  color: var(--green-deep);
  font-weight: 700;
}

.briefs-periods button:focus-visible {
  outline: 3px solid var(--focus-ring);
  outline-offset: 2px;
}

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
