<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import { formatMoney, formatPct, formatSignedMoney } from '@/composables/useFormatters'
import type { QuarterlyNote, ReviewData, ReviewNote } from '@/types/dashboard'

type NoteLike = ReviewNote | QuarterlyNote

const props = defineProps<{
  mode: 'monthly' | 'quarterly'
  notes: NoteLike[]
  today: string
  review: ReviewData
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
  '单只/单发行方集中度是否超限？',
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

const selected = ref(options.value[1] ?? options.value[0] ?? '')
const answers = ref<string[]>(Array(questions.value.length).fill(''))
const conclusion = ref('')
const saving = ref(false)

const existing = computed(
  () => props.notes.find((note) => keyOf(note) === selected.value) || null,
)

const monthRow = computed(() => {
  if (props.mode !== 'monthly') return null
  return props.review.monthly.find((item) => item.month === selected.value) || null
})

const exportUrl = computed(() => `/api/review/export?month=${selected.value}`)

watch(selected, loadFromNote, { immediate: true })

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
      await store.saveReviewNote(selected.value, {
        answers: answers.value,
        conclusion: conclusion.value,
      })
      show(`${periodLabel(selected.value)}五问已保存`)
    } else {
      await store.saveQuarterlyNote(selected.value, {
        answers: answers.value,
        conclusion: conclusion.value,
      })
      show(`${periodLabel(selected.value)}季度清单已保存`)
    }
    loadFromNote()
  } catch (error) {
    show(error instanceof Error ? error.message : '保存失败', { error: true })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="rw-panel-body">
    <div class="rw-toolbar">
      <div>
        <strong class="rw-panel-title">
          {{ mode === 'monthly' ? '月度五问' : '季度复盘清单' }}
        </strong>
        <p class="rw-panel-sub">
          {{
            mode === 'monthly'
              ? '每月 10 分钟，回答五问，留下当月结论和下月只改的一件事。'
              : '每季 30 分钟，只复核结构：桶比例、集中度、期限阶梯和替换清单。'
          }}
        </p>
      </div>
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

    <div v-if="mode === 'monthly' && monthRow" class="rw-note-metrics">
      <span>月收益 <strong>{{ formatSignedMoney(monthRow.pnl) }}</strong></span>
      <span>月收益率 <strong>{{ formatPct(monthRow.return_pct, 3, true) }}</strong></span>
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
