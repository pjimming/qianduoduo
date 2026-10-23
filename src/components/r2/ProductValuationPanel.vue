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
  daily_pnl: null as number | null,
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
const reconciliationIssues = computed(() =>
  props.reconciliation.items.filter((item) => item.status !== 'matched'),
)

function sourceLabel(source: string): string {
  return (
    {
      'income-screenshot': '收益截图',
      'manual-correction': '人工修正',
    }[source] || source
  )
}

function resetForm(): void {
  editingId.value = null
  form.yield_date = props.reportingDate
  form.credit_date = props.reportingDate
  form.holding_amount = selectedSummary.value?.active_amount ||
    selectedSummary.value?.latest_holding_amount ||
    null
  form.daily_pnl = null
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
  form.daily_pnl = valuation.daily_pnl
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
  if (form.daily_pnl === null || form.daily_pnl === undefined) {
    show('请填写产品当日收益', { error: true })
    return
  }
  if (!form.yield_date) {
    show('请选择收益日期', { error: true })
    return
  }
  saving.value = true
  try {
    const payload = {
      yield_date: form.yield_date,
      credit_date: form.credit_date,
      valuation_date: form.credit_date,
      product_code: selectedSummary.value.product_code,
      product_name: selectedSummary.value.product_name,
      holding_amount: form.holding_amount,
      daily_pnl: form.daily_pnl,
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
        : editingId.value !== null
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
        <p class="kicker">PRODUCT YIELD ARCHIVE</p>
        <strong class="rw-panel-title">逐产品每日收益档案</strong>
        <p class="rw-panel-sub">
          产品收益按你提供的收益归属日归档，并另行保存到账/可见日；同日期同金额视为已记录，
          不同金额只提醒、不覆盖。产品收益不重复计入账户总收益。
        </p>
      </div>
      <div class="rw-toolbar-actions pv-summary-chips">
        <span class="rw-stat-chip">持有中 <strong>{{ activeCount }}</strong></span>
        <span class="rw-stat-chip">已赎回 <strong>{{ redeemedCount }}</strong></span>
        <span
          class="rw-stat-chip"
          :class="{ 'is-warn': props.reconciliation.counts.mismatch > 0 }"
        >
          对账差异 <strong>{{ props.reconciliation.counts.mismatch }}</strong>
        </span>
      </div>
    </div>

    <div v-if="reconciliationIssues.length" class="pv-issues">
      <button
        v-for="item in reconciliationIssues.slice(0, 4)"
        :key="`${item.account_date}-${item.status}`"
        type="button"
        class="pv-issue"
        :class="{ 'is-warn': item.status === 'mismatch' }"
        @click="productCards[0] && openProduct(productCards[0].product_code)"
      >
        <strong>{{ item.account_date }} · 产品 ¥{{ formatMoney(item.product_pnl, 2) }}</strong>
        <span>{{ item.message }}</span>
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
            <small>累计已记录收益</small>
            <strong :class="{ 'is-negative': item.cumulative_pnl < 0 }">
              ¥{{ formatMoney(item.cumulative_pnl, 2) }}
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
              {{ item.worst_day ? `¥${formatMoney(item.worst_day.daily_pnl, 2)}` : '—' }}
            </strong>
          </span>
        </span>
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
          <span>当日收益</span>
          <input v-model.number="form.daily_pnl" type="number" step="0.01" required />
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
              <td>{{ valuation.yield_date }}</td>
              <td>{{ valuation.credit_date }}</td>
              <td class="is-number">
                {{ valuation.holding_amount === null ? '—' : `¥${formatMoney(valuation.holding_amount, 2)}` }}
              </td>
              <td
                class="is-number"
                :class="{ 'rw-danger-text': valuation.daily_pnl < 0, 'rw-gain-text': valuation.daily_pnl > 0 }"
              >
                ¥{{ formatMoney(valuation.daily_pnl, 2) }}
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
          收益 ¥{{ formatMoney(Number(audit.after.daily_pnl ?? 0), 2) }}
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
.pv-row-actions {
  display: flex;
  gap: 10px;
  white-space: nowrap;
}
</style>
