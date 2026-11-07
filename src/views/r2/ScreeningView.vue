<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import R2PageHeader from '@/components/r2/R2PageHeader.vue'
import ScreeningDetail from '@/components/screening/ScreeningDetail.vue'
import {
  categoryLabel, drawdownPct, evidenceExpired, hintLabel, localTime, pct, reasonLabel, recoveryLabel, refreshScreening,
  runState, screeningGet, stateLabel, triggerLabel, type History, type Results, type Row, type RunDetail, type Status,
} from '@/components/screening/api'

const route = useRoute()
const router = useRouter()
const status = ref<Status>()
const results = ref<Results>()
const history = ref<History>()
const historyDetail = ref<RunDetail>()
const shownRun = ref<RunDetail>()
const target = ref<number>()
const pending = ref(false)
const loading = ref(true)
const statusError = ref('')
const bodyError = ref('')
const refreshError = ref('')
const notice = ref('')
const refreshKey = ref('')
const retry = ref(0)
const query = (key: string) => typeof route.query[key] === 'string' ? String(route.query[key]) : ''
const runId = computed(() => Number(query('run')) || undefined)
const tab = computed(() => query('tab') || 'shortlist')
const tabNames: Record<string, string> = { shortlist: '正式候选', all: '全部份额', watch: '回撤观察', pending: '待核', rejected: '淘汰' }
const amountStates: Record<string, string> = { blank: '货架金额为空', not_covered: '货架未覆盖', request_failed: '货架请求失败', unrecognized: '金额格式待核' }
const bodyKey = computed(() => ['run', 'tab', 'page', 'term', 'category', 'issuer', 'hint', 'q', 'stage', 'sort', 'log'].map(query).join('\u0000'))
const visibleRun = computed(() => shownRun.value?.id === runId.value ? shownRun.value : undefined)
const runIsCurrent = computed(() => visibleRun.value?.id === status.value?.current_run?.id)
const today = computed(() => status.value?.data_age?.date ?? visibleRun.value?.data_age?.date)
const ages = computed(() => runIsCurrent.value ? status.value?.data_age : visibleRun.value?.data_age)
const isHistorical = computed(() => visibleRun.value && (!runIsCurrent.value || (today.value && visibleRun.value.business_date !== today.value)))
const byGroup = computed(() => {
  const groups: { title: string; rows: Row[] }[] = []
  for (const row of results.value?.items ?? []) {
    const title = [row.term.days == null ? '期限待核' : row.term.days === 0 ? '每日开放' : row.term.days + ' 天',
      categoryLabel[row.category]].join(' · ')
    const previous = groups[groups.length - 1]
    if (previous?.title === title) previous.rows.push(row)
    else groups.push({ title, rows: [row] })
  }
  return groups
})
const tablePages = computed(() => results.value ? Math.max(1, Math.ceil(results.value.total / results.value.limit)) : 1)
const historyPages = computed(() => history.value ? Math.max(1, Math.ceil(history.value.total / history.value.limit)) : 1)
const tabs = computed(() => {
  const counts = visibleRun.value?.counts
  return Object.entries(tabNames).map(([key, name]) => [key, name, counts?.[key === 'shortlist' ? 'shortlisted' : key === 'all' ? 'total' : key as 'watch' | 'pending' | 'rejected']])
})
const funnel = computed(() => {
  const counts = visibleRun.value?.counts
  if (!counts) return []
  return [
    { title: '公开份额', count: counts.total },
    { title: '收益达标', count: counts.yield_pass },
    { title: '额度状态为 0', count: counts.quota_open },
    { title: '通过门槛', count: counts.eligible },
  ]
})
const active = computed(() => status.value?.scheduler.active)
const life = new AbortController()
let poll: number | undefined
let polls = 0
let originFocus: HTMLElement | null = null

async function updateQuery(patch: LocationQueryRaw, replace = false) {
  const query = { ...route.query, ...patch }
  Object.keys(query).forEach(key => { if (query[key] === '' || query[key] === null) delete query[key] })
  await (replace ? router.replace({ query }) : router.push({ query }))
}

async function readStatus() {
  try {
    const data = await screeningGet<Status>('/status', life.signal)
    const previous = status.value
    status.value = data
    if (tab.value === 'history' && previous && (
      previous.scheduler.active?.id !== data.scheduler.active?.id ||
      previous.last_attempt?.id !== data.last_attempt?.id ||
      previous.last_attempt?.status !== data.last_attempt?.status ||
      previous.last_attempt?.retry_at !== data.last_attempt?.retry_at
    )) retry.value++
    statusError.value = ''
    if (!runId.value && data.current_run && !query('run') && route.name === 'r2-screening') {
      await updateQuery({ run: data.current_run.id }, true)
    }
    return data
  } catch (error) {
    if (!life.signal.aborted) statusError.value = (error as Error).message
    return null
  }
}

function follow() {
  if (poll !== undefined || life.signal.aborted) return
  poll = window.setTimeout(async () => {
    poll = undefined
    if (life.signal.aborted) return
    if (++polls > 105) {
      notice.value = '轮询已结束。运行记录可查看最新状态。'
      target.value = undefined
      return
    }
    if (target.value) {
      try {
        const batch = await screeningGet<RunDetail>('/runs/' + target.value, life.signal)
        refreshError.value = ''
        if (['succeeded', 'degraded', 'failed', 'interrupted'].includes(batch.status)) {
          notice.value = batch.counts ? `批次 #${batch.id} 已发布${runId.value === batch.id ? '。' : '，可以切换查看。'}` : batch.error_message || '刷新未完成。'
          target.value = undefined
        }
      } catch (error) {
        if (!life.signal.aborted) refreshError.value = (error as Error).message
      }
    }
    const data = await readStatus()
    if (target.value || (data ?? status.value)?.scheduler.active) follow()
  }, 3000)
}

function watchRun(id: number) {
  target.value = id
  notice.value = `正在查看初筛批次 #${id}。`
  polls = 0
  follow()
}

async function manual() {
  if (pending.value) return
  if (active.value) {
    watchRun(active.value.id)
    return
  }
  pending.value = true
  refreshError.value = ''
  notice.value = ''
  refreshKey.value ||= crypto.randomUUID()
  try {
    const batch = await refreshScreening(refreshKey.value, life.signal)
    refreshKey.value = ''
    watchRun(batch.id)
    await readStatus()
  } catch (error) {
    if (!life.signal.aborted) refreshError.value = (error as Error).message
  } finally { pending.value = false }
}

watch([bodyKey, retry], async (_key, _old, onCleanup) => {
  const controller = new AbortController()
  const signal = controller.signal
  onCleanup(() => controller.abort())
  bodyError.value = ''
  historyDetail.value = undefined
  if (!runId.value && tab.value !== 'history') {
    results.value = undefined
    shownRun.value = undefined
    loading.value = false
    return
  }
  loading.value = true
  try {
    if (tab.value === 'history') {
      const page = query('page') || '1'
      const log = query('log')
      const [list, detail] = await Promise.all([
        screeningGet<History>('/runs?' + new URLSearchParams({ page }), signal),
        log ? screeningGet<RunDetail>('/runs/' + encodeURIComponent(log), signal) : Promise.resolve(undefined),
      ])
      if (signal.aborted) return
      history.value = list
      historyDetail.value = detail
    } else {
      const id = runId.value as number
      const params = new URLSearchParams({ run_id: String(id) })
      if (tab.value === 'shortlist') params.set('shortlisted', '1')
      if (['pending', 'watch', 'rejected'].includes(tab.value)) params.set('status', tab.value)
      if (query('stage') === 'eligible') params.set('status', 'eligible')
      for (const key of ['term', 'category', 'issuer', 'hint', 'q', 'page', 'sort']) if (query(key)) params.set(key, query(key))
      if (['yield', 'quota'].includes(query('stage'))) params.set('stage', query('stage'))
      const [list, batch] = await Promise.all([
        screeningGet<Results>('/results?' + params, signal),
        shownRun.value?.id === id ? Promise.resolve(shownRun.value) : screeningGet<RunDetail>('/runs/' + id, signal),
      ])
      if (signal.aborted) return
      results.value = list
      shownRun.value = batch
    }
  } catch (error) {
    if (!signal.aborted) bodyError.value = (error as Error).message
  } finally { if (!signal.aborted) loading.value = false }
}, { immediate: true })

onMounted(async () => {
  const data = await readStatus()
  if (data?.scheduler.active) follow()
})
onUnmounted(() => {
  life.abort()
  if (poll !== undefined) window.clearTimeout(poll)
})

function search(event: SubmitEvent) {
  const value = new FormData(event.currentTarget as HTMLFormElement).get('q')
  void updateQuery({ q: String(value || '').trim(), page: null })
}
function filter(key: string, event: Event) {
  void updateQuery({ [key]: (event.target as HTMLInputElement).value.trim(), page: null })
}
function selectTab(value: string) { void updateQuery({ tab: value === 'shortlist' ? null : value, page: null, stage: null, log: null }) }
function switchBatch(id: number) {
  notice.value = ''
  void updateQuery({ run: id, page: null, tab: null, stage: null, log: null, channel: null, code: null })
}
function openRow(row: Row, event: Event) {
  originFocus = event.currentTarget as HTMLElement
  void updateQuery({ channel: row.channel, code: row.code })
}
async function closeDetail() {
  await updateQuery({ channel: null, code: null }, true)
  await nextTick()
  if (originFocus?.isConnected) originFocus.focus({ preventScroll: true })
  else document.querySelector<HTMLElement>('.screening-tabs [aria-current="true"]')?.focus()
}
</script>

<template>
  <div class="screening r2-page" aria-label="R2 选品初筛">
    <R2PageHeader title="选品初筛" description="按公开披露核对人民币公募 R2 份额。正式候选按同期限、同分类的近 1 月年化排序。">
      <template #actions>
        <button type="button" class="button button-ghost button-small" @click="selectTab(tab === 'history' ? 'shortlist' : 'history')">
          {{ tab === 'history' ? '返回筛选结果' : '运行记录' }}
        </button>
        <button type="button" class="button button-primary button-small"
          :disabled="pending || !status || !['ready', 'empty'].includes(status.availability)" @click="manual">
          {{ pending ? '正在提交…' : active ? '查看运行' : '刷新初筛' }}
        </button>
      </template>
    </R2PageHeader>

    <section class="batch-strip" aria-label="批次和证据时效">
      <div><span>当前展示批次</span><strong>{{ visibleRun ? visibleRun.business_date + ' · #' + visibleRun.id : '—' }}</strong></div>
      <div><span>最近运行</span><strong>{{ status?.last_attempt ? localTime(status.last_attempt.finished_at || status.last_attempt.created_at) + ' · ' + runState[status.last_attempt.status] : '—' }}</strong></div>
      <div><span>下次定时刷新 · 北京时间</span><strong>{{ localTime(status?.next_due_at) }}</strong></div>
      <div v-if="visibleRun"><span>策略 / 当前最新披露（业绩 · 净值）</span>
        <strong>{{ visibleRun.rule_version }} / {{ ages?.performance_latest || '—' }} · {{ ages?.nav_latest || '—' }}</strong></div>
    </section>
    <div v-if="statusError || refreshError" class="screening-notice is-warn" role="alert">
      {{ statusError || refreshError }} <button v-if="statusError" type="button" class="link-button" @click="readStatus()">重新读取状态</button>
    </div>
    <div v-if="notice || isHistorical || (status && status.availability !== 'ready') || visibleRun?.status === 'degraded' ||
      status?.current_run?.id !== runId || status?.last_attempt?.status === 'failed' || status?.scheduler.calendar_gap || ages?.performance_expired || ages?.nav_expired"
      class="screening-notice" role="status">
      <span v-if="notice">{{ notice }}</span>
      <span v-if="isHistorical">当前显示历史批次 {{ visibleRun?.business_date }}，额度保留当时的查询时点。</span>
      <span v-if="status?.last_attempt?.status === 'failed'">最近刷新失败。{{ status.last_attempt.error_message }}</span>
      <span v-if="status?.availability === 'disabled'">初筛刷新已停用。</span>
      <span v-if="status?.availability === 'uninitialized'">初筛库尚未初始化。</span>
      <span v-if="status?.availability === 'unavailable'">初筛库暂不可读。</span>
      <span v-if="visibleRun?.status === 'degraded'">部分份额证据待核，可在结果中查看原因。</span>
      <span v-if="status?.scheduler.calendar_gap">刷新日历覆盖不足。</span>
      <span v-if="ages && (ages.performance_expired || ages.nav_expired)">
        按今天的有效期，业绩过期 {{ ages.performance_expired }} 个，净值过期 {{ ages.nav_expired }} 个。</span>
      <button v-if="status?.current_run && status.current_run.id !== runId" type="button" class="link-button" @click="switchBatch(status.current_run.id)">
        切换到最新批次 #{{ status.current_run.id }}
      </button>
    </div>

    <section v-if="tab === 'history'" class="screen-panel" aria-labelledby="screen-history-title">
      <h2 id="screen-history-title">运行记录</h2>
      <p v-if="loading" role="status" class="screen-empty">正在读取运行记录…</p>
      <p v-else-if="bodyError" role="alert" class="screen-empty">{{ bodyError }}</p>
      <p v-else-if="!history?.items.length" class="screen-empty">暂无运行记录。</p>
      <template v-else>
        <div class="screen-table-wrap" tabindex="0" aria-label="初筛运行记录">
          <table class="history-table">
            <thead><tr><th scope="col">批次</th><th scope="col">触发</th><th scope="col">状态</th><th scope="col">结束时间</th><th scope="col">正式候选</th><th scope="col">操作</th></tr></thead>
            <tbody><tr v-for="run in history.items" :key="run.id">
              <td>{{ run.business_date }} · #{{ run.id }}<small v-if="run.id === status?.current_run?.id">当前发布</small></td>
              <td>{{ triggerLabel[run.trigger] }}</td><td>{{ runState[run.status] }}</td><td>{{ localTime(run.finished_at) }}</td>
              <td>{{ run.counts?.shortlisted ?? '—' }}</td>
              <td class="history-actions">
                <button type="button" class="link-button" @click="updateQuery({ log: String(run.id) })">运行详情</button>
                <button v-if="run.counts" type="button" class="link-button" @click="switchBatch(run.id)">查看结果</button>
              </td>
            </tr></tbody>
          </table>
        </div>
        <div v-if="historyPages > 1" class="screen-pagination">
          <button type="button" class="button button-ghost button-small" :disabled="history.page <= 1" @click="updateQuery({ page: history.page - 1, log: null })">上一页</button>
          <span>第 {{ history.page }} / {{ historyPages }} 页</span>
          <button type="button" class="button button-ghost button-small" :disabled="history.page >= historyPages" @click="updateQuery({ page: history.page + 1, log: null })">下一页</button>
        </div>
        <section v-if="historyDetail" class="run-detail" aria-labelledby="run-detail-title">
          <h3 id="run-detail-title">批次 #{{ historyDetail.id }} · {{ runState[historyDetail.status] }}</h3>
          <p>规则 {{ historyDetail.rule_version }} · {{ historyDetail.refresh_calendar_version }} · {{ historyDetail.valuation_calendar_version }} · {{ historyDetail.collector_version }}</p>
          <p v-if="historyDetail.error_message">{{ historyDetail.error_message }}</p>
          <p v-if="historyDetail.retry_at">计划重试 {{ localTime(historyDetail.retry_at) }}</p>
          <p v-if="historyDetail.counts">通过 {{ historyDetail.counts.eligible }} · 观察 {{ historyDetail.counts.watch }} · 待核 {{ historyDetail.counts.pending }} · 淘汰 {{ historyDetail.counts.rejected }}</p>
          <ul><li v-for="attempt in historyDetail.attempts" :key="attempt.attempt">
            第 {{ attempt.attempt }} 次 · {{ localTime(attempt.started_at) }} 至 {{ localTime(attempt.finished_at) }} · {{ runState[attempt.status] }} {{ attempt.error_message || '' }}
          </li></ul>
          <dl v-if="historyDetail.health" class="source-stats">
            <div v-for="(info, key) in historyDetail.health" :key="key"><dt>{{ ({ pool: '产品池', quota: '额度', shelf: '公开货架', detail: '产品详情', nav: '净值', prospectus: '正式说明书', reports: '定期报告' } as Record<string, string>)[key] || key }}</dt>
              <dd>{{ info.requested == null ? (info.covered ?? 0) + ' 个份额 / ' + (info.pages ?? 0) + ' 页' : (info.ok ?? 0) + ' / ' + info.requested }}</dd></div>
          </dl>
        </section>
      </template>
    </section>

    <template v-else>
      <section v-if="funnel.length" class="screen-funnel" aria-label="批次筛选统计">
        <div v-for="step in funnel" :key="step.title">
          <strong>{{ step.count }}</strong><span>{{ step.title }}</span>
        </div>
      </section>
      <section class="screen-panel" aria-label="筛选结果">
        <nav class="screening-tabs" aria-label="筛选状态">
          <button v-for="[key, label, count] in tabs" :key="key" type="button"
            :aria-current="tab === key && !query('stage') ? 'true' : undefined" @click="selectTab(String(key))">
            {{ label }} <span v-if="count !== undefined">{{ count }}</span>
          </button>
        </nav>
        <form v-if="runId" class="screen-filters" @submit.prevent="search">
          <label>代码或名称<input name="q" type="search" :value="query('q')" placeholder="输入后回车" @search="filter('q', $event)" /></label>
          <label>期限<select :value="query('term')" @change="filter('term', $event)"><option value="">全部期限</option>
            <option v-for="term in results?.facets.terms" :key="term ?? 'unknown'" :value="term ?? 'unknown'">{{ term == null ? '期限待核' : term === 0 ? '每日开放' : term + ' 天' }}</option></select></label>
          <label>分类<select :value="query('category')" @change="filter('category', $event)"><option value="">全部分类</option>
            <option v-for="(label, key) in categoryLabel" :key="key" :value="key">{{ label }}</option></select></label>
          <label>发行方<select :value="query('issuer')" @change="filter('issuer', $event)"><option value="">全部发行方</option>
            <option v-for="issuer in results?.facets.issuers" :key="issuer">{{ issuer }}</option></select></label>
          <label>提示<select :value="query('hint')" @change="filter('hint', $event)"><option value="">全部提示</option>
            <option v-for="(label, key) in hintLabel" :key="key" :value="key">{{ label }}</option></select></label>
          <label>排序<select :value="query('sort')" @change="filter('sort', $event)"><option value="">期限与分类</option>
            <option value="yield_desc">近 1 月年化</option><option value="drawdown">最大回撤</option><option value="code">销售代码</option></select></label>
          <button type="button" class="button button-ghost button-small" @click="updateQuery({ q: null, term: null, category: null, issuer: null, hint: null, sort: null, stage: null, page: null })">重置</button>
        </form>
        <div v-if="loading || (!status && !statusError)" class="screen-empty" role="status" aria-busy="true">正在读取初筛批次…</div>
        <div v-else-if="bodyError" class="screen-empty" role="alert">{{ bodyError }} <button type="button" class="link-button" @click="retry++">重试</button></div>
        <div v-else-if="!runId" class="screen-empty">
          <strong>{{ active ? '首轮正在采集' : '暂无可用初筛批次' }}</strong>
          <p>{{ active ? '批次发布后，本页将显示通过、待核和淘汰份额。' : '完成首次刷新后，按批次查看公开份额和证据。' }}</p>
        </div>
        <div v-else-if="!results?.total" class="screen-empty">
          {{ tab === 'shortlist' && !visibleRun?.counts?.shortlisted ? '此批次没有正式候选，可在全部份额查看判定。' : '没有符合当前筛选条件的份额。' }}
        </div>
        <template v-else>
          <p class="table-note">匹配 {{ results.total }} 个份额 · 业绩为年化披露值，回撤取未复权单位净值 · 额度时点见详情</p>
          <div class="screen-table-wrap" tabindex="0" aria-label="筛选份额表">
            <table class="result-table">
              <thead><tr><th scope="col">销售份额</th><th scope="col" class="numeric">1M / 3M</th><th scope="col" class="numeric">回撤 / 修复</th>
                <th scope="col">公开额度</th><th scope="col">判定与提示</th><th scope="col">披露与证据</th></tr></thead>
              <tbody v-for="(group, i) in byGroup" :key="group.title + i">
                <tr v-if="!query('sort') || query('sort') === 'group'" class="result-group"><th scope="rowgroup" colspan="6">{{ group.title }}</th></tr>
                <tr v-for="row in group.rows" :key="row.channel + row.code">
                  <th scope="row">
                    <button type="button" class="share-name" @click="openRow(row, $event)">{{ row.name }}</button>
                    <small>{{ row.code }} · {{ row.channel }} · {{ row.issuer }}</small>
                    <small v-if="query('sort')">{{ group.title }}</small>
                  </th>
                  <td class="numeric"><strong>{{ pct(row.performance['1m']) }}</strong><small>{{ pct(row.performance['3m']) }}</small></td>
                  <td class="numeric">{{ drawdownPct(row.metrics.drawdown.pct) }}<small>{{ recoveryLabel[row.metrics.drawdown.recovery] }}</small></td>
                  <td>
                    <span>{{ row.quota.amount || (row.quota.assumption ? '策略默认 >5,000 万元' : row.quota.status === 1 ? '售罄' : '—') }}</span>
                    <small v-if="row.quota.assumption && amountStates[row.quota.amount_state]">{{ amountStates[row.quota.amount_state] }}</small>
                    <small v-if="row.quota.checked_at">{{ localTime(row.quota.checked_at) }}</small>
                  </td>
                  <td><strong :data-status="row.status">{{ row.shortlisted ? '正式候选 · 第 ' + row.rank + ' 名' : stateLabel[row.status] }}</strong>
                    <small v-if="row.reason">{{ reasonLabel[row.reason.code] || row.reason.code }}</small>
                    <small v-if="row.metrics.zero_count != null" :class="{ 'hint-warn': row.hints.includes('frequent_zero') }">
                      {{ row.hints.includes('frequent_zero') ? '频繁挂零' : '挂零' }} {{ row.metrics.zero_count }} 次
                    </small>
                    <small v-for="hint in row.hints.filter(h => !['frequent_zero', 'quota_default'].includes(h))" :key="hint" class="hint-warn">{{ hintLabel[hint] }}</small>
                  </td>
                  <td>
                    <span>业绩 {{ row.performance_date || '待核' }}</span><small v-if="evidenceExpired(row.performance_date, today)" class="hint-warn">业绩已过期</small>
                    <small>净值 {{ row.metrics.latest || '—' }}<template v-if="evidenceExpired(row.metrics.latest, today)"> · 已过期</template></small>
                    <button type="button" class="link-button" :aria-label="'证据详情 ' + row.code" @click="openRow(row, $event)">证据详情</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="screen-pagination" aria-label="结果分页">
            <button type="button" class="button button-ghost button-small" :disabled="results.page <= 1" @click="updateQuery({ page: results.page - 1 })">上一页</button>
            <span>第 {{ results.page }} / {{ tablePages }} 页</span>
            <button type="button" class="button button-ghost button-small" :disabled="results.page >= tablePages" @click="updateQuery({ page: results.page + 1 })">下一页</button>
          </div>
        </template>
      </section>
    </template>

    <ScreeningDetail v-if="runId && query('channel') && query('code')" :run="runId" :channel="query('channel')" :code="query('code')" @close="closeDetail" />
  </div>
</template>

<style scoped>
.screening { --screen-control-line: color-mix(in srgb, var(--ink-soft) 72%, var(--card)); min-width: 0; color: var(--ink); font-size: 14px; font-variant-numeric: tabular-nums; }
.screening .button-ghost:not(:disabled) { border-color: var(--screen-control-line); }
.screening :deep(.r2-page-desc) { color: var(--ink-soft); }
.batch-strip { display: grid; grid-template-columns: 1fr 1.35fr 1.15fr 1.5fr; gap: 12px; margin: 12px 0; padding: 12px 0;
  border-block: 1px solid var(--line-strong); }
.batch-strip span, .table-note, small { display: block; font-size: 13px; color: var(--ink-soft); }
.batch-strip strong { font-size: 13px; display: block; margin-top: 3px; overflow-wrap: anywhere; }
.screening-notice { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px;
  padding: 9px 12px; margin: 0 0 12px; border-radius: 10px; background: var(--green-wash); color: var(--ink); font-size: 13px; }
.screening-notice.is-warn { background: var(--surface-warning); color: var(--warning-ink); }
.screen-funnel { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 16px 0; border-block: 1px solid var(--line-strong); }
.screen-funnel > div { display: flex; align-items: baseline; gap: 8px; justify-content: center; padding: 12px 8px; }
.screen-funnel > div + div { border-inline-start: 1px solid var(--screen-control-line); }
.screen-funnel strong { font-size: 19px; font-weight: 650; }
.screen-panel { border: 1px solid var(--line-strong); border-radius: 14px; background: var(--card); padding: 12px 14px 14px; min-width: 0; }
.screen-panel h2 { font-size: 19px; margin: 4px 0 10px; }
.screening-tabs { display: flex; flex-wrap: wrap; gap: 6px; border-bottom: 1px solid var(--line-strong); }
.screening-tabs button { background: transparent; color: var(--ink); font: inherit; font-weight: 600; cursor: pointer;
  border: 0; border-bottom: 2px solid transparent; padding: 9px 10px; }
.screening-tabs button[aria-current="true"] { border-color: var(--green); color: var(--green); }
.screening-tabs span { margin-inline-start: 3px; font-size: 13px; font-weight: 500; }
.screen-filters { display: grid; grid-template-columns: 1.25fr .8fr .9fr 1.05fr 1.15fr .95fr auto; align-items: end; gap: 8px; margin-block: 14px 8px; }
.screen-filters label { display: grid; min-width: 0; gap: 4px; font-size: 13px; color: var(--ink-soft); }
.screen-filters input, .screen-filters select { width: 100%; min-width: 0; height: 36px; padding-inline: 8px; border-radius: 10px;
  border: 1px solid var(--ink-soft); background: var(--card); color: var(--ink); font: inherit; }
.screen-filters input::placeholder { color: var(--ink-soft); }
.table-note { margin: 8px 0; }
.screen-table-wrap { max-width: 100%; overflow-x: auto; scrollbar-color: var(--line-strong) var(--card); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
.result-table { min-width: 810px; }
th, td { vertical-align: top; padding: 9px 10px; border-bottom: 1px solid var(--line); text-align: start; }
thead th { background: var(--card-soft); color: var(--ink); white-space: nowrap; }
.result-table th[scope="row"] { width: 32%; overflow-wrap: anywhere; }
th.numeric, td.numeric { text-align: end; white-space: nowrap; }
.result-group th { background: var(--green-wash); color: var(--ink); padding-block: 6px; }
.result-table td:last-child { min-width: 126px; }
td small, th small { margin-top: 3px; font-weight: normal; }
.share-name, .link-button { border: 0; background: transparent; padding: 0; color: var(--green);
  text-decoration: underline; text-underline-offset: 3px; font: inherit; cursor: pointer; }
.share-name { font-weight: 650; text-align: start; }
.link-button:hover, .share-name:hover { color: var(--ink); }
[data-status="rejected"] { color: var(--danger-ink); }
[data-status="watch"], [data-status="pending"], .hint-warn { color: var(--warning-ink); }
.screen-empty { padding: 32px 14px; color: var(--ink-soft); }
.screen-empty p { margin: 6px 0 0; }
.screen-pagination { display: flex; align-items: center; justify-content: end; gap: 10px; margin-top: 12px; }
.history-table { min-width: 680px; }
.history-actions button + button { margin-left: 12px; }
.run-detail { margin-top: 16px; padding: 12px 0 0; border-top: 1px solid var(--line-strong); }
.source-stats { display: flex; flex-wrap: wrap; gap: 18px; }
.source-stats dd { margin: 0; }
:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; }
@media (max-width: 1100px) { .screen-filters { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
</style>
