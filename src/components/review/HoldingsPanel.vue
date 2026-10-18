<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import {
  formatCompactMoney,
  formatDateShort,
  formatMoney,
  formatPct,
} from '@/composables/useFormatters'
import type { Holding, HoldingInput, HoldingsSummary } from '@/types/dashboard'

const props = defineProps<{
  holdings: Holding[]
  summary: HoldingsSummary
  today: string
}>()

const store = useDashboardStore()
const { show } = useToast()

interface HoldingForm {
  product_name: string
  product_code: string
  issuer: string
  risk_level: 'R2' | 'PR2'
  amount: number | null
  purchase_date: string
  term_days: string
  maturity_date: string
  notes: string
}

const formOpen = ref(false)
const editingId = ref<number | null>(null)
const saving = ref(false)
const form = reactive<HoldingForm>(emptyForm())

const ladderMax = computed(() =>
  Math.max(1, ...props.summary.ladder.map((item) => item.amount)),
)

const maturityPreview = computed(() => {
  if (form.maturity_date) return form.maturity_date
  const term = Number(form.term_days)
  if (!form.purchase_date || !Number.isInteger(term) || term <= 0) return '—'
  return addDays(form.purchase_date, term)
})

const bucketRows = computed(() => {
  const rows = [
    { label: '日开', pct: props.summary.bucket_pct.liquid, amount: props.summary.buckets.liquid },
    { label: '7–30 天', pct: props.summary.bucket_pct.short, amount: props.summary.buckets.short },
    { label: '31–100 天', pct: props.summary.bucket_pct.medium, amount: props.summary.buckets.medium },
    { label: '100 天以上', pct: props.summary.bucket_pct.long, amount: props.summary.buckets.long },
  ]
  if (props.summary.buckets.unknown > 0) {
    rows.push({
      label: '未填期限',
      pct: props.summary.bucket_pct.unknown,
      amount: props.summary.buckets.unknown,
    })
  }
  return rows
})

function emptyForm(): HoldingForm {
  return {
    product_name: '',
    product_code: '',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: null,
    purchase_date: props.today,
    term_days: '90',
    maturity_date: '',
    notes: '',
  }
}

function resetForm(): void {
  Object.assign(form, emptyForm())
  editingId.value = null
}

function openCreate(): void {
  resetForm()
  formOpen.value = true
}

function openEdit(item: Holding): void {
  editingId.value = item.id
  Object.assign(form, {
    product_name: item.product_name,
    product_code: item.product_code,
    issuer: item.issuer,
    risk_level: item.risk_level,
    amount: item.amount,
    purchase_date: item.purchase_date,
    term_days: item.term_days === null ? '' : String(item.term_days),
    maturity_date: item.maturity_date || '',
    notes: item.notes,
  })
  formOpen.value = true
}

async function save(): Promise<void> {
  if (!form.product_name.trim()) {
    show('请填写产品名称', { error: true })
    return
  }
  const amount = Number(form.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    show('持仓金额需要大于 0', { error: true })
    return
  }
  const termRaw = form.term_days.trim()
  const termDays = termRaw === '' ? null : Number(termRaw)
  if (
    termDays !== null &&
    (!Number.isInteger(termDays) || termDays < 0 || termDays > 3650)
  ) {
    show('期限需要是 0–3650 的整数天，0 表示日开', { error: true })
    return
  }
  const payload: HoldingInput = {
    product_name: form.product_name.trim(),
    product_code: form.product_code.trim(),
    issuer: form.issuer.trim(),
    risk_level: form.risk_level,
    amount,
    purchase_date: form.purchase_date,
    term_days: termDays,
    maturity_date: form.maturity_date || null,
    notes: form.notes.trim(),
  }
  saving.value = true
  try {
    if (editingId.value !== null) {
      await store.updateHolding(editingId.value, payload)
      show('持仓已更新')
    } else {
      await store.createHolding(payload)
      show('持仓已保存')
    }
    formOpen.value = false
    resetForm()
  } catch (error) {
    show(error instanceof Error ? error.message : '保存失败', { error: true })
  } finally {
    saving.value = false
  }
}

async function remove(item: Holding): Promise<void> {
  if (!window.confirm(`删除持仓「${item.product_name}」？`)) return
  try {
    await store.deleteHolding(item.id)
    show('持仓已删除')
  } catch (error) {
    show(error instanceof Error ? error.message : '删除失败', { error: true })
  }
}

function addDays(date: string, days: number): string {
  const stamp = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(stamp)) return '—'
  return new Date(stamp + days * 86400000).toISOString().slice(0, 10)
}

function ladderHeight(amount: number): string {
  if (amount <= 0) return '2px'
  return `${Math.max(6, (amount / ladderMax.value) * 100)}%`
}

function termLabel(value: number | null): string {
  if (value === 0) return '日开'
  if (value === null) return '未填'
  return `${value} 天`
}

function barWidth(value: number | null): string {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0%'
  return `${Math.max(0, Math.min(100, number))}%`
}
</script>

<template>
  <div class="rw-panel-body">
    <div class="rw-toolbar">
      <div class="rw-stat-row">
        <span class="rw-stat-chip">总持仓 <strong>¥{{ formatMoney(summary.total_amount, 0) }}</strong></span>
        <span class="rw-stat-chip">
          单只最高
          <strong>{{ formatPct(summary.max_product?.pct, 1) }}</strong>
        </span>
        <span class="rw-stat-chip">
          日开+30天
          <strong>{{ formatPct(summary.liquidity_ratio_pct, 1) }}</strong>
        </span>
        <span class="rw-stat-chip" :class="{ 'is-warn': summary.overdue_count > 0 }">
          已到期 <strong>{{ summary.overdue_count }} 笔</strong>
        </span>
      </div>
      <button type="button" class="rw-button" @click="openCreate">新增持仓</button>
    </div>

    <div v-if="summary.alerts.length" class="rw-alerts">
      <span
        v-for="alert in summary.alerts"
        :key="alert.code"
        class="rw-alert"
        :class="`is-${alert.level}`"
      >
        {{ alert.text }}
      </span>
    </div>

    <div class="rw-holdings-overview">
      <section class="rw-subpanel">
        <div class="rw-subhead">
          <strong>单只集中度</strong>
          <span>上限参考 30%</span>
        </div>
        <div v-if="summary.by_product.length" class="rw-bars">
          <div v-for="item in summary.by_product.slice(0, 6)" :key="item.code || item.name" class="rw-bar-row">
            <span class="rw-bar-label">{{ item.name }}</span>
            <div class="rw-bar-track">
              <span
                class="rw-bar-fill"
                :class="{ 'is-warn': (item.pct ?? 0) > 30 }"
                :style="{ width: barWidth(item.pct) }"
              ></span>
            </div>
            <strong>{{ formatPct(item.pct, 1) }}</strong>
          </div>
        </div>
        <div v-else class="rw-empty is-compact">录入持仓后显示集中度。</div>
      </section>

      <section class="rw-subpanel">
        <div class="rw-subhead">
          <strong>发行方集中度</strong>
          <span>多发行方时参考 50%</span>
        </div>
        <div v-if="summary.by_issuer.length" class="rw-bars">
          <div v-for="item in summary.by_issuer.slice(0, 5)" :key="item.name" class="rw-bar-row">
            <span class="rw-bar-label">{{ item.name }}</span>
            <div class="rw-bar-track">
              <span
                class="rw-bar-fill"
                :class="{ 'is-warn': (item.pct ?? 0) > 50 && summary.by_issuer.length > 1 }"
                :style="{ width: barWidth(item.pct) }"
              ></span>
            </div>
            <strong>{{ formatPct(item.pct, 1) }}</strong>
          </div>
        </div>
        <div v-else class="rw-empty is-compact">录入持仓后显示发行方占比。</div>
      </section>
    </div>

    <section class="rw-subpanel">
      <div class="rw-subhead">
        <strong>期限桶</strong>
        <span>日开 + 30 天内建议不低于 30%</span>
      </div>
      <div class="rw-bucket-grid">
        <div v-for="bucket in bucketRows" :key="bucket.label" class="rw-bucket">
          <span>{{ bucket.label }}</span>
          <strong>{{ formatPct(bucket.pct, 1) }}</strong>
          <small>¥{{ formatMoney(bucket.amount, 0) }}</small>
        </div>
      </div>
    </section>

    <section class="rw-subpanel">
      <div class="rw-subhead">
        <strong>未来 12 个月到期阶梯</strong>
        <span>当前持仓快照 · 不含已到期</span>
      </div>
      <div class="rw-ladder">
        <div v-for="item in summary.ladder" :key="item.month" class="rw-ladder-col">
          <strong>{{ item.amount > 0 ? formatCompactMoney(item.amount) : '—' }}</strong>
          <div class="rw-ladder-track">
            <span class="rw-ladder-fill" :style="{ height: ladderHeight(item.amount) }"></span>
          </div>
          <small>{{ item.month.slice(5) }}月</small>
        </div>
      </div>
      <p v-if="summary.beyond_12m_amount > 0" class="rw-form-hint">
        12 个月以上到期：¥{{ formatMoney(summary.beyond_12m_amount, 0) }}
      </p>
    </section>

    <form v-if="formOpen" class="rw-form" @submit.prevent="save">
      <div class="rw-form-head">
        <strong>{{ editingId === null ? '录入一笔持仓' : '修改持仓' }}</strong>
        <button type="button" class="rw-link-button" @click="formOpen = false; resetForm()">
          取消
        </button>
      </div>
      <div class="rw-form-grid">
        <label class="rw-field">
          <span>产品名称</span>
          <input v-model="form.product_name" type="text" maxlength="100" required />
        </label>
        <label class="rw-field">
          <span>产品代码</span>
          <input v-model="form.product_code" type="text" maxlength="50" />
        </label>
        <label class="rw-field">
          <span>发行方</span>
          <input v-model="form.issuer" type="text" maxlength="100" />
        </label>
        <label class="rw-field">
          <span>风险等级</span>
          <select v-model="form.risk_level">
            <option value="R2">R2</option>
            <option value="PR2">PR2</option>
          </select>
        </label>
        <label class="rw-field">
          <span>持仓金额</span>
          <input v-model.number="form.amount" type="number" min="0" step="0.01" required />
        </label>
        <label class="rw-field">
          <span>买入日期</span>
          <input v-model="form.purchase_date" type="date" required />
        </label>
        <label class="rw-field">
          <span>期限（天，0 = 日开）</span>
          <input v-model="form.term_days" type="number" min="0" max="3650" step="1" />
        </label>
        <label class="rw-field">
          <span>到期日（可留空）</span>
          <input v-model="form.maturity_date" type="date" />
        </label>
        <label class="rw-field is-wide">
          <span>备注</span>
          <input v-model="form.notes" type="text" maxlength="500" />
        </label>
      </div>
      <p class="rw-form-hint">预计到期日：{{ maturityPreview }}</p>
      <div class="rw-form-actions">
        <button type="submit" class="rw-button" :disabled="saving">
          {{ saving ? '保存中…' : '保存持仓' }}
        </button>
      </div>
    </form>

    <div v-if="holdings.length === 0" class="rw-empty">
      还没有持仓快照。录入当前每一笔 R2 产品的金额、买入日和期限，才能计算集中度和期限阶梯。
    </div>
    <div v-else class="rw-table-wrap">
      <table class="rw-table">
        <thead>
          <tr>
            <th>产品</th>
            <th class="is-number">金额</th>
            <th>买入</th>
            <th>期限</th>
            <th>到期</th>
            <th>发行方</th>
            <th>风险</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in holdings" :key="item.id">
            <td>
              <strong>{{ item.product_name }}</strong>
              <small v-if="item.product_code">{{ item.product_code }}</small>
            </td>
            <td class="is-number">{{ formatMoney(item.amount, 0) }}</td>
            <td>{{ formatDateShort(item.purchase_date) }}</td>
            <td>{{ termLabel(item.term_days) }}</td>
            <td>
              <span :class="{ 'rw-danger-text': item.maturity_date && item.maturity_date < today }">
                {{ item.maturity_date ? formatDateShort(item.maturity_date) : '—' }}
              </span>
            </td>
            <td>{{ item.issuer || '—' }}</td>
            <td>{{ item.risk_level }}</td>
            <td>
              <div class="rw-row-actions">
                <button type="button" class="rw-link-button" @click="openEdit(item)">编辑</button>
                <button type="button" class="rw-link-button is-danger" @click="remove(item)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
