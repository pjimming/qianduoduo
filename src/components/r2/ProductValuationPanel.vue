<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import {
  formatDateShort,
  formatMoney,
} from '@/composables/useFormatters'
import type {
  Holding,
  ProductDailyValuation,
  ProductValuationDetail,
  ProductValuationReconciliation,
  ProductValuationSummary,
} from '@/types/dashboard'
import DataTrustTraceDialog from '@/components/DataTrustTraceDialog.vue'

const props = defineProps<{
  summaries: ProductValuationSummary[]
  reconciliation: ProductValuationReconciliation
  today: string
  reportingDate: string
  holdings: Holding[]
}>()

const store = useDashboardStore()
const { show } = useToast()
const route = useRoute()
const selectedCode = ref('')
const detail = ref<ProductValuationDetail | null>(null)
const loadingDetail = ref(false)
const saving = ref(false)
const editingId = ref<number | null>(null)
const formOpen = ref(false)
const traceOpen = ref(false)
const traceFactKey = ref('')
const traceTitle = ref('')

const form = reactive({
  yield_date: props.reportingDate,
  credit_date: props.reportingDate,
  holding_amount: null as number | null,
  daily_pnl: '',
  coverage_start_date: '',
  coverage_end_date: '',
  clear_coverage: false,
  notes: '',
  correction_note: '',
})

const productCards = computed<ProductValuationSummary[]>(() => {
  const cards = props.summaries.slice()
  const known = new Set(cards.map((item) => item.product_code))
  for (const holding of props.holdings) {
    const code = String(holding.product_code || '').toUpperCase()
    if (!code || known.has(code)) continue
    cards.push({
      product_code: code,
      product_name: holding.product_name,
      status: 'active',
      active_amount: holding.amount,
      latest_holding_amount: holding.amount,
      first_yield_date: '',
      last_yield_date: '',
      holding_start: holding.purchase_date,
      holding_end: props.today,
      holding_days: 0,
      observed_days: 0,
      cumulative_pnl: 0,
      negative_days: 0,
      latest_daily_pnl: null,
      yield_lag_days: 1,
      yield_lag_source: 'default',
      yield_lag_verified: false,
      yield_lag_label: 'T+1（参考）',
      yield_lag_notes: '',
      yield_lag_updated_at: '',
      expected_latest_yield_date: props.reportingDate,
      todays_yield_visible_date: props.reportingDate,
      worst_day: null,
      best_day: null,
    })
    known.add(code)
  }
  return cards
})
const selectedSummary = computed(
  () =>
    productCards.value.find(
      (item) => item.product_code === selectedCode.value,
    ) ?? null,
)
const activeCount = computed(
  () => productCards.value.filter((item) => item.status === 'active').length,
)
const redeemedCount = computed(
  () => productCards.value.filter((item) => item.status === 'redeemed').length,
)
const waitingReconciliations = computed(() =>
  props.reconciliation.items.filter((item) => item.status === 'waiting'),
)
const finalReconciliations = computed(() =>
  props.reconciliation.items.filter((item) =>
    ['mismatch', 'missing-product-details'].includes(item.status),
  ),
)

function reconciliationLabel(
  status: ProductValuationReconciliation['items'][number]['status'],
): string {
  return (
    {
      waiting: '等待到账',
      'missing-product-details': '待补产品',
      mismatch: '最终差异',
      matched: '核对一致',
    }[status] || status
  )
}

function reconciliationTone(
  status: ProductValuationReconciliation['items'][number]['status'],
): string {
  if (status === 'waiting') return 'is-waiting'
  return 'is-warn'
}

function sourceLabel(source: string): string {
  return (
    {
      'income-screenshot': '收益截图',
      'manual-correction': '人工修正',
    }[source] || source
  )
}

function incomeAmount(item: { daily_pnl: number; daily_pnl_exact?: number; daily_pnl_1e4?: number | null }): number {
  return item.daily_pnl_exact ?? (item.daily_pnl_1e4 == null ? item.daily_pnl : item.daily_pnl_1e4 / 10000)
}

function precisionLabel(item: ProductValuationSummary): string {
  const total = item.precision_total_count ?? item.observed_days
  if (!total) return '尚无日收益记录'
  if (item.precision_status === 'full') return `四位来源 ${total} / ${total} 条`
  if (item.precision_status === 'mixed-source') return `已按来源精度记录 · 四位 ${item.precision_four_digit_count ?? 0} / ${total} 条`
  return `历史精度待核 · 原值 ${item.precision_recorded_count ?? 0} / ${total} 条`
}

function displayedIncome(item: ProductValuationSummary): number {
  if (item.bank_holding_income?.scope_status === 'rolled_forward' && item.bank_holding_income.current_holding_income != null) return item.bank_holding_income.current_holding_income
  return item.bank_holding_income?.scope_status === 'current'
    ? item.bank_holding_income.holding_income
    : item.cumulative_pnl
}

function recordPrecisionLabel(item: ProductDailyValuation): string {
  return item.source_precision ? `来源 ${item.source_precision} 位` : '历史精度待核'
}

function auditIncome(item: Record<string, unknown>): number {
  return Number(item.daily_pnl_exact ?? (item.daily_pnl_1e4 == null ? item.daily_pnl ?? 0 : Number(item.daily_pnl_1e4) / 10000))
}

function coverageLabel(dates: string[] | undefined): string {
  const values = [...new Set((dates || []).filter(Boolean))].sort()
  if (values.length < 2) return ''
  const contiguous = values.every((date, index) => {
    if (index === 0) return true
    return (
      Date.parse(`${date}T00:00:00Z`) -
        Date.parse(`${values[index - 1]}T00:00:00Z`) ===
      86400000
    )
  })
  if (!contiguous) return values.join('、')
  if (values.length === 2) return `${values[0]} 至 ${values[1]}`
  return `${values[0]} 至 ${values[values.length - 1]}（${values.length} 日合并）`
}

function contiguousCoverage(dates: string[] | undefined): boolean {
  const values = [...new Set((dates || []).filter(Boolean))].sort()
  return (
    values.length > 1 &&
    values.every((date, index) => {
      if (index === 0) return true
      return (
        Date.parse(`${date}T00:00:00Z`) -
          Date.parse(`${values[index - 1]}T00:00:00Z`) ===
        86400000
      )
    })
  )
}

function resetForm(): void {
  editingId.value = null
  form.yield_date = props.reportingDate
  form.credit_date = props.reportingDate
  form.holding_amount = selectedSummary.value?.active_amount ||
    selectedSummary.value?.latest_holding_amount ||
    null
  form.daily_pnl = ''
  form.coverage_start_date = ''
  form.coverage_end_date = ''
  form.clear_coverage = false
  form.notes = ''
  form.correction_note = ''
}

async function openProduct(code: string): Promise<void> {
  selectedCode.value = code
  formOpen.value = false
  resetForm()
  loadingDetail.value = true
  try {
    detail.value = await store.loadProductValuationDetail(code)
  } catch (error) {
    show(error instanceof Error ? error.message : '产品收益档案加载失败', {
      error: true,
    })
  } finally {
    loadingDetail.value = false
  }
}

function openProductFromRoute(): void {
  const code = String(route.query.product || '').trim().toUpperCase()
  if (!code || !productCards.value.some((item) => item.product_code === code)) {
    return
  }
  if (selectedCode.value === code && detail.value) return
  void openProduct(code)
}

onMounted(openProductFromRoute)
watch(() => route.query.product, openProductFromRoute)

function startCorrection(
  valuation: ProductValuationDetail['valuations'][number],
): void {
  formOpen.value = true
  editingId.value = valuation.id
  form.yield_date = valuation.yield_date
  form.credit_date = valuation.credit_date
  form.holding_amount = valuation.holding_amount
  form.daily_pnl = incomeAmount(valuation).toFixed(valuation.source_precision ?? (valuation.daily_pnl_1e4 == null ? 2 : 4))
  form.coverage_start_date = contiguousCoverage(valuation.covered_yield_dates)
    ? valuation.covered_yield_dates[0]
    : ''
  form.coverage_end_date = contiguousCoverage(valuation.covered_yield_dates)
    ? valuation.covered_yield_dates[valuation.covered_yield_dates.length - 1]
    : ''
  form.clear_coverage = false
  form.notes = valuation.notes
  form.correction_note = ''
}

function startCreate(): void {
  resetForm()
  formOpen.value = true
}

function openTrace(valuation: ProductDailyValuation): void {
  traceFactKey.value = `product_income:${valuation.id}`
  traceTitle.value = `${valuation.product_name || valuation.product_code} · ${valuation.yield_date}`
  traceOpen.value = true
}

async function save(): Promise<void> {
  if (!selectedSummary.value) return
  if (!form.daily_pnl.trim()) {
    show('请填写产品当日收益', { error: true })
    return
  }
  if (!/^[+-]?(?:\d+(?:\.\d{1,4})?|\.\d{1,4})$/.test(form.daily_pnl.trim()) || !Number.isSafeInteger(Math.round(Number(form.daily_pnl) * 10000))) {
    show('当日收益最多保留 4 位小数，请按截图原值填写', { error: true })
    return
  }
  if (!form.yield_date) {
    show('请选择收益日期', { error: true })
    return
  }
  if (
    !form.clear_coverage &&
    Boolean(form.coverage_start_date) !== Boolean(form.coverage_end_date)
  ) {
    show('合并覆盖需要同时填写起始日和截止日', { error: true })
    return
  }
  if (
    !form.clear_coverage &&
    form.coverage_start_date &&
    form.coverage_end_date &&
    form.coverage_end_date < form.coverage_start_date
  ) {
    show('合并覆盖截止日不能早于起始日', { error: true })
    return
  }
  saving.value = true
  const wasEditing = editingId.value !== null
  try {
    const payload = {
      yield_date: form.yield_date,
      credit_date: form.credit_date,
      valuation_date: form.credit_date,
      product_code: selectedSummary.value.product_code,
      product_name: selectedSummary.value.product_name,
      holding_amount: form.holding_amount,
      daily_pnl: Number(form.daily_pnl),
      source_precision: ((form.daily_pnl.split('.')[1]?.length ?? 0) > 2 ? 4 : 2) as 2 | 4,
      ...(!form.clear_coverage && form.coverage_start_date
        ? {
            coverage_start_date: form.coverage_start_date,
            coverage_end_date: form.coverage_end_date,
          }
        : {}),
      ...(form.clear_coverage ? { clear_coverage: true } : {}),
      notes: form.notes.trim(),
      correction_note: form.correction_note.trim() || '持仓页手工修正',
    }
    const response =
      editingId.value !== null
        ? await store.updateProductValuation(editingId.value, payload)
        : await store.saveProductValuation(payload)
    detail.value = await store.loadProductValuationDetail(
      selectedSummary.value.product_code,
    )
    resetForm()
    formOpen.value = false
    show(
      response.conflict
        ? '该产品日期已有不同收益，平台未覆盖；已生成人工确认提醒'
        : wasEditing
          ? '产品收益已修正并保留审计记录'
          : '产品收益已记录；如日期和金额已存在则自动忽略',
      response.conflict ? { error: true, duration: 7000 } : undefined,
    )
  } catch (error) {
    show(error instanceof Error ? error.message : '保存失败', { error: true })
  } finally {
    saving.value = false
  }
}

</script>

<template>
  <div class="rw-panel-body product-valuation-panel">
    <div class="rw-toolbar">
      <div class="rw-card-heading">
        <strong class="rw-panel-title">逐产品每日收益档案</strong>
        <p class="rw-panel-sub">
          产品收益按你提供的收益归属日归档，并另行保存到账/可见日；同日期同金额视为已记录，
          不同金额只提醒、不覆盖。合并更新只记最后归属日并标明覆盖区间，前几日不补 0、
          不做均分。日收益最多保存 4 位小数，累计后再舍入；两位截图按原值记录，历史未知精度单独标注。
        </p>
      </div>
      <div class="rw-toolbar-actions pv-summary-chips">
        <span class="rw-stat-chip">持有中 <strong>{{ activeCount }}</strong></span>
        <span class="rw-stat-chip">已赎回 <strong>{{ redeemedCount }}</strong></span>
        <span class="rw-stat-chip">
          等待到账 <strong>{{ props.reconciliation.counts.waiting }}</strong>
        </span>
        <span class="rw-stat-chip">
          核对一致 <strong>{{ props.reconciliation.counts.matched }}</strong>
        </span>
        <span
          class="rw-stat-chip"
          :class="{ 'is-warn': props.reconciliation.counts.mismatch > 0 }"
        >
          最终差异 <strong>{{ props.reconciliation.counts.mismatch }}</strong>
        </span>
        <span
          class="rw-stat-chip"
          :class="{
            'is-warn': props.reconciliation.counts.missing_products > 0,
          }"
        >
          待补产品
          <strong>{{ props.reconciliation.counts.missing_products }}</strong>
        </span>
      </div>
    </div>

    <div v-if="waitingReconciliations.length" class="pv-issues pv-issues--waiting">
      <button
        v-for="item in waitingReconciliations.slice(0, 4)"
        :key="`waiting-${item.account_date}`"
        type="button"
        class="pv-issue is-waiting"
        @click="productCards[0] && openProduct(productCards[0].product_code)"
      >
        <strong>
          {{ item.account_date }} · 等待到账
          <small>
            {{ item.covered_product_count ?? item.product_count }} /
            {{ item.expected_product_count }} 只产品已覆盖
          </small>
        </strong>
        <span>
          最迟 {{ item.final_disclosure_date }} 完成披露（最大 T+{{ item.max_yield_lag_days }}）；
          该日仍保持等待，次日巡检仍缺才提示。已见产品合计已进入账户总账，其余产品到账后自动重算。
        </span>
      </button>
    </div>

    <div v-if="finalReconciliations.length" class="pv-issues">
      <button
        v-for="item in finalReconciliations.slice(0, 6)"
        :key="`${item.account_date}-${item.status}`"
        type="button"
        class="pv-issue"
        :class="reconciliationTone(item.status)"
        @click="productCards[0] && openProduct(productCards[0].product_code)"
      >
        <strong>
          {{ item.account_date }} · {{ reconciliationLabel(item.status) }}
          <small>
            {{ item.covered_product_count ?? item.product_count }} /
            {{ item.expected_product_count }} 只已覆盖 · 当日产品
            ¥{{ formatMoney(item.product_pnl, 2) }}
          </small>
        </strong>
        <span>{{ item.message }}</span>
        <small>
          最终披露日 {{ item.final_disclosure_date }} · 最大
          T+{{ item.max_yield_lag_days }}
        </small>
      </button>
    </div>

    <div v-if="productCards.length" class="pv-grid">
      <button
        v-for="item in productCards"
        :key="item.product_code"
        type="button"
        class="pv-card"
        :class="{ 'is-selected': item.product_code === selectedCode }"
        @click="openProduct(item.product_code)"
      >
        <span class="pv-card-head">
          <strong>{{ item.product_name || item.product_code }}</strong>
          <em :class="`is-${item.status}`">
            {{ item.status === 'active' ? '持有中' : '已赎回' }}
          </em>
        </span>
        <span class="pv-card-code">{{ item.product_code }}</span>
        <span class="pv-card-stats">
          <span>
            <small>{{ item.bank_holding_income?.scope_status === 'current' ? '银行持仓收益' : item.bank_holding_income?.scope_status === 'rolled_forward' ? '银行基准续算收益' : '账本累计收益' }}</small>
            <strong :class="{ 'is-negative': displayedIncome(item) < 0 }">
              ¥{{ formatMoney(displayedIncome(item), 2) }}
            </strong>
          </span>
          <span>
            <small>已记录日数 / 持有天数</small>
            <strong>{{ item.observed_days }} / {{ item.holding_days }} 天</strong>
          </span>
          <span>
            <small>负收益天数</small>
            <strong>{{ item.negative_days }} 天</strong>
          </span>
          <span>
            <small>最差单日</small>
            <strong class="is-negative">
              {{ item.worst_day ? `¥${formatMoney(incomeAmount(item.worst_day), 4)}` : '—' }}
            </strong>
          </span>
        </span>
        <span v-if="item.bank_holding_income" class="pv-bank-reconciliation">
          <span>银行截至 {{ item.bank_holding_income.as_of_date }} · ¥{{ formatMoney(item.bank_holding_income.holding_income, 2) }}<template v-if="item.bank_holding_income.scope_status === 'rolled_forward'"> · 已按日收益续算至 {{ item.bank_holding_income.projection_as_of_date }}</template><template v-else-if="item.bank_holding_income.scope_status !== 'current'"> · {{ item.bank_holding_income.scope_status === 'needs_review' ? '持仓范围待核' : '历史快照' }}</template></span>
          <span>同期账本 {{ item.bank_holding_income.ledger_income == null ? '待核' : `¥${formatMoney(item.bank_holding_income.ledger_income, 2)}` }} · 差额（银行−账本） {{ item.bank_holding_income.difference == null ? '待核' : `¥${formatMoney(item.bank_holding_income.difference, 2)}` }}</span>
        </span>
        <span class="pv-precision-note">{{ precisionLabel(item) }}</span>
        <span class="pv-card-foot">
          最近归属日 {{ item.last_yield_date || '—' }} · 查看逐日记录 →
        </span>
      </button>
    </div>
    <div v-else class="rw-empty">
      还没有产品级收益档案。上传含产品明细的收益截图后，平台会按产品代码自动归档。
    </div>

    <section v-if="selectedCode" class="pv-detail">
      <div class="pv-detail-head">
        <div>
          <strong>{{ selectedSummary?.product_name || selectedCode }}</strong>
          <span>
            {{ selectedCode }} · 最后归属日 {{ selectedSummary?.last_yield_date || '—' }}
          </span>
        </div>
        <div class="pv-detail-actions">
          <button type="button" class="rw-button is-secondary" @click="startCreate">
            补录一天
          </button>
          <button type="button" class="rw-link-button" @click="selectedCode = ''; detail = null">
            收起
          </button>
        </div>
      </div>

      <form v-if="formOpen" class="pv-form" @submit.prevent="save">
        <label>
          <span>收益归属日</span>
          <input
            v-model="form.yield_date"
            type="date"
            :max="today"
            required
          />
        </label>
        <label>
          <span>到账/可见日</span>
          <input v-model="form.credit_date" type="date" :max="today" required />
        </label>
        <label>
          <span>当日持仓金额</span>
          <input v-model.number="form.holding_amount" type="number" min="0" step="0.01" />
        </label>
        <label>
          <span>当日收益（最多 4 位小数）</span>
          <input :value="form.daily_pnl" type="number" step="0.0001" required @input="form.daily_pnl = ($event.target as HTMLInputElement).value" />
        </label>
        <label>
          <span>合并覆盖起始日（可选）</span>
          <input
            v-model="form.coverage_start_date"
            type="date"
            :max="form.yield_date"
            :disabled="form.clear_coverage"
          />
        </label>
        <label>
          <span>合并覆盖截止日（可选）</span>
          <input
            v-model="form.coverage_end_date"
            type="date"
            :max="form.yield_date"
            :disabled="form.clear_coverage"
          />
        </label>
        <label v-if="editingId !== null" class="is-wide pv-checkbox">
          <input v-model="form.clear_coverage" type="checkbox" />
          <span>撤回这条记录的合并覆盖区间</span>
        </label>
        <label class="is-wide">
          <span>备注</span>
          <input v-model="form.notes" type="text" maxlength="300" placeholder="可选" />
        </label>
        <label class="is-wide">
          <span>修正原因（写入审计）</span>
          <input
            v-model="form.correction_note"
            type="text"
            maxlength="300"
            placeholder="例如：截图金额识别错误"
          />
        </label>
        <div class="pv-form-actions">
          <button type="submit" class="rw-button" :disabled="saving">
            {{ saving ? '保存中…' : editingId ? '保存修正' : '补录收益' }}
          </button>
          <button type="button" class="rw-link-button" @click="formOpen = false; resetForm()">
            取消
          </button>
        </div>
      </form>

      <div v-if="loadingDetail" class="rw-empty is-compact">正在加载逐日记录…</div>
      <div v-else-if="detail?.valuations.length" class="rw-table-wrap">
        <table class="rw-table pv-table">
          <thead>
            <tr>
              <th>收益日期</th>
              <th>到账/可见日</th>
              <th class="is-number">当日持仓金额</th>
              <th class="is-number">当日收益</th>
              <th>来源</th>
              <th>备注</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="valuation in detail.valuations.slice().reverse()" :key="valuation.id">
              <td>
                {{ valuation.yield_date }}
                <small
                  v-if="coverageLabel(valuation.covered_yield_dates)"
                  class="pv-coverage"
                >
                  合并覆盖 {{ coverageLabel(valuation.covered_yield_dates) }}；
                  金额并入 {{ valuation.yield_date }}
                </small>
              </td>
              <td>{{ valuation.credit_date }}</td>
              <td class="is-number">
                {{ valuation.holding_amount === null ? '—' : `¥${formatMoney(valuation.holding_amount, 2)}` }}
              </td>
              <td
                class="is-number"
                :class="{ 'rw-danger-text': incomeAmount(valuation) < 0, 'rw-gain-text': incomeAmount(valuation) > 0 }"
              >
                ¥{{ formatMoney(incomeAmount(valuation), 4) }}
                <small class="pv-precision-note">{{ recordPrecisionLabel(valuation) }}</small>
              </td>
              <td>{{ sourceLabel(valuation.source) }}</td>
              <td>{{ valuation.notes || '—' }}</td>
              <td class="pv-row-actions">
                <button type="button" class="rw-link-button" @click="openTrace(valuation)">
                  来源
                </button>
                <button type="button" class="rw-link-button" @click="startCorrection(valuation)">
                  修正
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="rw-empty is-compact">还没有逐日记录。</div>

      <div v-if="detail?.audit.length" class="pv-audit">
        <strong>最近修正留痕</strong>
        <span v-for="audit in detail.audit.slice(0, 3)" :key="audit.id">
          {{ formatDateShort(audit.created_at.slice(0, 10)) }} ·
          {{ audit.note || sourceLabel(audit.source) }} ·
          收益 ¥{{ formatMoney(auditIncome(audit.after), 4) }}
        </span>
      </div>
    </section>

    <DataTrustTraceDialog
      :open="traceOpen"
      fact-type="product_income"
      :fact-key="traceFactKey"
      :title="traceTitle"
      @close="traceOpen = false"
    />
  </div>
</template>

<style scoped>
.pv-bank-reconciliation,
.pv-precision-note {
  display: block;
  color: var(--ink-soft);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.pv-bank-reconciliation {
  padding-top: 8px;
  border-top: 1px solid var(--line);
}

.pv-bank-reconciliation > span {
  display: block;
}

.pv-card > .pv-precision-note {
  margin-top: 6px;
}

.pv-form {
  background: var(--card);
}

.pv-form label {
  color: var(--ink-soft);
}

.pv-row-actions {
  display: flex;
  gap: 10px;
  white-space: nowrap;
}

.pv-coverage {
  display: block;
  margin-top: 3px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.45;
}

.pv-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pv-checkbox input {
  width: auto;
  min-height: 0;
}
</style>
