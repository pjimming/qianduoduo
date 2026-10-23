<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { formatMoney, formatPct } from '@/composables/useFormatters'
import type {
  DecisionCalibrationGroup,
  DecisionCalibrationRecord,
  DecisionCalibrationReport,
} from '@/types/dashboard'

const props = defineProps<{
  report: DecisionCalibrationReport
}>()

const store = useDashboardStore()
const current = ref<DecisionCalibrationReport>(props.report)
const month = ref(props.report.month)
const loading = ref(false)
const error = ref('')
const confirming = ref('')

watch(
  () => props.report,
  (value) => {
    current.value = value
    if (!loading.value) month.value = value.month
  },
)

const totals = computed(() => {
  const groups = current.value.by_type
  return groups.reduce(
    (sum, item) => ({
      total: sum.total + item.total,
      evaluated: sum.evaluated + item.evaluated,
      hit: sum.hit + item.hit,
      miss: sum.miss + item.miss,
      invalidated: sum.invalidated + item.invalidated,
      insufficient: sum.insufficient + item.insufficient_data,
      pending:
        sum.pending +
        item.pending +
        item.pending_confirmation +
        item.not_executed,
    }),
    {
      total: 0,
      evaluated: 0,
      hit: 0,
      miss: 0,
      invalidated: 0,
      insufficient: 0,
      pending: 0,
    },
  )
})

const hitRate = computed(() =>
  totals.value.evaluated
    ? (totals.value.hit / totals.value.evaluated) * 100
    : null,
)

const typeLabels: Record<string, string> = {
  cash_allocation: '资金配置',
  holding_switch: '持仓切换',
  manual_prediction: '人工补充',
}

const confidenceLabels: Record<string, string> = {
  high: '高置信度 ≥75%',
  medium: '中置信度 50–74%',
  low: '低置信度 <50%',
  unknown: '置信度未知',
}

const actionLabels: Record<string, string> = {
  买入: '买入',
  赎回: '赎回',
  切换: '切换',
  观察: '观察',
}

const statusLabels: Record<string, string> = {
  hit: '命中',
  miss: '未命中',
  invalidated: '已失效',
  not_executed: '未执行',
  insufficient_data: '待验证',
  pending_confirmation: '待人工确认',
  pending: '未到期',
}

function groupLabel(group: DecisionCalibrationGroup, confidence = false): string {
  return confidence
    ? confidenceLabels[group.key] || group.key
    : typeLabels[group.key] || group.key
}

function actionLabel(group: DecisionCalibrationGroup): string {
  return actionLabels[group.key] || group.key
}

function statusLabel(record: DecisionCalibrationRecord): string {
  return statusLabels[record.result.status] || record.result.status
}

function statusClass(record: DecisionCalibrationRecord): string {
  return `is-${record.result.status.replaceAll('_', '-')}`
}

function formatValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return '—'
  }
  return unit === '元' ? `¥${formatMoney(value, 2)}` : formatPct(value, 2)
}

function targetLabel(record: DecisionCalibrationRecord): string {
  const target = record.prediction.expected.target
  if (target.min !== null && target.max !== null) {
    return `${formatValue(target.min, target.unit)}–${formatValue(target.max, target.unit)}`
  }
  return formatValue(target.point, target.unit)
}

function actualLabel(record: DecisionCalibrationRecord): string {
  return formatValue(
    record.result.actual,
    record.prediction.expected.target.unit,
  )
}

function recordTitle(record: DecisionCalibrationRecord): string {
  return (
    record.decision?.product_name ||
    record.proposal?.title ||
    record.prediction.original_text ||
    record.prediction.id
  )
}

async function loadMonth(): Promise<void> {
  if (!/^\d{4}-\d{2}$/.test(month.value)) {
    error.value = '月份格式应为 YYYY-MM'
    return
  }
  loading.value = true
  error.value = ''
  try {
    current.value = await store.loadCalibration(month.value)
  } catch (loadError) {
    error.value = loadError instanceof Error ? loadError.message : '加载校准失败'
  } finally {
    loading.value = false
  }
}

async function confirmResult(
  record: DecisionCalibrationRecord,
  status: 'hit' | 'miss',
): Promise<void> {
  confirming.value = record.prediction.id
  error.value = ''
  try {
    await store.confirmCalibrationPrediction(
      record.prediction.id,
      status,
      '页面人工确认',
    )
    current.value = await store.loadCalibration(current.value.month)
  } catch (confirmError) {
    error.value =
      confirmError instanceof Error ? confirmError.message : '确认失败'
  } finally {
    confirming.value = ''
  }
}
</script>

<template>
  <div class="rw-panel-body calibration-panel">
    <div class="calibration-toolbar">
      <div>
        <strong>预测校准</strong>
        <p>按复核月份统计平台建议；待验证、失效和未执行不计入命中率。</p>
      </div>
      <form class="calibration-month" @submit.prevent="loadMonth">
        <label>
          <span>复核月份</span>
          <input v-model="month" type="month" />
        </label>
        <button class="rw-button is-secondary" type="submit" :disabled="loading">
          {{ loading ? '加载中…' : '查看' }}
        </button>
      </form>
    </div>

    <p v-if="error" class="calibration-error" role="alert">{{ error }}</p>

    <div class="calibration-kpis">
      <span><em>预测</em><strong>{{ totals.total }}</strong></span>
      <span><em>已完成</em><strong>{{ totals.evaluated }}</strong></span>
      <span><em>命中率</em><strong>{{ formatPct(hitRate, 1) }}</strong></span>
      <span><em>待验证</em><strong>{{ totals.insufficient + totals.pending }}</strong></span>
      <span><em>已失效</em><strong>{{ totals.invalidated }}</strong></span>
    </div>

    <div v-if="current.total === 0" class="rw-empty">
      {{ current.month }} 没有到复核日的结构化预测。
    </div>

    <template v-else>
      <div class="calibration-tables">
        <div class="calibration-table-block">
          <h4>按类型</h4>
          <table class="rw-table">
            <thead>
              <tr>
                <th>类型</th>
                <th>预测</th>
                <th>已完成</th>
                <th>命中率</th>
                <th>平均误差</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="group in current.by_type" :key="group.key">
                <td>{{ groupLabel(group) }}</td>
                <td>{{ group.total }}</td>
                <td>{{ group.evaluated }}</td>
                <td>{{ formatPct(group.hit_rate === null ? null : group.hit_rate * 100, 1) }}</td>
                <td>{{ group.mean_absolute_error === null ? '—' : group.mean_absolute_error.toFixed(2) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="calibration-table-block">
          <h4>按动作</h4>
          <table class="rw-table">
            <thead>
              <tr>
                <th>动作</th>
                <th>预测</th>
                <th>已完成</th>
                <th>命中率</th>
                <th>失效</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="group in current.by_action" :key="group.key">
                <td>{{ actionLabel(group) }}</td>
                <td>{{ group.total }}</td>
                <td>{{ group.evaluated }}</td>
                <td>{{ formatPct(group.hit_rate === null ? null : group.hit_rate * 100, 1) }}</td>
                <td>{{ group.invalidated }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="calibration-table-block">
          <h4>按期限</h4>
          <table class="rw-table">
            <thead>
              <tr>
                <th>期限桶</th>
                <th>预测</th>
                <th>待验证</th>
                <th>命中率</th>
                <th>平均误差</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="group in current.by_horizon" :key="group.key">
                <td>{{ group.key }}</td>
                <td>{{ group.total }}</td>
                <td>{{ group.insufficient_data + group.pending }}</td>
                <td>{{ formatPct(group.hit_rate === null ? null : group.hit_rate * 100, 1) }}</td>
                <td>{{ group.mean_absolute_error === null ? '—' : group.mean_absolute_error.toFixed(2) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="calibration-table-block">
          <h4>按置信度</h4>
          <table class="rw-table">
            <thead>
              <tr>
                <th>区间</th>
                <th>预测</th>
                <th>命中</th>
                <th>未命中</th>
                <th>命中率</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="group in current.by_confidence" :key="group.key">
                <td>{{ groupLabel(group, true) }}</td>
                <td>{{ group.total }}</td>
                <td>{{ group.hit }}</td>
                <td>{{ group.miss }}</td>
                <td>{{ formatPct(group.hit_rate === null ? null : group.hit_rate * 100, 1) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="calibration-records">
        <div class="calibration-errors">
          <h4>误差来源</h4>
          <div>
            <span v-for="item in current.error_sources" :key="item.source">
              {{ item.source }} <strong>{{ item.count }}</strong>
            </span>
          </div>
        </div>
        <article
          v-for="record in current.records"
          :key="record.prediction.id"
          class="calibration-record"
        >
          <details>
            <summary>
              <span class="calibration-title">{{ recordTitle(record) }}</span>
              <span class="calibration-status" :class="statusClass(record)">
                {{ statusLabel(record) }}
              </span>
              <span>{{ record.prediction.review_date }}</span>
              <span>置信度 {{ record.prediction.confidence }}%</span>
              <span>目标 {{ targetLabel(record) }}</span>
              <span>实际 {{ actualLabel(record) }}</span>
            </summary>
            <div class="calibration-detail">
              <p><em>口径</em>{{ record.prediction.evaluation.metric }}</p>
              <p>
                <em>版本</em>v{{ record.prediction.version }} / 共
                {{ record.prediction_versions.length }} 版
              </p>
              <p><em>来源</em>{{ record.prediction.source }} · {{ record.prediction.created_at }}</p>
              <p><em>数据截止</em>{{ record.prediction.data_cutoff_at }}</p>
              <p><em>判断</em>{{ record.result.detail || record.result.reason_code }}</p>
              <p><em>基线</em>{{ formatValue(record.prediction.baseline.value, record.prediction.baseline.unit) }}</p>
              <p><em>失效条件</em>{{ record.prediction.invalidation_condition }}</p>
              <p><em>预测原文</em>{{ record.prediction.original_text }}</p>
              <div class="calibration-versions">
                <span
                  v-for="version in record.prediction_versions"
                  :key="version.id"
                >
                  v{{ version.version }} · {{ version.created_at }} ·
                  置信度 {{ version.confidence }}% · 目标
                  {{ formatValue(version.expected.target.point, version.expected.target.unit) }}
                </span>
              </div>
              <div
                v-if="record.result.status === 'pending_confirmation'"
                class="calibration-confirm"
              >
                <span>低置信度结果需要人工确认</span>
                <button
                  class="rw-button is-secondary"
                  type="button"
                  :disabled="confirming === record.prediction.id"
                  @click="confirmResult(record, 'hit')"
                >
                  确认命中
                </button>
                <button
                  class="rw-button is-secondary"
                  type="button"
                  :disabled="confirming === record.prediction.id"
                  @click="confirmResult(record, 'miss')"
                >
                  确认未命中
                </button>
              </div>
              <pre>{{ JSON.stringify(record.result.evidence, null, 2) }}</pre>
            </div>
          </details>
        </article>
      </div>
    </template>
  </div>
</template>

<style scoped>
.calibration-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.calibration-toolbar p {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 12px;
}

.calibration-month {
  display: flex;
  align-items: end;
  gap: 8px;
}

.calibration-month label {
  display: grid;
  gap: 4px;
  color: var(--muted);
  font-size: 12px;
}

.calibration-month input {
  min-height: 34px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 12px;
}

.calibration-error {
  margin: 12px 0 0;
  color: var(--danger);
  font-size: 12px;
}

.calibration-kpis {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  margin: 14px 0;
}

.calibration-kpis span {
  display: grid;
  gap: 2px;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: #f8fafc;
}

.calibration-kpis em {
  color: var(--muted);
  font-size: 12px;
  font-style: normal;
}

.calibration-kpis strong {
  font-size: 16px;
}

.calibration-tables {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.calibration-table-block h4,
.calibration-records > h4 {
  margin: 0 0 7px;
  font-size: 13px;
}

.calibration-table-block table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.calibration-table-block th,
.calibration-table-block td {
  padding: 7px 6px;
  border-bottom: 1px solid var(--line);
  text-align: right;
}

.calibration-table-block th:first-child,
.calibration-table-block td:first-child {
  text-align: left;
}

.calibration-records {
  display: grid;
  gap: 8px;
  margin-top: 16px;
}

.calibration-errors {
  display: grid;
  gap: 6px;
}

.calibration-errors h4 {
  margin: 0;
  font-size: 13px;
}

.calibration-errors > div {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.calibration-errors span {
  padding: 4px 8px;
  border-radius: 999px;
  background: #f1f4f8;
  color: var(--muted);
  font-size: 12px;
}

.calibration-errors strong {
  margin-left: 4px;
  color: var(--text);
}

.calibration-record details {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fff;
}

.calibration-record summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  padding: 10px 12px;
  font-size: 12px;
  cursor: pointer;
}

.calibration-title {
  min-width: 150px;
  font-size: 13px;
}

.calibration-status {
  padding: 2px 7px;
  border-radius: 999px;
  background: #eef2f7;
}

.calibration-status.is-hit {
  color: #16794b;
  background: #e8f7ef;
}

.calibration-status.is-miss,
.calibration-status.is-invalidated {
  color: #a33a2b;
  background: #fff1ed;
}

.calibration-status.is-insufficient-data,
.calibration-status.is-pending-confirmation,
.calibration-status.is-pending {
  color: #8a5a12;
  background: #fff6e5;
}

.calibration-confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
  font-size: 12px;
}

.calibration-versions {
  display: grid;
  gap: 4px;
  padding: 7px 9px;
  border-radius: 8px;
  background: #f8fafc;
  font-size: 12px;
}

.calibration-detail {
  display: grid;
  gap: 6px;
  padding: 0 12px 12px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 12px;
}

.calibration-detail p {
  margin: 6px 0 0;
}

.calibration-detail em {
  margin-right: 7px;
  color: var(--text);
  font-style: normal;
  font-weight: 600;
}

.calibration-detail pre {
  max-height: 220px;
  overflow: auto;
  padding: 8px;
  border-radius: 8px;
  background: #f4f6f8;
  font-size: 12px;
  white-space: pre-wrap;
}

@media (max-width: 720px) {
  .calibration-toolbar,
  .calibration-month,
  .calibration-tables {
    display: grid;
    grid-template-columns: 1fr;
  }

  .calibration-month {
    width: 100%;
  }

  .calibration-kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
