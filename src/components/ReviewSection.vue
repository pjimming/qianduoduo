<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MonthlyReview, ReviewData, ReviewNote } from '@/types/dashboard'
import {
  formatDateCN,
  formatDateShort,
  formatMoney,
  formatPct,
  formatPp,
  formatSignedMoney,
} from '@/composables/useFormatters'

const props = defineProps<{
  review: ReviewData
  notes?: ReviewNote[]
  today: string
}>()

const emit = defineEmits<{
  record: [date: string]
}>()

const selectedMonth = ref<string>(
  props.review.current_month?.month ?? props.review.monthly[0]?.month ?? '',
)

const gradeClassMap: Record<string, string> = {
  不及格: 'grade-fail',
  及格: 'grade-pass',
  良好: 'grade-good',
  优秀: 'grade-excellent',
  卓越: 'grade-outstanding',
}

const history = computed(() => props.review.monthly)
const daily = computed(() => props.review.daily)
const weekly = computed(() => props.review.weekly)
const alerts = computed(() => props.review.alerts ?? [])
const accountStartDate = computed(() => props.review.account_start_date ?? null)
const monthly = computed<MonthlyReview | null>(() => {
  if (selectedMonth.value) {
    return history.value.find((item) => item.month === selectedMonth.value) ?? null
  }
  return props.review.current_month ?? history.value[0] ?? null
})
const selectedNote = computed(() => {
  if (!monthly.value) return null
  return (props.notes ?? []).find((note) => note.month === monthly.value?.month) ?? null
})
const highlightGrade = computed(() => {
  if (!monthly.value) return null
  return monthly.value.provisional
    ? monthly.value.grade_preview
    : monthly.value.grade
})
const hasData = computed(() => Boolean(monthly.value?.has_records))
const gradeScale = computed(() => {
  const thresholds = props.review.thresholds ?? []
  return [
    { grade: '及格', min: thresholds[0] ?? 0.16 },
    { grade: '良好', min: thresholds[1] ?? 0.2 },
    { grade: '优秀', min: thresholds[2] ?? 0.25 },
    { grade: '卓越', min: thresholds[3] ?? 0.3 },
  ]
})

watch(
  () => history.value.map((item) => item.month),
  (months) => {
    if (!selectedMonth.value || !months.includes(selectedMonth.value)) {
      selectedMonth.value =
        props.review.current_month?.month ?? history.value[0]?.month ?? ''
    }
  },
  { immediate: true },
)

function gradeClass(grade: string | null | undefined): string {
  return grade ? gradeClassMap[grade] ?? '' : ''
}

function tone(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return 'neutral'
  return value > 0 ? 'positive' : 'negative'
}

function deltaClass(value: number | null | undefined, invert = false): string {
  if (value === null || value === undefined || value === 0) return 'neutral'
  const good = invert ? value < 0 : value > 0
  return good ? 'positive' : 'negative'
}

function progressWidth(value: number | null | undefined): string {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0%'
  return `${Math.max(0, Math.min(100, number))}%`
}

function formatSignedCount(value: number | null | undefined): string {
  const number = Number(value) || 0
  if (number === 0) return '0'
  return `${number > 0 ? '+' : '−'}${Math.abs(number)}`
}

function actionClass(action: string | undefined): string {
  if (action === '买入') return 'is-buy'
  if (action === '赎回') return 'is-redeem'
  if (action === '切换') return 'is-switch'
  return 'is-none'
}

function dailyGradeClass(): string {
  if (!daily.value || daily.value.provisional) return ''
  return gradeClass(daily.value.month_grade)
}

function nextGradeMessage(returnPct: number | null): string {
  if (returnPct === null || !Number.isFinite(returnPct)) {
    return '还没有足够的月度数据。'
  }
  for (const step of gradeScale.value) {
    if (returnPct < step.min) {
      return `距${step.grade}档还差 ${(step.min - returnPct).toFixed(3)} 个百分点`
    }
  }
  return '已达到最高档，继续保持节奏。'
}

function monthlyMessage(item: MonthlyReview | null): string {
  if (!item) return '记录收益后自动生成月度评分。'
  const maxEligibleDays = item.elapsed_days + item.days_remaining
  if (!item.has_records) {
    return item.before_start_days > 0
      ? `账本自 ${item.account_start_date ?? '起始日'} 起算，本月可记 ${item.elapsed_days} 天；起始日前不计缺记，先补今天的记录。`
      : `本月已过 ${item.elapsed_days} 天，还没有收益记录；先补今天，评分会在记录后自动生成。`
  }
  if (item.provisional) {
    const range = item.grade_range
      ? `${item.grade_range.low}–${item.grade_range.high} 档`
      : '区间待定'
    return `月中参考：当前 ${formatPct(item.return_pct, 3, true)}，按当前速度月底约 ${formatPct(
      item.projected_pct,
      3,
      true,
    )}（${range}）。`
  }
  if (!item.sample_sufficient) {
    if (item.before_start_days > 0 && maxEligibleDays < 28) {
      return `起始月最多可记 ${maxEligibleDays} 天、现有 ${item.record_days} 条记录；不足 28 天，不参与最终评级。`
    }
    return `样本不足：仅 ${item.record_days} 条记录、覆盖 ${item.elapsed_days} 天，不参与评级。`
  }
  return nextGradeMessage(item.return_pct)
}

const recordedSet = computed(() => new Set(monthly.value?.recorded_dates || []))
const calendarCells = computed(() => {
  if (!monthly.value) return []
  const [year, month] = monthly.value.month.split('-').map(Number)
  const totalDays = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const leading = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7
  const cells: Array<{
    key: string
    day: number
    date: string
    status: 'recorded' | 'missing' | 'future' | 'outside' | 'before-start'
  }> = []
  for (let index = 0; index < leading; index += 1) {
    cells.push({ key: `blank-${index}`, day: 0, date: '', status: 'outside' })
  }
  for (let day = 1; day <= totalDays; day += 1) {
    const date = `${monthly.value.month}-${String(day).padStart(2, '0')}`
    const periodStart =
      monthly.value.active_start_date ??
      monthly.value.account_start_date ??
      `${monthly.value.month}-01`
    const status =
      recordedSet.value.has(date)
        ? 'recorded'
        : date < periodStart
          ? 'before-start'
          : date > props.today
          ? 'future'
          : 'missing'
    cells.push({ key: date, day, date, status })
  }
  return cells
})
const recordProgress = computed(() =>
  monthly.value && monthly.value.elapsed_days > 0
    ? Math.min(100, (monthly.value.record_days / monthly.value.elapsed_days) * 100)
    : 0,
)
const recentDays = computed(() => {
  if (!monthly.value || monthly.value.elapsed_days <= 0 || monthly.value.is_before_start) {
    return []
  }
  const days = []
  const [year, month] = monthly.value.month.split('-').map(Number)
  const totalDays = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const elapsedDays = monthly.value.is_current
    ? Math.min(Number(props.today.slice(8, 10)), totalDays)
    : totalDays
  const startDay =
    monthly.value.account_start_date?.startsWith(monthly.value.month)
      ? Number(monthly.value.account_start_date.slice(8, 10))
      : 1
  const start = Math.max(startDay, elapsedDays - 6)
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  for (let day = start; day <= elapsedDays; day += 1) {
    const date = `${monthly.value.month}-${String(day).padStart(2, '0')}`
    days.push({
      date,
      day,
      weekday: weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()],
      status: recordedSet.value.has(date) ? 'recorded' : 'missing',
    })
  }
  return days
})
const recentWindowLabel = computed(() =>
  recentDays.value.length ? `最近 ${recentDays.value.length} 天` : '最近记录',
)
const recentRecordedCount = computed(
  () => recentDays.value.filter((item) => item.status === 'recorded').length,
)
const recordHint = computed(() => {
  if (!monthly.value) return ''
  if (!monthly.value.has_records) {
    return monthly.value.before_start_days > 0
      ? `账本自 ${monthly.value.account_start_date ?? '起始日'} 起算；本月可记 ${monthly.value.elapsed_days} 天，缺记 ${monthly.value.missing_days} 天，起始日前不纳入。`
      : `点下面任一天补记录；本月已过 ${monthly.value.elapsed_days} 天，缺记 ${monthly.value.missing_days} 天。`
  }
  if (monthly.value.provisional) {
    const maxEligibleDays =
      monthly.value.elapsed_days + monthly.value.days_remaining
    return monthly.value.before_start_days > 0 && maxEligibleDays < 28
      ? `自起始日起已记录 ${monthly.value.record_days}/${monthly.value.elapsed_days} 天，还差 ${monthly.value.missing_days} 天；起始月最多可记 ${maxEligibleDays} 天，不参与最终评级。`
      : `自起始日起已记录 ${monthly.value.record_days}/${monthly.value.elapsed_days} 天，还差 ${monthly.value.missing_days} 天；可记满 28 天且达到 20 条记录才会落最终评级。`
  }
  return `该月共记录 ${monthly.value.record_days} 天，覆盖 ${monthly.value.record_coverage_pct ?? 0}%；最终评级：${monthly.value.grade_display}。`
})
const gradeRequirementText = computed(() => {
  if (!monthly.value) return ''
  if (monthly.value.final) return '已达到最终评分条件'
  const maxEligibleDays =
    monthly.value.elapsed_days + monthly.value.days_remaining
  if (monthly.value.before_start_days > 0 && maxEligibleDays < 28) {
    return `起始月最多可记 ${maxEligibleDays} 天，不足 28 天，不落最终评级`
  }
  const parts: string[] = []
  if (monthly.value.days_needed_for_grade > 0) {
    parts.push(`还需 ${monthly.value.days_needed_for_grade} 天日历覆盖`)
  }
  if (monthly.value.records_needed_for_grade > 0) {
    parts.push(`还需 ${monthly.value.records_needed_for_grade} 条记录`)
  }
  return parts.length ? parts.join(' · ') : '样本条件已满足，等待月末结算'
})

const gradeConditions = computed(() => {
  if (!monthly.value) return []
  return [
    {
      label: '账本覆盖 ≥ 28 天',
      done: monthly.value.elapsed_days >= 28,
      value: `${monthly.value.elapsed_days}/28 天`,
    },
    {
      label: '有效记录 ≥ 20 条',
      done: monthly.value.record_days >= 20,
      value: `${monthly.value.record_days}/20 条`,
    },
    {
      label: '月份已结束',
      done: !monthly.value.is_current,
      value: monthly.value.is_current ? '进行中' : '已结束',
    },
    {
      label: '五问已保存',
      done: hasNote(monthly.value.month),
      value: hasNote(monthly.value.month) ? '已保存' : '待填写',
    },
  ]
})

const actionItems = computed(() => {
  if (!monthly.value) return []
  if (!monthly.value.has_records) {
    return monthly.value.before_start_days > 0
      ? ['先补今天', '从起始日起逐日记账', '起始日前不追补']
      : ['先补今天', '连续记满 7 天', '月末前至少 20 条']
  }
  if (monthly.value.provisional && monthly.value.missing_days > 0) {
    return [
      `补 ${monthly.value.missing_days} 天记录`,
      '核对交易流水与截图',
      '月底前保存五问',
    ]
  }
  return ['复核异常与偏离', '写当月结论', '定下月只改一件事']
})

function startRecord(date: string): void {
  if (!date) return
  emit('record', date)
}

function monthOptionLabel(item: MonthlyReview): string {
  return `${item.month_label} · ${item.grade_display}${hasNote(item.month) ? ' · 已复盘' : ''}`
}

function hasNote(month: string): boolean {
  return (props.notes ?? []).some((note) => note.month === month)
}

function selectMonth(month: string): void {
  selectedMonth.value = month
}
</script>

<template>
  <section class="review-section" aria-labelledby="reviewTitle">
    <div class="section-head">
      <div>
        <p class="kicker">自动复盘</p>
        <h2 id="reviewTitle">每天记一笔，每周查一次，每月给自己打分</h2>
      </div>
      <span class="review-auto-badge">自动计算</span>
    </div>

    <p v-if="accountStartDate" class="review-period-note">
      账本自 {{ accountStartDate }} 起算；起始日前的日期没有收益属于正常状态，不计缺记，也不能补记。
    </p>

    <div v-if="alerts.length" class="review-alerts" aria-label="复盘提醒">
      <span
        v-for="alert in alerts"
        :key="alert.code"
        class="review-alert"
        :class="`is-${alert.level}`"
      >
        {{ alert.text }}
      </span>
    </div>
    <div v-else-if="daily" class="review-alerts is-clear">
      <span class="review-alert is-ok">本周检查项暂无异常</span>
    </div>

    <div class="review-grid">
      <div class="review-side">
        <article class="panel review-card daily-review-card">
        <div class="review-card-head">
          <span>每日复盘</span>
          <span>{{ hasData && daily ? formatDateCN(daily.date) : '暂无记录' }}</span>
        </div>
        <div class="daily-review-main">
          <span>最新日收益</span>
          <strong :class="tone(daily?.daily_pnl)">
            {{ daily ? formatSignedMoney(daily.daily_pnl) : '待记录' }}
          </strong>
          <small>
            {{
              daily
                ? `当日收益率 ${formatPct(daily.daily_return_pct, 4, true)}`
                : '等待第一条记录'
            }}
          </small>
        </div>
        <div class="review-metrics">
          <div>
            <span>当日本金</span>
            <strong>{{ daily ? `¥${formatMoney(daily.principal, 0)}` : '待记录' }}</strong>
          </div>
          <div>
            <span>月累计</span>
            <strong :class="tone(daily?.month_pnl)">
              {{ daily ? formatSignedMoney(daily.month_pnl) : '待记录' }}
            </strong>
          </div>
          <div>
            <span>月收益率</span>
            <strong>{{ daily ? formatPct(daily.month_return_pct, 3, true) : '待记录' }}</strong>
          </div>
        </div>
        <div class="review-note-line">
          <span class="action-tag" :class="actionClass(daily?.action)">
            {{ daily?.action || '无操作' }}
          </span>
          <span class="review-note-text">{{ daily?.notes || '无备注' }}</span>
        </div>
        <div class="review-grade-line">
          <span>最新月评级</span>
          <strong class="grade-badge" :class="dailyGradeClass()">
            {{ daily?.month_grade || '待记录' }}
          </strong>
          <small>
            {{
              daily?.provisional
                ? `参考 ${daily.month_grade_preview || '—'} · 缺记 ${daily.month_missing_days} 天`
                : ''
            }}
          </small>
        </div>
        </article>

        <article class="panel review-card weekly-review-card">
          <div class="review-card-head">
            <span>每周检查</span>
            <span>
              {{
                weekly
                  ? `${formatDateShort(weekly.week_start)}–${formatDateShort(weekly.week_end)}`
                  : '本周暂无记录'
              }}
            </span>
          </div>
          <div class="daily-review-main weekly-review-main">
            <span>本周收益</span>
            <strong :class="tone(weekly?.pnl)">
              {{ weekly ? formatSignedMoney(weekly.pnl) : '待记录' }}
            </strong>
            <small>
              {{
                weekly
                  ? `本周收益率 ${formatPct(weekly.return_pct, 3, true)}`
                  : '先补今天的账，周检查才有依据'
              }}
            </small>
          </div>
          <div class="review-metrics">
            <div>
              <span>记录天数</span>
              <strong>{{ weekly ? `${weekly.record_days}/${weekly.elapsed_days}` : '0/0' }}</strong>
            </div>
            <div>
              <span>负收益天数</span>
              <strong>{{ weekly ? `${weekly.negative_days} 天` : '0 天' }}</strong>
            </div>
            <div>
              <span>操作次数</span>
              <strong>{{ weekly ? `${weekly.action_count} 次` : '0 次' }}</strong>
            </div>
          </div>
          <div class="review-grade-line weekly-streak-line">
            <span>连续负收益</span>
            <strong
              class="streak-badge"
              :class="{ 'is-warn': (weekly?.consecutive_negative_days ?? 0) >= 3 }"
            >
              {{ weekly ? `${weekly.consecutive_negative_days} 天` : '0 天' }}
            </strong>
            <small>
              {{
                (weekly?.consecutive_negative_days ?? 0) >= 3
                  ? '触发周检查'
                  : '按周复核即可'
              }}
            </small>
          </div>
        </article>

        <article class="panel review-card recent-review-card">
          <div class="review-card-head">
            <span>{{ recentWindowLabel }}</span>
            <span>
              {{ monthly?.month_label || '本月' }} · {{ recentRecordedCount }}/{{
                recentDays.length
              }}
              天
            </span>
          </div>
          <div v-if="recentDays.length" class="recent-day-list">
            <button
              v-for="item in recentDays"
              :key="item.date"
              type="button"
              class="recent-day-row"
              :class="`is-${item.status}`"
              :aria-label="`${item.date} ${item.status === 'recorded' ? '已记录，点击修改' : '缺记，点击补记'}`"
              @click="startRecord(item.date)"
            >
              <span class="recent-day-date">
                {{ item.day }} 日
                <small>周{{ item.weekday }}</small>
              </span>
              <span class="recent-day-status">
                {{ item.status === 'recorded' ? '已记录' : '缺记' }}
              </span>
              <em class="recent-day-dot"></em>
            </button>
          </div>
          <div v-else class="recent-day-empty">本月还没有可显示的日期。</div>
          <div class="recent-day-foot">
            <span>点任意一天直接补记或修改</span>
            <button type="button" @click="startRecord(today)">补今天</button>
          </div>
        </article>
      </div>

      <article class="panel review-card monthly-review-card">
        <div class="review-card-head">
          <span>月度评分与记录</span>
          <select
            v-model="selectedMonth"
            class="review-month-select"
            aria-label="选择复盘月份"
            :disabled="history.length === 0"
          >
            <option v-if="history.length === 0" value="">暂无记录</option>
            <option v-for="item in history" :key="item.month" :value="item.month">
              {{ monthOptionLabel(item) }}
            </option>
          </select>
        </div>
        <div class="monthly-review-layout">
          <div class="monthly-review-summary">
            <div class="monthly-score-main">
              <div>
                <span>月收益率</span>
                <strong :class="tone(monthly?.return_pct)">
                  {{
                    monthly
                      ? monthly.has_records
                        ? formatPct(monthly.return_pct, 3, true)
                        : '待记录'
                      : '—'
                  }}
                </strong>
              </div>
              <div class="monthly-grade-block">
                <strong class="grade-badge monthly-grade" :class="gradeClass(monthly?.grade)">
                  {{ monthly?.grade_display || '—' }}
                </strong>
                <small v-if="monthly?.provisional" class="grade-preview-note">
                  参考 {{ monthly.grade_preview || '—' }}
                </small>
              </div>
            </div>
            <p class="review-next">
              {{ monthlyMessage(monthly) }}
            </p>
            <div class="review-metrics">
              <div>
                <span>月收益</span>
                <strong>{{ monthly ? formatSignedMoney(monthly.pnl) : '—' }}</strong>
              </div>
              <div>
                <span>月均本金</span>
                <strong>{{ monthly ? `¥${formatMoney(monthly.avg_principal, 0)}` : '—' }}</strong>
              </div>
              <div>
                <span>记录完整度</span>
                <strong>
                  {{ monthly ? `${monthly.record_days}/${monthly.elapsed_days} 天` : '—' }}
                </strong>
                <small v-if="monthly">
                  缺记 {{ monthly.missing_days }} 天
                </small>
              </div>
              <div>
                <span>年化参考</span>
                <strong>
                  {{
                    monthly && monthly.has_records
                      ? formatPct(monthly.annualized_pct, 2, true)
                      : '待记录'
                  }}
                </strong>
                <small>{{
                  monthly?.sample_sufficient ? '按记录期复利' : '满 20 条后参考'
                }}</small>
              </div>
              <div>
                <span>最大回撤</span>
                <strong class="negative">
                  {{ monthly ? formatPct(monthly.max_drawdown_pct, 3) : '—' }}
                </strong>
              </div>
              <div>
                <span>负收益天数占比</span>
                <strong>{{ monthly ? formatPct(monthly.negative_day_ratio_pct, 1) : '—' }}</strong>
              </div>
              <div>
                <span>最好单日</span>
                <strong class="positive">
                  {{ monthly ? formatSignedMoney(monthly.best_day) : '—' }}
                </strong>
              </div>
              <div>
                <span>最差单日</span>
                <strong class="negative">
                  {{ monthly ? formatSignedMoney(monthly.worst_day) : '—' }}
                </strong>
              </div>
              <div>
                <span>目标缺口</span>
                <strong :class="deltaClass(monthly?.target_gap_pct)">
                  {{
                    monthly?.target_gap_pct !== null && monthly?.target_gap_pct !== undefined
                      ? formatPp(monthly.target_gap_pct, 2, true)
                      : '待计算'
                  }}
                </strong>
              </div>
            </div>

            <div v-if="monthly" class="target-progress">
              <div class="target-progress-head">
                <span>{{ monthly.provisional ? '本月目标进度' : '月度目标进度' }}</span>
                <strong :class="tone((monthly.target_progress_pct ?? 0) - 100)">
                  {{
                    monthly.has_records
                      ? formatPct(monthly.target_progress_pct, 1)
                      : '待记录'
                  }}
                </strong>
              </div>
              <div
                class="target-progress-track"
                role="progressbar"
                :aria-valuenow="monthly.target_progress_pct ?? 0"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <span :style="{ width: progressWidth(monthly.target_progress_pct) }"></span>
              </div>
              <p>
                <template v-if="monthly.has_records">
                  按天折算目标 {{ formatPct(monthly.target_mtd_pct, 3) }}，当前
                  {{ formatPct(monthly.return_pct, 3, true) }}；
                  <template v-if="monthly.provisional">
                    按当前速度月底约 {{ formatPct(monthly.projected_pct, 3, true) }}
                  </template>
                  <template v-else>
                    整月目标 {{ formatPct(monthly.target_month_pct, 3) }}
                  </template>
                </template>
                <template v-else>
                  本月按天折算目标 {{ formatPct(monthly.target_mtd_pct, 3) }}；记录第一笔收益后开始计算进度。
                </template>
              </p>
            </div>

            <div v-if="monthly?.compare" class="review-compare">
              <div class="review-compare-head">
                <span>环比 {{ monthly.compare.prev_month_label }}</span>
                <small>{{ monthly.provisional ? '月中对比全月，仅参考' : '' }}</small>
              </div>
              <div class="review-compare-grid">
                <span>
                  收益
                  <strong :class="deltaClass(monthly.compare.pnl_delta)">
                    {{ formatSignedMoney(monthly.compare.pnl_delta) }}
                  </strong>
                </span>
                <span>
                  收益率
                  <strong :class="deltaClass(monthly.compare.return_delta_pp)">
                    {{ formatPp(monthly.compare.return_delta_pp, 3, true) }}
                  </strong>
                </span>
                <span>
                  回撤
                  <strong :class="deltaClass(monthly.compare.drawdown_delta_pp, true)">
                    {{ formatPp(monthly.compare.drawdown_delta_pp, 3, true) }}
                  </strong>
                </span>
                <span>
                  负日占比
                  <strong :class="deltaClass(monthly.compare.negative_ratio_delta_pp, true)">
                    {{ formatPp(monthly.compare.negative_ratio_delta_pp, 1, true) }}
                  </strong>
                </span>
                <span>
                  操作
                  <strong :class="deltaClass(monthly.compare.action_delta)">
                    {{ formatSignedCount(monthly.compare.action_delta) }}
                  </strong>
                </span>
              </div>
            </div>
            <p v-else-if="monthly" class="review-compare-empty">
              {{ monthly.has_records ? '暂无可比月份。' : '记录第一笔收益后生成环比。' }}
            </p>

            <div v-if="selectedNote" class="review-conclusion">
              <div class="review-conclusion-head">
                <span>当月结论</span>
                <small>{{ selectedNote.updated_at.slice(0, 10) }}</small>
              </div>
              <p>{{ selectedNote.conclusion || '已填写五问，尚未写结论。' }}</p>
              <p class="review-one-change">
                <em>下月只改一件事</em>
                {{ selectedNote.answers[4] || '未填写' }}
              </p>
            </div>
            <div class="grade-steps" aria-label="月度评分标准">
              <span :class="{ 'is-current': highlightGrade === '不及格' }">
                不及格
                <small>&lt;{{ gradeScale[0]?.min.toFixed(2) }}%</small>
              </span>
              <span
                v-for="step in gradeScale"
                :key="step.grade"
                :class="{ 'is-current': highlightGrade === step.grade }"
              >
                {{ step.grade }}
                <small>{{ step.min.toFixed(2) }}%</small>
              </span>
            </div>

            <div v-if="monthly" class="monthly-record-panel">
              <div class="monthly-record-head">
                <div>
                  <strong>本月记录日历</strong>
                  <span>{{ monthly.record_days }}/{{ monthly.elapsed_days }} 天已记录</span>
                </div>
                <button
                  class="monthly-record-cta"
                  type="button"
                  @click="startRecord(today)"
                >
                  补今天
                </button>
              </div>
              <div class="monthly-record-progress" aria-hidden="true">
                <span :style="{ width: `${recordProgress}%` }"></span>
              </div>
              <p class="monthly-record-hint">{{ recordHint }}</p>
              <div class="record-calendar" aria-label="每日记录状态">
                <span
                  v-for="weekday in ['一', '二', '三', '四', '五', '六', '日']"
                  :key="weekday"
                  class="record-weekday"
                >
                  {{ weekday }}
                </span>
                <button
                  v-for="cell in calendarCells"
                  :key="cell.key"
                  type="button"
                  class="record-day"
                  :class="`is-${cell.status}`"
                  :disabled="
                    cell.status === 'outside' ||
                    cell.status === 'future' ||
                    cell.status === 'before-start'
                  "
                  :aria-label="
                    cell.status === 'outside'
                      ? ''
                      : `${cell.date} ${
                          cell.status === 'recorded'
                            ? '已记录'
                            : cell.status === 'missing'
                              ? '缺记'
                              : cell.status === 'before-start'
                                ? '本金起始日前，未纳入账本'
                              : '未到'
                        }`
                  "
                  @click="startRecord(cell.date)"
                >
                  {{ cell.day || '' }}
                </button>
              </div>
              <div class="monthly-record-foot">
                <span class="record-legend">
                  <em class="is-recorded"></em>已记录
                  <em class="is-missing"></em>缺记
                  <em class="is-before-start"></em>起始日前
                  <em class="is-future"></em>未到
                </span>
                <span>{{ gradeRequirementText }}</span>
              </div>
            </div>
          </div>
          <div class="monthly-review-history">
            <div class="monthly-history-head">
              <span>历史月份</span>
              <span>{{ history.length }} 个月</span>
            </div>
            <div class="review-history-list">
              <div
                v-for="item in history"
                :key="item.month"
                class="review-history-row"
                :class="{
                  'is-current': item.is_current,
                  'is-selected': monthly?.month === item.month,
                }"
                role="button"
                tabindex="0"
                @click="selectMonth(item.month)"
                @keydown.enter.prevent="selectMonth(item.month)"
                @keydown.space.prevent="selectMonth(item.month)"
              >
                <div class="review-history-main">
                  <strong>{{ item.month_label }}</strong>
                  <span>
                    {{ item.record_days }}/{{ item.elapsed_days }} 天 · 月均 ¥{{
                      formatMoney(item.avg_principal)
                    }}
                    <em v-if="hasNote(item.month)" class="review-note-flag">已复盘</em>
                  </span>
                </div>
                <div class="review-history-value">
                  <strong>{{ formatSignedMoney(item.pnl) }}</strong>
                  <span>{{
                    item.has_records ? formatPct(item.return_pct, 3, true) : '待记录'
                  }}</span>
                </div>
                <span class="grade-badge" :class="gradeClass(item.grade)">
                  {{ item.grade_display }}
                </span>
              </div>
            </div>
            <div v-if="history.length === 0" class="review-empty">
              还没有月度数据。
            </div>
            <div v-if="monthly" class="history-action-card">
              <div class="history-action-head">
                <strong>本月先做这几件事</strong>
                <span>{{ monthly.month_label }}</span>
              </div>
              <ol>
                <li v-for="item in actionItems" :key="item">{{ item }}</li>
              </ol>
              <div class="grade-condition-list">
                <div v-for="condition in gradeConditions" :key="condition.label">
                  <span class="condition-dot" :class="{ 'is-done': condition.done }"></span>
                  <span>{{ condition.label }}</span>
                  <strong>{{ condition.value }}</strong>
                </div>
              </div>
            </div>
          </div>
        </div>
      </article>
    </div>

    <p class="review-footnote">
      评分口径：月收益 ÷ 月均本金，0.16% 及格、0.20% 良好、0.25% 优秀、0.30%
      卓越。当前月份只显示进度和参考区间，月末且满 28 天、20 条记录后才落最终评级；年化、回撤和环比只用于个人复盘，不代表未来收益。
    </p>
  </section>
</template>

<style scoped>
.review-section .kicker,
.review-section .streak-badge,
.review-section .target-progress-head span,
.review-section .target-progress-head strong,
.review-section .grade-steps small {
  font-size: 12px !important;
}

.review-period-note {
  margin: 12px 0 0;
  padding: 8px 11px;
  border: 1px dashed rgba(23, 100, 86, 0.2);
  border-radius: 9px;
  background: rgba(239, 247, 242, 0.55);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}

.review-history-row {
  cursor: pointer;
}

.review-side {
  display: flex;
  flex-direction: column;
}

.review-side > .review-card {
  flex: 0 0 auto;
}

.recent-review-card {
  flex: 1 1 auto;
  display: flex;
  min-height: 250px;
  flex-direction: column;
}

.review-side > .recent-review-card {
  flex: 1 1 auto;
}

.recent-day-list {
  display: grid;
  flex: 1;
  gap: 5px;
  margin-top: 14px;
  grid-auto-rows: minmax(36px, 1fr);
  align-content: stretch;
}

.recent-day-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 8px;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--card);
  color: var(--ink-soft);
  cursor: pointer;
  text-align: left;
}

.recent-day-row:hover {
  border-color: rgba(23, 100, 86, 0.3);
}

.recent-day-row.is-missing {
  border-color: rgba(161, 77, 64, 0.16);
  background: #fdf6f3;
}

.recent-day-date {
  font-family: var(--mono);
  font-size: 12.5px;
}

.recent-day-date small {
  margin-left: 5px;
  color: var(--muted-light);
  font-size: 12px !important;
}

.recent-day-status {
  color: var(--green);
  font-size: 12px;
  font-weight: 650;
}

.recent-day-row.is-missing .recent-day-status {
  color: #a14d40;
}

.recent-day-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--green);
}

.recent-day-row.is-missing .recent-day-dot {
  background: #c98a7d;
}

.recent-day-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px dashed var(--line);
  color: var(--muted);
  font-size: 12px;
}

.recent-day-foot button {
  flex: 0 0 auto;
  padding: 4px 9px;
  border: 1px solid rgba(23, 100, 86, 0.22);
  border-radius: 999px;
  background: var(--green-wash);
  color: var(--green);
  cursor: pointer;
  font-size: 12px;
  font-weight: 650;
}

.recent-day-empty {
  flex: 1;
  padding: 18px 0;
  color: var(--muted);
  font-size: 12px;
}

.monthly-record-panel {
  margin-top: 16px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--card-soft);
}

.monthly-record-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.monthly-record-head > div {
  display: grid;
  gap: 4px;
}

.monthly-record-head strong {
  color: var(--ink-soft);
  font-size: 13px;
}

.monthly-record-head span {
  color: var(--muted-light);
  font-family: var(--mono);
  font-size: 12px;
}

.monthly-record-cta {
  flex: 0 0 auto;
  padding: 6px 11px;
  border: 1px solid rgba(23, 100, 86, 0.24);
  border-radius: 999px;
  background: var(--green-wash);
  color: var(--green);
  cursor: pointer;
  font-size: 12px;
  font-weight: 650;
}

.monthly-record-progress {
  height: 5px;
  margin-top: 10px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(23, 100, 86, 0.1);
}

.monthly-record-progress span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--green);
  transition: width 180ms ease;
}

.monthly-record-hint {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}

.record-calendar {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 4px;
  margin-top: 12px;
}

.record-weekday {
  padding: 2px 0;
  color: var(--muted-light);
  font-size: 12px;
  text-align: center;
}

.record-day {
  min-height: 32px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-family: var(--mono);
  font-size: 12px;
}

.record-day.is-recorded {
  border-color: rgba(23, 100, 86, 0.18);
  background: var(--green-soft);
  color: var(--green);
  font-weight: 700;
}

.record-day.is-missing {
  border-color: rgba(161, 77, 64, 0.18);
  background: #fbf0ed;
  color: #a14d40;
}

.record-day.is-missing:hover {
  border-color: rgba(161, 77, 64, 0.42);
  background: #f7e5e1;
}

.record-day.is-future,
.record-day.is-outside,
.record-day.is-before-start {
  color: var(--muted-light);
  cursor: default;
  opacity: 0.4;
}

.record-day.is-before-start {
  border-color: rgba(139, 149, 142, 0.14);
  border-style: dashed;
  background: rgba(139, 149, 142, 0.04);
  opacity: 0.72;
}

.monthly-record-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
  color: var(--muted-light);
  font-size: 12px;
  line-height: 1.5;
}

.record-legend {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.record-legend em {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-left: 4px;
  border-radius: 2px;
}

.record-legend em.is-recorded {
  background: var(--green-soft);
}

.record-legend em.is-missing {
  background: #fbf0ed;
}

.record-legend em.is-future {
  background: var(--line);
}

.record-legend em.is-before-start {
  border: 1px dashed rgba(139, 149, 142, 0.4);
  background: transparent;
}

.history-action-card {
  margin-top: 14px;
  padding: 13px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: var(--card-soft);
}

.history-action-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.history-action-head strong {
  color: var(--ink-soft);
  font-size: 13px;
}

.history-action-head span {
  color: var(--muted-light);
  font-family: var(--mono);
  font-size: 12px;
}

.history-action-card ol {
  display: grid;
  gap: 6px;
  margin: 10px 0 0;
  padding-left: 17px;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.55;
}

.grade-condition-list {
  display: grid;
  gap: 6px;
  margin-top: 12px;
  padding-top: 11px;
  border-top: 1px dashed var(--line);
}

.grade-condition-list > div {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  font-size: 12px;
}

.grade-condition-list strong {
  color: var(--muted-light);
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 500;
}

.condition-dot {
  width: 7px;
  height: 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
}

.condition-dot.is-done {
  border-color: var(--green);
  background: var(--green);
}

@media (max-width: 720px) {
  .monthly-record-foot {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 1080px) and (min-width: 621px) {
  .review-side {
    flex-direction: row;
    flex-wrap: wrap;
  }

  .review-side > .review-card {
    flex: 1 1 calc(50% - 7px);
  }

  .recent-review-card {
    flex-basis: 100%;
  }
}

@media (max-width: 620px) {
  .recent-review-card {
    min-height: 0;
  }
}
</style>
