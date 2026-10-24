<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import { formatMoney, formatPct, formatSignedMoney } from '@/composables/useFormatters'
import type {
  AutomationWorkspace,
  QuarterlyNote,
  ReviewData,
  ReviewNote,
  ReviewWorkspace,
} from '@/types/dashboard'

type NoteLike = ReviewNote | QuarterlyNote

const props = defineProps<{
  mode: 'monthly' | 'quarterly'
  notes: NoteLike[]
  today: string
  review: ReviewData
  automation: AutomationWorkspace
  workspace: ReviewWorkspace
}>()

const store = useDashboardStore()
const { show } = useToast()

const monthlyQuestions = [
  '这个月有没有按计划执行？哪一次偏离了，为什么？',
  '哪笔操作真正增加了收益，哪笔只是增加了忙碌？',
  '闲置资金拖累是否接近 0？近 3M/6M/1Y 年化离 3% 差多少？',
  '有没有产品触发风险、流动性或费率红线？',
  '下个月只改一件事，改什么？',
]

const quarterlyQuestions = [
  '三个工作桶（+可选流动性仓）的比例偏离目标多少？超过 5 个百分点了吗？',
  '单只占比是否超限？发行方占比只作持仓状态记录，不作限制。',
  '期限阶梯是否还能覆盖未来 12 个月现金流？',
  '费用和闲置资金拖累是否在可接受范围？',
  '有没有产品需要替换（规则变化、持续跑输、流动性变差）？',
  '这套方法花的时间，和超额收益相比是否值得？',
]

const questions = computed(() =>
  props.mode === 'monthly' ? monthlyQuestions : quarterlyQuestions,
)

const options = computed(() => {
  const base =
    props.mode === 'monthly' ? monthOptions(props.today) : quarterOptions(props.today)
  const saved = props.notes.map(keyOf)
  return [...new Set([...saved, ...base])].sort((a, b) => b.localeCompare(a))
})

const selected = ref(options.value[0] ?? '')
const answers = ref<string[]>(Array(questions.value.length).fill(''))
const conclusion = ref('')
const saving = ref(false)
const suggested = ref(false)

const existing = computed(
  () => props.notes.find((note) => keyOf(note) === selected.value) || null,
)

const draft = computed(() => {
  const periodType = props.mode === 'monthly' ? 'monthly' : 'quarterly'
  return (
    props.automation.drafts.find(
      (item) => item.period_type === periodType && item.period === selected.value,
    ) || null
  )
})

const monthRow = computed(() => {
  if (props.mode !== 'monthly') return null
  return props.review.monthly.find((item) => item.month === selected.value) || null
})

const monthTrades = computed(() =>
  (props.workspace.trades?.trades || []).filter((item) =>
    item.trade_date.startsWith(selected.value),
  ),
)
const pendingMonthTrades = computed(() =>
  monthTrades.value.filter((item) => item.status === 'pending'),
)
const confirmedMonthTrades = computed(() =>
  monthTrades.value.filter((item) => item.status === 'confirmed'),
)

watch(selected, loadFromNote, { immediate: true })

watch(
  [draft, existing, monthRow],
  ([nextDraft, note]) => {
    if (
      nextDraft?.status === 'draft' &&
      !note &&
      answers.value.every((item) => !item.trim())
    ) {
      applyDraftContent(false)
      suggested.value = false
      return
    }
    if (
      props.mode === 'monthly' &&
      !note &&
      !nextDraft &&
      answers.value.every((item) => !item.trim())
    ) {
      applySuggestion()
    }
  },
  { immediate: true },
)

const exportUrl = computed(() => `/api/review/export?month=${selected.value}`)

function keyOf(note: NoteLike): string {
  return 'month' in note ? note.month : note.quarter
}

function monthOptions(today: string): string[] {
  const [year, month] = today.split('-').map(Number)
  const result: string[] = []
  for (let index = 0; index < 18; index += 1) {
    const date = new Date(Date.UTC(year, month - 1 - index, 1))
    result.push(
      `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`,
    )
  }
  return result
}

function quarterOptions(today: string): string[] {
  let year = Number(today.slice(0, 4))
  let quarter = Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1
  const result: string[] = []
  for (let index = 0; index < 10; index += 1) {
    result.push(`${year}-Q${quarter}`)
    quarter -= 1
    if (quarter === 0) {
      quarter = 4
      year -= 1
    }
  }
  return result
}

function periodLabel(key: string): string {
  if (/^\d{4}-\d{2}$/.test(key)) {
    return `${key.slice(0, 4)}年${Number(key.slice(5, 7))}月`
  }
  if (/^\d{4}-Q[1-4]$/.test(key)) {
    return `${key.slice(0, 4)}年第${key.slice(6, 7)}季度`
  }
  return key
}

function loadFromNote(): void {
  const note = existing.value
  answers.value = Array.from({ length: questions.value.length }, (_, index) =>
    note?.answers[index] ? note.answers[index] : '',
  )
  conclusion.value = note?.conclusion || ''
  suggested.value = false
}

function selectPeriod(key: string): void {
  selected.value = key
}

async function save(): Promise<void> {
  if (!selected.value) {
    show('请选择复盘周期', { error: true })
    return
  }
  saving.value = true
  try {
    if (props.mode === 'monthly') {
      if (draft.value?.status === 'draft') {
        await store.confirmDraft('monthly', selected.value, {
          answers: answers.value,
          conclusion: conclusion.value,
        })
        show(`${periodLabel(selected.value)}月度草稿已确认并保存`)
      } else {
        await store.saveReviewNote(selected.value, {
          answers: answers.value,
          conclusion: conclusion.value,
        })
        show(`${periodLabel(selected.value)}五问已保存`)
      }
    } else {
      if (draft.value?.status === 'draft') {
        await store.confirmDraft('quarterly', selected.value, {
          answers: answers.value,
          conclusion: conclusion.value,
        })
        show(`${periodLabel(selected.value)}季度草稿已确认并保存`)
      } else {
        await store.saveQuarterlyNote(selected.value, {
          answers: answers.value,
          conclusion: conclusion.value,
        })
        show(`${periodLabel(selected.value)}季度清单已保存`)
      }
    }
    loadFromNote()
  } catch (error) {
    show(error instanceof Error ? error.message : '保存失败', { error: true })
  } finally {
    saving.value = false
  }
}

function adoptDraft(): void {
  applyDraftContent(true)
}

function applyDraftContent(notify: boolean): void {
  if (!draft.value) return
  const draftAnswers = Array.isArray(draft.value.content.answers)
    ? draft.value.content.answers
    : []
  answers.value = Array.from({ length: questions.value.length }, (_, index) =>
    String(draftAnswers[index] || ''),
  )
  conclusion.value = String(draft.value.content.conclusion || '')
  if (notify) {
    show('已填入草稿，请确认异常项和下一步动作后再保存')
  }
}

function applySuggestion(): void {
  if (props.mode !== 'monthly') return
  const row = monthRow.value
  const alerts = props.review.alerts || []
  const recordText = row
    ? `${row.record_days}/${row.elapsed_days} 天`
    : '0 天'
  const actionText = row
    ? `操作 ${row.action_count} 次（买入 ${row.buy_count}、赎回 ${row.redeem_count}、切换 ${row.switch_count}）`
    : '暂无操作记录'
  const hasRecords = Boolean(row?.has_records)
  const tradeText = `交易流水 ${monthTrades.value.length} 笔（已确认 ${
    confirmedMonthTrades.value.length
  }、待确认 ${pendingMonthTrades.value.length}）`
  const returnText =
    row && hasRecords && row.return_pct !== null
      ? `${formatPct(row.return_pct, 3, true)}，月收益 ${formatSignedMoney(row.pnl)}`
      : '尚无可计算的月收益率'
  const annualText =
    row && hasRecords && row.annualized_pct !== null && row.sample_sufficient
      ? `年化参考 ${formatPct(row.annualized_pct, 2, true)}，距 3% 目标 ${
          row.target_gap_pct === null
            ? '待计算'
            : `${row.target_gap_pct >= 0 ? '+' : ''}${row.target_gap_pct.toFixed(2)}pp`
        }`
      : '年化样本不足，暂不判断是否达到 3% 目标'
  const coverageText = row
    ? `记录完整度 ${row.record_coverage_pct ?? 0}%，缺记 ${row.missing_days} 天`
    : '还没有记录'
  answers.value = [
    hasRecords
      ? `本月记录 ${recordText}，${actionText}，${tradeText}。先按记录回看是否有未按计划执行的买入、赎回或切换；无记录的日子不能补判断。`
      : `本月还没有收益记录，无法判断是否按计划执行。${tradeText}；先补最近已披露的收益，再用交易流水核对买入、赎回和切换。`,
    hasRecords
      ? `本月结果：${returnText}；已确认交易 ${confirmedMonthTrades.value.length} 笔，待确认 ${pendingMonthTrades.value.length} 笔。最好单日 ${formatSignedMoney(
          row?.best_day ?? 0,
        )}，最差单日 ${formatSignedMoney(row?.worst_day ?? 0)}。单只产品结果仍以到期/赎回为准。`
      : `本月已有 ${confirmedMonthTrades.value.length} 笔已确认、${pendingMonthTrades.value.length} 笔待确认交易，但还没有到期/赎回结果；单只产品收益暂无法定论。`,
    `${annualText}。${coverageText}。`,
    `本月自动提醒 ${alerts.length} 条${
      alerts.length ? `：${alerts.map((item) => item.text).join('；')}` : '，暂未发现红线'
    }；待确认交易 ${pendingMonthTrades.value.length} 笔。`,
    hasRecords
      ? row && row.record_days >= 20
        ? '下月只改一件事：买入前在招行 App 核验额度，并在成交当天补截图和确认日期。'
        : `下月只改一件事：先把每日记录补齐到至少 20 条，当前还差 ${row?.records_needed_for_grade ?? 20} 条。`
      : '下月只改一件事：每天记一笔，先连续记满 7 天，再讨论月度评分和调仓。',
  ]
  conclusion.value = hasRecords
    ? `本月记录 ${recordText}，${returnText}；${tradeText}；${annualText}。先处理记录缺口和待确认交易，再决定是否调整期限桶。`
    : `本月尚无收益记录，暂不生成评分结论；${tradeText}。先补齐每日记录并确认交易，再回看执行与结果。`
  suggested.value = true
}

function regenerateSuggestion(): void {
  applySuggestion()
  show('已按本月账本重新生成建议，保存前请核对')
}
</script>

<template>
  <div class="rw-panel-body">
    <div class="rw-toolbar is-actions-only">
      <div class="rw-toolbar-actions">
        <span class="rw-status" :class="{ 'is-closed': existing }">
          {{ existing ? '已保存' : '未填写' }}
        </span>
        <a
          v-if="mode === 'monthly'"
          class="rw-button is-secondary"
          :href="exportUrl"
          download
        >
          导出 Markdown
        </a>
      </div>
    </div>

    <div class="rw-period-bar">
      <label class="rw-field is-inline">
        <span>复盘周期</span>
        <select v-model="selected">
          <option v-for="option in options" :key="option" :value="option">
            {{ periodLabel(option) }}
          </option>
        </select>
      </label>
      <div class="rw-saved-periods">
        <span>已保存</span>
        <button
          v-for="note in notes"
          :key="keyOf(note)"
          type="button"
          class="rw-period-chip"
          :class="{ 'is-active': keyOf(note) === selected }"
          @click="selectPeriod(keyOf(note))"
        >
          {{ periodLabel(keyOf(note)) }}
        </button>
        <span v-if="notes.length === 0" class="rw-muted">暂无</span>
      </div>
    </div>

    <div v-if="draft" class="rw-draft-banner" :class="{ 'is-confirmed': draft.status === 'confirmed' }">
      <div>
        <strong>{{ draft.content.title || `${periodLabel(draft.period)}复盘草稿` }}</strong>
        <p>
          {{ draft.status === 'confirmed' ? '草稿已确认并写入复盘。' : '已根据交易、收益、评估和事件自动起草，请先确认异常项。' }}
        </p>
        <ul v-if="draft.status === 'draft' && (draft.content.anomalies?.length ?? 0) > 0">
          <li v-for="item in (draft.content.anomalies || []).slice(0, 5)" :key="item">{{ item }}</li>
        </ul>
      </div>
      <button
        v-if="draft.status === 'draft'"
        type="button"
        class="rw-button is-secondary"
        @click="adoptDraft"
      >
        采用草稿
      </button>
    </div>

    <div v-else-if="suggested && !existing" class="rw-draft-banner is-suggestion">
      <div>
        <strong>已按本月账本填入自动建议</strong>
        <p>
          五问和结论已根据收益、记录完整度、操作次数和自动提醒预填，保存前请按实际情况修改。
        </p>
      </div>
      <button type="button" class="rw-button is-secondary" @click="regenerateSuggestion">
        重新生成
      </button>
    </div>

    <div v-if="mode === 'monthly' && monthRow" class="rw-note-metrics">
      <span>月收益 <strong>{{ formatSignedMoney(monthRow.pnl) }}</strong></span>
      <span>
        月收益率
        <strong>{{
          monthRow.has_records ? formatPct(monthRow.return_pct, 3, true) : '待记录'
        }}</strong>
      </span>
      <span>最大回撤 <strong>{{ formatPct(monthRow.max_drawdown_pct, 3) }}</strong></span>
      <span>记录 <strong>{{ monthRow.record_days }}/{{ monthRow.elapsed_days }} 天</strong></span>
      <span>月均本金 <strong>¥{{ formatMoney(monthRow.avg_principal, 0) }}</strong></span>
    </div>
    <div v-else-if="mode === 'monthly'" class="rw-note-metrics is-empty">
      该月还没有收益记录，五问仍然可以先写。
    </div>

    <form class="rw-questions" @submit.prevent="save">
      <label v-for="(question, index) in questions" :key="question" class="rw-question">
        <span class="rw-question-label">
          <em>{{ index + 1 }}</em>
          {{ question }}
        </span>
        <textarea
          v-model="answers[index]"
          rows="3"
          maxlength="2000"
          :placeholder="
            index === questions.length - 1
              ? '只写一件事，具体到动作和验证日期'
              : '写下当时的判断、证据和偏差'
          "
        ></textarea>
      </label>
      <label class="rw-field is-wide">
        <span>{{ mode === 'monthly' ? '当月结论' : '季度结论' }}</span>
        <textarea
          v-model="conclusion"
          rows="3"
          maxlength="4000"
          placeholder="用两三句话总结这个周期：流程是否执行、结果如何、下个周期先做什么"
        ></textarea>
      </label>
      <div class="rw-form-actions">
        <button type="submit" class="rw-button" :disabled="saving">
          {{ saving ? '保存中…' : existing ? '更新复盘' : '保存复盘' }}
        </button>
        <span v-if="existing" class="rw-muted">
          上次保存：{{ new Date(existing.updated_at).toLocaleString('zh-CN') }}
        </span>
      </div>
    </form>
  </div>
</template>

<style scoped>
.rw-draft-banner.is-suggestion {
  border-color: rgba(var(--green-rgb), 0.24);
  background: var(--green-wash);
}
</style>
