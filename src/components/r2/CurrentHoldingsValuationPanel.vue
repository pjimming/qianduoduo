<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import {
  formatDateShort,
  formatMoney,
  formatSignedMoney,
} from '@/composables/useFormatters'
import type {
  CurrentHoldingsValuation,
  Holding,
  HoldingValuationItemInput,
} from '@/types/dashboard'

const props = defineProps<{
  valuation: CurrentHoldingsValuation
  holdings: Holding[]
  today: string
}>()

const dashboardStore = useDashboardStore()
const { show } = useToast()
const showForm = ref(false)
const saving = ref(false)
const uploadingEvidence = ref(false)
const evidenceId = ref<number | null>(null)
const evidenceName = ref('')
const includeItems = ref(false)
const itemValues = reactive<Record<string, number | ''>>({})
const form = reactive({
  as_of_date: props.valuation.as_of_date || props.today,
  total_value: props.valuation.current_value ?? null,
  notes: '',
})

const groupedHoldings = computed(() => {
  const grouped = new Map<
    string,
    { product_code: string; product_name: string; cost: number }
  >()
  for (const holding of props.holdings) {
    const code = String(holding.product_code || '').trim().toUpperCase()
    if (!code) continue
    const current = grouped.get(code) || {
      product_code: code,
      product_name: holding.product_name,
      cost: 0,
    }
    current.cost += Number(holding.amount || 0)
    current.product_name = current.product_name || holding.product_name
    grouped.set(code, current)
  }
  return [...grouped.values()].sort((a, b) =>
    a.product_code.localeCompare(b.product_code),
  )
})

const statusLabel = computed(() => {
  if (!props.valuation.available) return '暂无市值快照'
  return props.valuation.status === 'stale' ? '快照待更新' : '银行快照'
})

const itemTotal = computed(() =>
  groupedHoldings.value.reduce((sum, holding) => {
    const value = itemValues[holding.product_code]
    return sum + (value === '' || value === undefined ? 0 : Number(value))
  }, 0),
)

watch(
  () => props.valuation.as_of_date,
  (value) => {
    if (value) form.as_of_date = value
  },
)

watch(
  () => props.valuation.current_value,
  (value) => {
    if (value !== null) form.total_value = value
  },
)

function openForm(): void {
  form.as_of_date = props.valuation.as_of_date || props.today
  form.total_value = props.valuation.current_value ?? null
  form.notes = ''
  evidenceId.value = null
  evidenceName.value = ''
  includeItems.value = false
  for (const key of Object.keys(itemValues)) delete itemValues[key]
  showForm.value = true
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取截图失败'))
    reader.readAsDataURL(file)
  })
}

async function uploadEvidence(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    show('只支持 PNG、JPEG 或 WebP 截图', { error: true })
    input.value = ''
    return
  }
  if (file.size > 10 * 1024 * 1024) {
    show('单张截图不能超过 10 MB', { error: true })
    input.value = ''
    return
  }
  uploadingEvidence.value = true
  try {
    const data = await fileToBase64(file)
    const response = await dashboardStore.uploadHoldingValuationEvidence({
      filename: file.name,
      mime: file.type,
      data,
    })
    evidenceId.value = response.evidence.id
    evidenceName.value = file.name
    show(response.duplicate ? '该截图已存在，已关联原证据' : '市值截图已保存')
  } catch (error) {
    evidenceId.value = null
    evidenceName.value = ''
    input.value = ''
    show(error instanceof Error ? error.message : '截图上传失败', {
      error: true,
      duration: 6000,
    })
  } finally {
    uploadingEvidence.value = false
  }
}

async function save(): Promise<void> {
  const total = Number(form.total_value)
  if (!form.as_of_date) {
    show('请选择银行市值快照日期', { error: true })
    return
  }
  if (!Number.isFinite(total) || total < 0) {
    show('请输入不小于 0 的当前持仓总市值', { error: true })
    return
  }
  let items: HoldingValuationItemInput[] | undefined
  if (includeItems.value) {
    const missing = groupedHoldings.value.filter((holding) => {
      const value = itemValues[holding.product_code]
      return value === '' || value === undefined
    })
    if (missing.length) {
      show(
        `请填写全部逐产品市值，缺少 ${missing
          .map((item) => item.product_code)
          .join('、')}`,
        { error: true },
      )
      return
    }
    items = groupedHoldings.value.map((holding) => ({
      product_code: holding.product_code,
      product_name: holding.product_name,
      market_value: Number(itemValues[holding.product_code]),
    }))
    if (Math.abs(itemTotal.value - total) > 0.01) {
      show(
        `逐产品合计 ¥${formatMoney(itemTotal.value)} 与总市值 ¥${formatMoney(
          total,
        )} 不一致`,
        { error: true },
      )
      return
    }
  }
  saving.value = true
  try {
    await dashboardStore.saveHoldingValuation({
      as_of_date: form.as_of_date,
      total_value: total,
      source: 'user-confirmed',
      notes: form.notes.trim(),
      evidence_id: evidenceId.value,
      items,
    })
    show('当前已确认持仓市值已更新')
    showForm.value = false
  } catch (error) {
    show(error instanceof Error ? error.message : '市值快照保存失败', {
      error: true,
      duration: 6000,
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="rw-panel-body current-nav-panel">
    <div class="rw-toolbar">
      <div class="rw-card-heading">
        <p class="kicker">CONFIRMED HOLDINGS VALUE</p>
        <strong class="rw-panel-title">当前已确认持仓净值</strong>
        <p class="rw-panel-sub">
          只使用银行当前已确认产品的市值快照。待确认买入、临时桥接本金和已赎回产品不进入这个净值。
        </p>
      </div>
      <div class="rw-toolbar-actions">
        <span class="nav-status" :class="`is-${valuation.status}`">
          {{ statusLabel }}
        </span>
        <button type="button" class="rw-button" @click="openForm">
          更新持仓市值
        </button>
      </div>
    </div>

    <div class="nav-hero">
      <div>
        <span class="nav-label">当前净值</span>
        <strong class="nav-value">
          {{
            valuation.available && valuation.current_value !== null
              ? `¥${formatMoney(valuation.current_value)}`
              : '—'
          }}
        </strong>
        <p>
          {{
            valuation.as_of_date
              ? `银行快照 ${formatDateShort(valuation.as_of_date)}`
              : '尚未录入银行当前持仓市值'
          }}
        </p>
      </div>
      <div class="nav-facts">
        <div>
          <span>已确认持仓</span>
          <strong>{{ valuation.active_holding_count }} 批</strong>
        </div>
        <div>
          <span>未赎回成本</span>
          <strong>¥{{ formatMoney(valuation.active_cost) }}</strong>
        </div>
        <div>
          <span>相对成本变动</span>
          <strong
            :class="{
              'rw-gain-text': (valuation.market_gain ?? 0) > 0,
              'rw-danger-text': (valuation.market_gain ?? 0) < 0,
            }"
          >
            {{
              valuation.market_gain === null
                ? '—'
                : formatSignedMoney(valuation.market_gain)
            }}
          </strong>
        </div>
        <div>
          <span>待确认买入（未计入）</span>
          <strong>
            {{ valuation.pending_buy_count }} 笔 ·
            ¥{{ formatMoney(valuation.pending_buy_amount, 0) }}
          </strong>
        </div>
        <div>
          <span>较上一快照</span>
          <strong
            :class="{
              'rw-gain-text': (valuation.change_since_previous ?? 0) > 0,
              'rw-danger-text': (valuation.change_since_previous ?? 0) < 0,
            }"
          >
            {{
              valuation.change_since_previous === null
                ? '首笔快照'
                : formatSignedMoney(valuation.change_since_previous)
            }}
            <small v-if="valuation.previous_as_of_date">
              · {{ formatDateShort(valuation.previous_as_of_date) }}
            </small>
          </strong>
        </div>
      </div>
    </div>

    <p v-if="valuation.notes" class="nav-note">{{ valuation.notes }}</p>
    <p v-if="valuation.evidence_id" class="nav-note">
      银行持仓截图：
      <a
        :href="`/api/holding-valuations/evidence/${valuation.evidence_id}/image`"
        target="_blank"
        rel="noreferrer"
      >
        查看原始证据
      </a>
    </p>
    <p v-if="!valuation.items_complete && valuation.available" class="nav-note">
      当前只保存了银行总市值，尚未录入逐产品拆分。
    </p>
    <div v-if="valuation.stale_reasons.length" class="rw-alerts">
      <span
        v-for="reason in valuation.stale_reasons"
        :key="reason"
        class="rw-alert is-warn"
      >
        {{ reason }}
      </span>
    </div>

    <form v-if="showForm" class="nav-form" @submit.prevent="save">
      <div class="nav-form-head">
        <strong>录入银行当前持仓市值</strong>
        <button type="button" class="rw-link-button" @click="showForm = false">
          取消
        </button>
      </div>
      <div class="nav-form-grid">
        <label>
          <span>快照日期</span>
          <input v-model="form.as_of_date" type="date" :max="today" required />
        </label>
        <label>
          <span>当前已确认持仓总市值</span>
          <div class="nav-money-input">
            <span>¥</span>
            <input
              v-model.number="form.total_value"
              type="number"
              min="0"
              step="0.01"
              inputmode="decimal"
              placeholder="0.00"
              required
            />
          </div>
        </label>
        <label class="nav-wide">
          <span>备注</span>
          <input
            v-model="form.notes"
            type="text"
            maxlength="300"
            placeholder="例：招行 App 当前已确认理财产品市值"
          />
        </label>
        <div class="nav-wide nav-evidence">
          <label>
            <span>银行持仓截图（可选）</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              :disabled="uploadingEvidence"
              @change="uploadEvidence"
            />
          </label>
          <p>
            {{
              uploadingEvidence
                ? '截图上传中…'
                : evidenceId
                  ? `已绑定：${evidenceName}`
                  : 'PNG、JPEG 或 WebP，单张不超过 10 MB'
            }}
          </p>
        </div>
      </div>

      <label class="nav-item-toggle">
        <input v-model="includeItems" type="checkbox" />
        <span>同时录入逐产品市值（可选，填写时必须覆盖全部已确认持仓）</span>
      </label>

      <div v-if="includeItems" class="nav-items">
        <label
          v-for="holding in groupedHoldings"
          :key="holding.product_code"
          class="nav-item"
        >
          <span>
            <strong>{{ holding.product_name }}</strong>
            <small>
              {{ holding.product_code }} · 成本
              ¥{{ formatMoney(holding.cost) }}
            </small>
          </span>
          <div class="nav-money-input">
            <span>¥</span>
            <input
              v-model.number="itemValues[holding.product_code]"
              type="number"
              min="0"
              step="0.01"
              inputmode="decimal"
              placeholder="0.00"
              required
            />
          </div>
        </label>
        <p class="nav-item-total">
          逐产品合计
          <strong>¥{{ formatMoney(itemTotal) }}</strong>
          <span v-if="form.total_value !== null">
            · 与总市值差
            ¥{{ formatMoney(itemTotal - Number(form.total_value)) }}
          </span>
        </p>
      </div>

      <div class="nav-form-actions">
        <span>保存后首页会立即更新，且保留历史快照。</span>
        <button type="submit" class="rw-button" :disabled="saving">
          {{ saving ? '保存中…' : '保存市值快照' }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.current-nav-panel {
  display: grid;
  gap: 20px;
}

.nav-status {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 4px 10px;
  border-radius: 999px;
  background: #eef4f1;
  color: #2d6758;
  font-size: 12px;
  font-weight: 700;
}

.nav-status.is-stale,
.nav-status.is-missing {
  background: #fff3e4;
  color: #9a5a12;
}

.nav-hero {
  display: grid;
  grid-template-columns: minmax(260px, 0.8fr) minmax(0, 1.6fr);
  gap: 20px;
  align-items: stretch;
  padding: 22px;
  border: 1px solid #dfe9e4;
  border-radius: 18px;
  background:
    radial-gradient(circle at 5% 0%, rgba(54, 132, 104, 0.12), transparent 45%),
    #f8fbf9;
}

.nav-label,
.nav-facts span,
.nav-form label > span,
.nav-item small,
.nav-form-actions span {
  color: #65746e;
  font-size: 12px;
}

.nav-value {
  display: block;
  margin: 7px 0;
  color: #173f35;
  font-size: clamp(32px, 4vw, 50px);
  line-height: 1.05;
  letter-spacing: -0.035em;
}

.nav-hero p,
.nav-note {
  margin: 0;
  color: #65746e;
  font-size: 12.5px;
}

.nav-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.nav-facts > div {
  display: grid;
  align-content: center;
  gap: 4px;
  min-height: 70px;
  padding: 12px 14px;
  border: 1px solid #e3ebe7;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.86);
}

.nav-facts > div:last-child:nth-child(odd) {
  grid-column: 1 / -1;
}

.nav-facts strong {
  color: #263b34;
  font-size: 14px;
}

.nav-note {
  padding: 9px 12px;
  border-radius: 9px;
  background: #f5f8f6;
}

.nav-form {
  display: grid;
  gap: 16px;
  padding: 18px;
  border: 1px solid #dfe8e4;
  border-radius: 16px;
  background: #fff;
}

.nav-form-head,
.nav-form-actions,
.nav-item-toggle,
.nav-item-total {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.nav-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.nav-form label {
  display: grid;
  gap: 7px;
}

.nav-wide {
  grid-column: 1 / -1;
}

.nav-evidence {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 12px;
  border: 1px dashed #cad8d2;
  border-radius: 10px;
  background: #f9fbfa;
}

.nav-evidence > label {
  flex: 1;
}

.nav-evidence p {
  margin: 0;
  color: #65746e;
  font-size: 12px;
}

.nav-form input[type='date'],
.nav-form input[type='text'],
.nav-form input[type='number'] {
  width: 100%;
  min-height: 38px;
  padding: 8px 10px;
  border: 1px solid #ccd9d4;
  border-radius: 9px;
  background: #fff;
  color: #24352f;
  font: inherit;
  font-size: 12.5px;
}

.nav-money-input {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 5px;
}

.nav-money-input > span {
  color: #52635d;
  font-size: 12.5px;
}

.nav-item-toggle {
  justify-content: flex-start;
  color: #43544e;
  font-size: 12.5px;
}

.nav-item-toggle input {
  width: 16px;
  height: 16px;
}

.nav-items {
  display: grid;
  gap: 8px;
}

.nav-item {
  grid-template-columns: minmax(0, 1fr) minmax(150px, 210px);
  align-items: center;
  padding: 10px 12px;
  border: 1px solid #e5ece9;
  border-radius: 10px;
  background: #fafcfb;
}

.nav-item > span {
  display: grid;
  gap: 3px;
}

.nav-item strong {
  color: #2d3c37;
  font-size: 12.5px;
}

.nav-item-total {
  justify-content: flex-end;
  padding-top: 4px;
  color: #52635d;
  font-size: 12.5px;
}

.nav-form-actions {
  padding-top: 12px;
  border-top: 1px solid #edf1ef;
}

@media (max-width: 760px) {
  .nav-hero,
  .nav-form-grid {
    grid-template-columns: 1fr;
  }

  .nav-facts {
    grid-template-columns: 1fr 1fr;
  }

  .nav-form-head,
  .nav-form-actions,
  .nav-evidence {
    align-items: flex-start;
    flex-direction: column;
  }

  .nav-item {
    grid-template-columns: 1fr;
  }
}
</style>
