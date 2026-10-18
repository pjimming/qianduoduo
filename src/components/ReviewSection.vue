<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MonthlyReview, ReviewData } from '@/types/dashboard'
import {
  formatDateCN,
  formatMoney,
  formatPct,
  formatSignedMoney,
} from '@/composables/useFormatters'

const props = defineProps<{
  review: ReviewData
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
const monthly = computed<MonthlyReview | null>(() => {
  if (selectedMonth.value) {
    return history.value.find((item) => item.month === selectedMonth.value) ?? null
  }
  return props.review.current_month ?? history.value[0] ?? null
})
const hasData = computed(() => Boolean(daily.value && monthly.value))

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

function nextGradeMessage(returnPct: number | null): string {
  if (returnPct === null || !Number.isFinite(returnPct)) {
    return '还没有足够的月度数据。'
  }
  const levels: Array<[number, string]> = [
    [0.16, '及格'],
    [0.20, '良好'],
    [0.25, '优秀'],
    [0.30, '卓越'],
  ]
  for (const [threshold, grade] of levels) {
    if (returnPct < threshold) {
      return `距${grade}档还差 ${(threshold - returnPct).toFixed(3)} 个百分点`
    }
  }
  return '已达到最高档，继续保持节奏。'
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
        <h2 id="reviewTitle">每天看一眼，每月给自己打分</h2>
      </div>
      <span class="review-auto-badge">自动计算</span>
    </div>

    <div class="review-grid">
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
            <strong>{{ daily ? `¥${formatMoney(daily.principal)}` : '—' }}</strong>
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
        <div class="review-grade-line">
          <span>本月当前评级</span>
          <strong class="grade-badge" :class="gradeClass(daily?.month_grade)">
            {{ daily?.month_grade || '—' }}
          </strong>
          <small>{{ daily?.provisional ? '月中参考' : '' }}</small>
        </div>
      </article>

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
              {{ item.month_label }} · {{ item.grade }}{{ item.provisional ? '（月中）' : '' }}
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
              <strong class="grade-badge monthly-grade" :class="gradeClass(monthly?.grade)">
                {{ monthly?.grade || '—' }}
              </strong>
            </div>
            <p class="review-next">
              {{
                monthly
                  ? nextGradeMessage(monthly.return_pct)
                  : '记录收益后自动生成月度评分。'
              }}
            </p>
            <div class="review-metrics">
              <div>
                <span>月收益</span>
                <strong>{{ monthly ? formatSignedMoney(monthly.pnl) : '—' }}</strong>
              </div>
              <div>
                <span>月均本金</span>
                <strong>{{ monthly ? `¥${formatMoney(monthly.avg_principal)}` : '—' }}</strong>
              </div>
              <div>
                <span>记录天数</span>
                <strong>{{ monthly ? `${monthly.record_days} 天` : '—' }}</strong>
              </div>
            </div>
            <div class="grade-steps" aria-label="月度评分标准">
              <span
                v-for="step in ['不及格', '及格', '良好', '优秀', '卓越']"
                :key="step"
                :class="{ 'is-current': monthly?.grade === step }"
              >
                {{ step }}
                <small>
                  {{
                    step === '不及格'
                      ? '<0.16%'
                      : step === '及格'
                        ? '0.16%'
                        : step === '良好'
                          ? '0.20%'
                          : step === '优秀'
                            ? '0.25%'
                            : '0.30%'
                  }}
                </small>
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
                  <span>{{ item.record_days }} 天 · 月均 ¥{{ formatMoney(item.avg_principal) }}</span>
                </div>
                <div class="review-history-value">
                  <strong>{{ formatSignedMoney(item.pnl) }}</strong>
                  <span>{{ formatPct(item.return_pct, 3, true) }}</span>
                </div>
                <span class="grade-badge" :class="gradeClass(item.grade)">
                  {{ item.grade }}
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
      评分口径：月收益 ÷ 月均本金。当前月份标记为“月中参考”；评分只用于个人复盘，不代表未来收益。
    </p>
  </section>
</template>

<style scoped>
.review-history-row {
  cursor: pointer;
}
</style>
