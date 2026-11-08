<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { categoryLabel, drawdownPct, hintLabel, localTime, pct, reasonLabel, recoveryLabel, screeningGet, stateLabel,
  type Detail, type Nav } from './api'

const props = defineProps<{ run: number; channel: string; code: string }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
const detail = ref<Detail>()
const nav = ref<Nav>()
const section = ref('decision')
const navWindow = ref<'recent' | 'year'>('recent')
const error = ref('')
const navError = ref('')
const labels: Record<string, string> = { performance: '统一查询平台 · 业绩', quota: '招行公开搜索 · 额度', shelf: '公开货架 · 剩余额度',
  detail: '一网通 · 说明书概览', nav: '一网通 · 单位净值', prospectus: '正式产品说明书', reports: '一网通 · 定期报告' }
const marks: Record<string, string> = { zero: '挂零', peak: '峰值', trough: '谷底', repair: '首次修复' }
const hintSummary = computed(() => detail.value?.result.hints.map(hint => hintLabel[hint]).join(' · '))
const endpoints = computed(() => `/results/${encodeURIComponent(props.channel)}/${encodeURIComponent(props.code)}`)
const chart = computed(() => {
  const rows = nav.value?.items ?? []
  if (rows.length < 2) return null
  const first = Date.parse(rows[0].date)
  const last = Date.parse(rows[rows.length - 1].date)
  const values = rows.map(point => Number(point.unit))
  const min = Math.min(...values), max = Math.max(...values)
  const coordinates = rows.map((point, i) => ({
    point,
    x: 12 + (Date.parse(point.date) - first) / Math.max(1, last - first) * 576,
    y: max === min ? 60 : 108 - (values[i] - min) / (max - min) * 96,
  }))
  return { coordinates, line: coordinates.map(({ x, y }) => `${x},${y}`).join(' ') }
})

onMounted(() => dialog.value?.showModal())

function closeOnBackdrop(event: MouseEvent) {
  const bounds = (event.currentTarget as HTMLDialogElement).getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX >= bounds.right ||
      event.clientY < bounds.top || event.clientY >= bounds.bottom) emit('close')
}

watch(() => [props.run, props.channel, props.code], async (_key, _old, onCleanup) => {
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  detail.value = undefined
  error.value = ''
  try { detail.value = await screeningGet<Detail>(`${endpoints.value}?run_id=${props.run}`, controller.signal) }
  catch (problem) { if (!controller.signal.aborted) error.value = (problem as Error).message }
}, { immediate: true })

watch(() => [props.run, props.channel, props.code, section.value, navWindow.value], async (_key, _old, onCleanup) => {
  if (section.value !== 'nav') return
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  nav.value = undefined
  navError.value = ''
  try { nav.value = await screeningGet<Nav>(`${endpoints.value}/nav?run_id=${props.run}&window=${navWindow.value}&limit=400`, controller.signal) }
  catch (problem) { if (!controller.signal.aborted) navError.value = (problem as Error).message }
})
</script>

<template>
  <dialog ref="dialog" class="screen-detail" aria-labelledby="screen-detail-title" @cancel.prevent="emit('close')" @click.self="closeOnBackdrop">
    <header class="detail-header">
      <div>
        <p class="detail-meta">{{ channel }} / {{ code }} · 批次 #{{ run }}</p>
        <h2 id="screen-detail-title">{{ detail?.result.name || '份额详情' }}</h2>
      </div>
      <button type="button" class="button button-ghost button-small" autofocus @click="emit('close')">关闭详情</button>
    </header>
    <RouterLink class="button button-ghost button-small" :to="{ name: 'r2-products', query: { section: 'allocation', channel: props.channel, code: props.code }, hash: '#strategy-review' }">带入交易前复核（使用当前证据）</RouterLink>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="!detail" role="status">正在读取份额证据…</p>
    <template v-else>
      <p class="detail-meta">{{ detail.business_date }} · 规则 {{ detail.rule_version }} · {{ detail.result.issuer }} · {{ categoryLabel[detail.result.category] }}</p>
      <nav class="detail-tabs" aria-label="份额详情分区">
        <button v-for="[id, name] in [['decision', '判定'], ['nav', '净值与走势'], ['review', '交易前复核']]" :key="id"
          type="button" :aria-pressed="section === id" @click="section = id">{{ name }}</button>
      </nav>
      <section v-if="section === 'decision'">
        <h3>{{ detail.result.shortlisted ? '正式候选' : stateLabel[detail.result.status] }}</h3>
        <p v-if="detail.result.rank">同期限、同分类第 {{ detail.result.rank }} 名</p>
        <dl class="detail-facts">
          <div><dt>近 1 月 / 3 月 / 6 月 / 1 年</dt><dd>{{ pct(detail.result.performance['1m']) }} / {{ pct(detail.result.performance['3m']) }} / {{ pct(detail.result.performance['6m']) }} / {{ pct(detail.result.performance['1y']) }}</dd></div>
          <div><dt>业绩披露日</dt><dd>{{ detail.result.performance_date || '待核' }}</dd></div>
          <div><dt>公开额度</dt><dd>{{ detail.result.quota.amount || (detail.result.quota.assumption ? '策略默认 >5,000 万元' : detail.result.quota.status === 1 ? '售罄' : '待核') }}</dd></div>
          <div><dt>额度查询</dt><dd>{{ localTime(detail.result.quota.checked_at) }}</dd></div>
          <div><dt>登记编码</dt><dd>{{ detail.result.detail?.registration || '待核' }}</dd></div>
          <div><dt>起购 / 公开分类</dt><dd>{{ detail.result.min_amount ? detail.result.min_amount + ' 元' : '待核' }} / {{ detail.result.detail?.category_basis || '待核' }}</dd></div>
        </dl>
        <ul class="detail-reasons">
          <li v-for="reason in detail.result.reasons" :key="reason.code">{{ reasonLabel[reason.code] || reason.code }}</li>
        </ul>
        <p v-if="detail.result.hints.length" class="detail-hints">{{ hintSummary }}</p>
        <p v-if="detail.result.term.basis">{{ detail.result.term.basis }}</p>
      </section>
      <section v-else-if="section === 'nav'">
        <div class="detail-row">
          <h3>单位净值</h3>
          <select v-model="navWindow" aria-label="净值区间"><option value="recent">近 60 天</option><option value="year">近一年</option></select>
        </div>
        <p>原始披露精度 · 未复权 · {{ detail.result.metrics.start || '待核' }} 至 {{ detail.result.metrics.end || '待核' }} · {{ detail.result.metrics.count }} 个有效点</p>
        <p v-if="navError" role="alert">{{ navError }}</p>
        <p v-else-if="!nav" role="status">正在读取净值…</p>
        <figure v-else-if="chart" class="detail-chart">
          <svg viewBox="0 0 600 120" role="img" aria-label="单位净值随日期变化，标记点见下方表格">
            <path d="M12 12H588M12 60H588M12 108H588" class="chart-grid" />
            <polyline :points="chart.line" />
            <circle v-for="{ point, x, y } in chart.coordinates.filter(item => item.point.marks.length)" :key="point.date"
              :cx="x" :cy="y" r="3"><title>{{ point.date }} {{ point.unit }} {{ point.marks.map(mark => marks[mark]).join('、') }}</title></circle>
          </svg>
          <figcaption>{{ nav.items[0].date }} 至 {{ nav.items[nav.items.length - 1].date }} · {{ nav.items.length }} 个公开披露点</figcaption>
        </figure>
        <p v-else>{{ nav.issue ? reasonLabel[nav.issue] : '该区间的净值点不足。' }}</p>
        <dl class="detail-facts">
          <div><dt>最大回撤与修复</dt><dd>{{ drawdownPct(detail.result.metrics.drawdown.pct) }} · {{ recoveryLabel[detail.result.metrics.drawdown.recovery] }}</dd></div>
          <div><dt>峰值 / 谷底</dt><dd>{{ detail.result.metrics.drawdown.peak_date || '—' }} / {{ detail.result.metrics.drawdown.trough_date || '—' }}</dd></div>
          <div><dt>首次修复</dt><dd>{{ detail.result.metrics.drawdown.repair_date || '—' }}<template v-if="detail.result.metrics.drawdown.repair_days != null"> · {{ detail.result.metrics.drawdown.repair_days }} 天</template></dd></div>
          <div><dt>最近 7 点挂零</dt><dd>{{ detail.result.metrics.zero_dates == null ? '待核' : detail.result.metrics.zero_dates.length + ' 次' }}</dd></div>
        </dl>
        <h3>最近 7 个有效净值日</h3>
        <table v-if="detail.result.metrics.recent?.length">
          <thead><tr><th scope="col">净值日</th><th scope="col">原始单位净值</th><th scope="col">标记</th></tr></thead>
          <tbody><tr v-for="point in detail.result.metrics.recent" :key="point.date"><td>{{ point.date }}</td><td>{{ point.unit }}</td><td>{{ detail.result.metrics.zero_dates?.includes(point.date) ? '挂零' : '—' }}</td></tr></tbody>
        </table>
        <p v-else>暂无可核验净值点。</p>
        <h3>最近三个完整自然月</h3>
        <p>{{ detail.result.metrics.trend === 'weak' ? '走势走弱' : detail.result.metrics.trend === 'steady' ? '未触发走弱提示' :
          detail.result.metrics.trend === 'short' ? '走势历史不足' : '应估值日或月末端点待核' }}</p>
        <p v-if="detail.result.detail?.valuation_clause">{{ detail.result.detail.valuation_clause }}</p>
        <table v-if="detail.result.metrics.month_ends?.length">
          <thead><tr><th scope="col">月末检查日</th><th scope="col">原始单位净值</th><th scope="col">月度收益</th></tr></thead>
          <tbody><tr v-for="(point, i) in detail.result.metrics.month_ends" :key="i"><td>{{ point.date || '日历待核' }}</td><td>{{ point.unit || '未取得' }}</td><td>{{ pct(detail.result.metrics.monthly_returns?.[i - 1]) }}</td></tr></tbody>
        </table>
        <details v-if="nav?.items.length">
          <summary>查看区间原始净值（{{ nav.items.length }} 条）</summary>
          <table><thead><tr><th scope="col">净值日</th><th scope="col">单位净值</th><th scope="col">累计净值</th><th scope="col">标记</th></tr></thead>
            <tbody><tr v-for="point in nav.items" :key="point.date"><td>{{ point.date }}</td><td>{{ point.unit }}</td><td>{{ point.cumulative || '—' }}</td><td>{{ point.marks.map(mark => marks[mark]).join('、') || '—' }}</td></tr></tbody>
          </table>
        </details>
      </section>
      <section v-else>
        <h3>交易前核对清单</h3>
        <p>先查公开条款，再在银行 App 核对实际额度和可办理时间。</p>
        <dl class="review-list">
          <div v-for="entry in detail.trade_review" :key="entry.label">
            <dt>{{ entry.label }} <span>待复核</span></dt>
            <dd v-if="entry.evidence">{{ entry.evidence }}</dd>
            <dd v-if="entry.note">{{ entry.note }}</dd>
            <dd v-if="entry.url"><a :href="entry.url" target="_blank" rel="noopener noreferrer">打开公开报告列表</a></dd>
          </div>
        </dl>
      </section>
      <section v-if="section !== 'nav'" class="detail-sources">
        <h3>公开证据</h3>
        <p v-if="!detail.evidence.length">本份额暂无独立证据条目。</p>
        <ul v-else>
          <li v-for="item in detail.evidence" :key="item.kind">
            <a :href="item.url" target="_blank" rel="noopener noreferrer">{{ labels[item.kind] || item.kind }}</a>
            <time :datetime="item.checked_at">{{ localTime(item.checked_at) }}</time>
            <small v-if="item.summary.title">{{ item.summary.title }}</small>
            <small v-if="item.summary.location">{{ item.summary.location }}</small>
            <small v-if="item.summary.disclosure_date">披露 {{ item.summary.disclosure_date }}</small>
          </li>
        </ul>
      </section>
    </template>
  </dialog>
</template>

<style scoped>
.screen-detail { position: fixed; inset: 0 0 0 auto; margin: 0; width: min(720px, 96vw); max-width: none;
  height: 100dvh; max-height: 100dvh; padding: 24px; border: 0; border-inline-start: 1px solid var(--line-strong);
  background: var(--card); color: var(--ink); font-size: 14px; overflow: auto; scrollbar-color: var(--line-strong) var(--card); }
.screen-detail::backdrop { background: var(--overlay, color-mix(in srgb, var(--green-deep) 36%, transparent)); }
.detail-header, .detail-row { display: flex; align-items: start; justify-content: space-between; gap: 16px; }
.detail-header .button.button-ghost { flex: none; border-color: color-mix(in srgb, var(--ink-soft) 72%, var(--card)); }
.detail-meta { font-size: 13px; color: var(--ink-soft); margin: 0 0 6px; }
h2 { font-size: 19px; line-height: 1.35; margin: 0 0 8px; overflow-wrap: anywhere; }
h3 { font-size: 15px; margin: 18px 0 8px; }
.detail-tabs { display: flex; border-bottom: 1px solid var(--line-strong); gap: 12px; margin-top: 14px; }
.detail-tabs button { background: transparent; color: var(--ink); font: inherit; cursor: pointer;
  border: 0; border-bottom: 2px solid transparent; padding: 10px 12px; }
.detail-tabs button[aria-pressed="true"] { border-color: var(--green); font-weight: 700; color: var(--green); }
.detail-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; margin: 12px 0; }
dt { font-size: 13px; color: var(--ink-soft); }
dd { margin: 2px 0 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.detail-reasons, .detail-sources ul { padding-inline-start: 20px; }
.detail-hints { color: var(--warning-ink); }
.detail-row select { font: inherit; color: var(--ink); background: var(--card); border: 1px solid var(--ink-soft); border-radius: 10px; padding: 7px 9px; }
.detail-chart { margin: 12px 0; }
.detail-chart svg { display: block; width: 100%; background: var(--card-soft); }
.chart-grid { stroke: var(--line-strong); }
.detail-chart polyline { fill: none; stroke: var(--green); stroke-width: 2; }
.detail-chart circle { fill: var(--green); stroke: var(--card); }
figcaption, small { color: var(--ink-soft); font-size: 13px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
th, td { text-align: start; padding: 6px 8px; border-bottom: 1px solid var(--line); }
th { background: var(--card-soft); }
details { margin: 16px 0; }
summary { cursor: pointer; color: var(--green); }
.review-list div { border-bottom: 1px solid var(--line); padding: 9px 0; }
.review-list dt { font-weight: 700; color: var(--ink); }
.review-list span { font-weight: normal; color: var(--warning-ink); margin-left: 8px; }
.detail-sources a, .review-list a { color: var(--green); text-decoration: underline; text-underline-offset: 3px; }
.detail-sources time { margin-left: 10px; font-size: 13px; }
.detail-sources small { display: block; }
:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; }
</style>
