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
const hasData = computed(() => Boolean(daily.value && monthly.value))
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
    return `样本不足：仅 ${item.record_days} 条记录、覆盖 ${item.calendar_days} 天，不参与评级。`
  }
  return nextGradeMessage(item.return_pct)
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
            {{ daily ? formatSignedMoney(daily.daily_pnl) : '—' }}
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
            <strong>{{ daily ? `¥${formatMoney(daily.principal, 0)}` : '—' }}</strong>
          </div>
          <div>
            <span>月累计</span>
            <strong :class="tone(daily?.month_pnl)">
              {{ daily ? formatSignedMoney(daily.month_pnl) : '—' }}
            </strong>
          </div>
          <div>
            <span>月收益率</span>
            <strong>{{ daily ? formatPct(daily.month_return_pct, 3, true) : '—' }}</strong>
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
            {{ daily?.month_grade || '—' }}
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
              {{ weekly ? formatSignedMoney(weekly.pnl) : '—' }}
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
              <strong>{{ weekly ? `${weekly.record_days}/${weekly.elapsed_days}` : '—' }}</strong>
            </div>
            <div>
              <span>负收益天数</span>
              <strong>{{ weekly ? `${weekly.negative_days} 天` : '—' }}</strong>
            </div>
            <div>
              <span>操作次数</span>
              <strong>{{ weekly ? `${weekly.action_count} 次` : '—' }}</strong>
            </div>
          </div>
          <div class="review-grade-line weekly-streak-line">
            <span>连续负收益</span>
            <strong
              class="streak-badge"
              :class="{ 'is-warn': (weekly?.consecutive_negative_days ?? 0) >= 3 }"
            >
              {{ weekly ? `${weekly.consecutive_negative_days} 天` : '—' }}
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
                  {{ monthly ? formatPct(monthly.return_pct, 3, true) : '—' }}
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
                <strong>{{ monthly ? formatPct(monthly.annualized_pct, 2, true) : '—' }}</strong>
                <small>{{ monthly?.sample_sufficient ? '按记录期复利' : '短样本仅参考' }}</small>
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
                  {{ monthly ? formatPp(monthly.target_gap_pct, 2, true) : '—' }}
                </strong>
              </div>
            </div>

            <div v-if="monthly" class="target-progress">
              <div class="target-progress-head">
                <span>{{ monthly.provisional ? '本月目标进度' : '月度目标进度' }}</span>
                <strong :class="tone((monthly.target_progress_pct ?? 0) - 100)">
                  {{ formatPct(monthly.target_progress_pct, 1) }}
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
                按天折算目标 {{ formatPct(monthly.target_mtd_pct, 3) }}，当前
                {{ formatPct(monthly.return_pct, 3, true) }}；
                <template v-if="monthly.provisional">
                  按当前速度月底约 {{ formatPct(monthly.projected_pct, 3, true) }}
                </template>
                <template v-else>
                  整月目标 {{ formatPct(monthly.target_month_pct, 3) }}
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
            <p v-else-if="monthly" class="review-compare-empty">首月记录，暂无环比。</p>

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
            <p v-else-if="monthly" class="review-conclusion is-empty">
              这个月还没有五问结论，可以在下方复盘工作台补上。
            </p>

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
                    {{ item.record_days }} 天 · 月均 ¥{{ formatMoney(item.avg_principal) }}
                    <em v-if="hasNote(item.month)" class="review-note-flag">已复盘</em>
                  </span>
                </div>
                <div class="review-history-value">
                  <strong>{{ formatSignedMoney(item.pnl) }}</strong>
                  <span>{{ formatPct(item.return_pct, 3, true) }}</span>
                </div>
                <span class="grade-badge" :class="gradeClass(item.grade)">
                  {{ item.grade_display }}
                </span>
              </div>
            </div>
            <div v-if="history.length === 0" class="review-empty">
              还没有月度数据。
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
.review-history-row {
  cursor: pointer;
}
</style>
