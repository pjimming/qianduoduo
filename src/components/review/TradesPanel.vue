<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import { formatDateShort, formatMoney } from '@/composables/useFormatters'
import type {
  DecisionAction,
  DecisionEntry,
  TradeInput,
  TradeOverview,
  TradeStatus,
  TradeTransaction,
  TradeType,
} from '@/types/dashboard'

const props = defineProps<{
  overview: TradeOverview
  decisions: DecisionEntry[]
  today: string
}>()

const store = useDashboardStore()
const { show } = useToast()

interface TradeForm {
  trade_date: string
  confirm_date: string
  trade_type: TradeType
  status: TradeStatus
  product_code: string
  product_name: string
  issuer: string
  risk_level: 'R2' | 'PR2'
  amount: number | null
  settlement_amount: number | null
  shares: number | null
  term_days: string
  maturity_date: string
  target_product_code: string
  target_product_name: string
  target_term_days: string
  target_maturity_date: string
  decision_id: string
  decision_reason: string
  decision_expectation: string
  decision_invalidation_condition: string
  decision_evidence_date: string
  decision_verify_date: string
  notes: string
}

const formOpen = ref(false)
const editingId = ref<number | null>(null)
const saving = ref(false)
const statusFilter = ref<'all' | TradeStatus>('all')
const form = reactive<TradeForm>(emptyForm())

const filteredTrades = computed(() => {
  if (statusFilter.value === 'all') return props.overview.trades
  return props.overview.trades.filter((trade) => trade.status === statusFilter.value)
})

const filters = computed(() => [
  { key: 'all' as const, label: '全部', count: props.overview.trades.length },
  { key: 'pending' as const, label: '待确认', count: props.overview.summary.pending_count },
  {
    key: 'confirmed' as const,
    label: '已确认',
    count: props.overview.summary.confirmed_count,
  },
  {
    key: 'cancelled' as const,
    label: '已撤销',
    count: props.overview.summary.cancelled_count,
  },
])

function emptyForm(type: TradeType = 'buy'): TradeForm {
  return {
    trade_date: props.today,
    confirm_date: '',
    trade_type: type,
    status: 'pending',
    product_code: '',
    product_name: '',
    issuer: '招银理财',
    risk_level: 'R2',
    amount: null,
    settlement_amount: null,
    shares: null,
    term_days: '',
    maturity_date: '',
    target_product_code: '',
    target_product_name: '',
    target_term_days: '',
    target_maturity_date: '',
    decision_id: '',
    decision_reason: '',
    decision_expectation: '',
    decision_invalidation_condition: '',
    decision_evidence_date: props.today,
    decision_verify_date: addDays(props.today, 14),
    notes: '',
  }
}

function resetForm(): void {
  Object.assign(form, emptyForm())
  editingId.value = null
}

function openCreate(type: TradeType = 'buy'): void {
  resetForm()
  Object.assign(form, emptyForm(type))
  formOpen.value = true
}

function openEdit(trade: TradeTransaction): void {
  editingId.value = trade.id
  Object.assign(form, {
    trade_date: trade.trade_date,
    confirm_date: trade.confirm_date || '',
    trade_type: trade.trade_type,
    status: trade.status,
    product_code: trade.product_code,
    product_name: trade.product_name,
    issuer: trade.issuer,
    risk_level: trade.risk_level,
    amount: trade.amount,
    settlement_amount: trade.settlement_amount,
    shares: trade.shares,
    term_days: trade.term_days === null ? '' : String(trade.term_days),
    maturity_date: trade.maturity_date || '',
    target_product_code: trade.target_product_code,
    target_product_name: trade.target_product_name,
    target_term_days:
      trade.target_term_days === null ? '' : String(trade.target_term_days),
    target_maturity_date: trade.target_maturity_date || '',
    decision_id: trade.decision_id === null ? '' : String(trade.decision_id),
    decision_reason: '',
    decision_expectation: '',
    decision_invalidation_condition: '',
    decision_evidence_date: props.today,
    decision_verify_date: addDays(props.today, 14),
    notes: trade.notes,
  })
  formOpen.value = true
}

async function save(): Promise<void> {
  if (!form.product_code.trim() || !form.product_name.trim()) {
    show('请填写产品代码和名称', { error: true })
    return
  }
  const amount = Number(form.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    show('交易金额需要大于 0', { error: true })
    return
  }
  if (
    form.trade_type === 'switch' &&
    (!form.target_product_code.trim() || !form.target_product_name.trim())
  ) {
    show('切换交易需要填写目标产品', { error: true })
    return
  }
  const termRaw = String(form.term_days ?? '').trim()
  const targetTermRaw = String(form.target_term_days ?? '').trim()
  const termDays = termRaw === '' ? null : Number(termRaw)
  const targetTermDays = targetTermRaw === '' ? null : Number(targetTermRaw)
  let decisionId = form.decision_id ? Number(form.decision_id) : null
  let createdDecisionId: number | null = null
  const payload: TradeInput = {
    trade_date: form.trade_date,
    confirm_date: form.confirm_date || null,
    trade_type: form.trade_type,
    status: form.status,
    product_code: form.product_code.trim(),
    product_name: form.product_name.trim(),
    issuer: form.issuer.trim(),
    risk_level: form.risk_level,
    amount,
    settlement_amount:
      form.settlement_amount === null || Number.isNaN(form.settlement_amount)
        ? null
        : Number(form.settlement_amount),
    shares:
      form.shares === null || Number.isNaN(form.shares) ? null : Number(form.shares),
    term_days: termDays,
    maturity_date: form.maturity_date || null,
    target_product_code: form.target_product_code.trim(),
    target_product_name: form.target_product_name.trim(),
    target_term_days: targetTermDays,
    target_maturity_date: form.target_maturity_date || null,
    decision_id: decisionId,
    notes: form.notes.trim(),
  }
  saving.value = true
  try {
    if (decisionId === null) {
      if (!form.decision_reason.trim()) {
        show('请填写交易前的决策理由', { error: true })
        return
      }
      if (!form.decision_expectation.trim()) {
        show('请填写收益、流动性或风险预期', { error: true })
        return
      }
      if (!form.decision_invalidation_condition.trim()) {
        show('请填写什么变化会使这次决策失效', { error: true })
        return
      }
      const targetName =
        form.trade_type === 'switch'
          ? `${form.product_name.trim()} → ${form.target_product_name.trim()}`
          : form.product_name.trim()
      const created = await store.createDecision({
        date: form.trade_date,
        product_name: targetName,
        action: decisionAction(form.trade_type),
        reason: form.decision_reason.trim(),
        expectation: form.decision_expectation.trim(),
        invalidation_condition: form.decision_invalidation_condition.trim(),
        actual_result: '',
        strategy_version: 'r2-3pct-v1',
        target_annualized: 3,
        bucket_plan: { short: 30, medium: 35, long: 35, max_single: 30 },
        evaluation_at: ['buy_day', 'holding', 'maturity'],
        evidence_date: form.decision_evidence_date || form.trade_date,
        verify_date: form.decision_verify_date || addDays(form.trade_date, 14),
        review_meta: {
          source: 'trade-predecision',
          product_code: form.product_code.trim(),
        },
        rating: '待评估',
      })
      createdDecisionId = created.decision.id
      decisionId = created.decision.id
      payload.decision_id = decisionId
    }
    if (editingId.value === null) {
      await store.createTrade(payload)
      show(`交易已保存，并关联决策 #${decisionId}`)
    } else {
      await store.updateTrade(editingId.value, payload)
      show(`交易已更新，并关联决策 #${decisionId}`)
    }
    formOpen.value = false
    resetForm()
  } catch (error) {
    const message = error instanceof Error ? error.message : '保存失败'
    show(
      createdDecisionId !== null
        ? `决策 #${createdDecisionId} 已保存，但交易未保存：${message}`
        : message,
      { error: true, duration: createdDecisionId !== null ? 8000 : undefined },
    )
  } finally {
    saving.value = false
  }
}

async function confirmTrade(trade: TradeTransaction): Promise<void> {
  const value = window.prompt(
    `确认「${trade.product_name}」的确认日期（YYYY-MM-DD）`,
    trade.confirm_date || (trade.trade_date <= props.today ? props.today : trade.trade_date),
  )
  if (!value) return
  try {
    await store.confirmTrade(trade.id, value)
    show('交易已确认，持仓已更新')
  } catch (error) {
    show(error instanceof Error ? error.message : '确认失败', { error: true })
  }
}

async function cancelTrade(trade: TradeTransaction): Promise<void> {
  if (!window.confirm(`撤销「${trade.product_name}」这笔交易？原始记录会保留为已撤销。`)) {
    return
  }
  try {
    await store.cancelTrade(trade.id, '页面撤销')
    show('交易已撤销')
  } catch (error) {
    show(error instanceof Error ? error.message : '撤销失败', { error: true })
  }
}

function typeLabel(type: TradeType): string {
  return { buy: '买入', redeem: '赎回', switch: '切换' }[type]
}

function statusLabel(status: TradeStatus): string {
  return { pending: '待确认', confirmed: '已确认', cancelled: '已撤销' }[status]
}

function statusClass(status: TradeStatus): string {
  return {
    pending: 'is-pending',
    confirmed: 'is-confirmed',
    cancelled: 'is-cancelled',
  }[status]
}

function sourceLabel(source: string): string {
  return {
    migration: '持仓迁移',
    inbox: '收件箱',
    manual: '手工录入',
    'holding-api': '兼容接口',
  }[source] || source
}

function decisionAction(type: TradeType): DecisionAction {
  return ({ buy: '买入', redeem: '赎回', switch: '切换' } as const)[type]
}

function addDays(date: string, days: number): string {
  const stamp = new Date(`${date}T00:00:00Z`)
  stamp.setUTCDate(stamp.getUTCDate() + days)
  return stamp.toISOString().slice(0, 10)
}
</script>

<template>
  <div class="rw-panel-body">
    <div class="rw-toolbar">
      <div class="rw-card-heading">
        <p class="kicker">TRADES</p>
        <strong class="rw-panel-title">交易流水</strong>
        <p class="rw-panel-sub">
          登记买入、赎回和切换；待确认交易只占额度，确认后才进入持仓、期限桶和收益。
        </p>
      </div>
      <div class="rw-toolbar-actions">
        <button type="button" class="rw-button is-secondary" @click="openCreate('redeem')">
          记赎回
        </button>
        <button type="button" class="rw-button" @click="openCreate('buy')">记一笔交易</button>
      </div>
    </div>

    <div class="rw-stat-row rw-stat-row-spaced">
      <span class="rw-stat-chip">
        待确认 <strong>{{ overview.summary.pending_count }} 笔</strong>
        · 买入占用 ¥{{ formatMoney(overview.summary.pending_buy_amount, 0) }}
      </span>
      <span class="rw-stat-chip">
        未赎回成本本金
        <strong>¥{{ formatMoney(overview.summary.open_principal, 0) }}</strong>
      </span>
      <span class="rw-stat-chip">
        累计已实现盈亏
        <strong>¥{{ formatMoney(overview.summary.realized_pnl, 2) }}</strong>
      </span>
      <span
        class="rw-stat-chip"
        :class="{ 'is-warn': overview.reconciliation.counts.warn > 0 }"
      >
        对账
        <strong>
          {{ overview.reconciliation.counts.warn }} 警告 ·
          {{ overview.reconciliation.counts.info }} 提示
        </strong>
      </span>
    </div>

    <div v-if="overview.reconciliation.items.length" class="rw-alerts">
      <span
        v-for="item in overview.reconciliation.items.slice(0, 8)"
        :key="`${item.code}-${item.trade_id || item.inbox_id}-${item.text}`"
        class="rw-alert"
        :class="`is-${item.level}`"
      >
        {{ item.text }}
      </span>
    </div>

    <form v-if="formOpen" class="rw-form" @submit.prevent="save">
      <div class="rw-form-head">
        <strong>{{ editingId === null ? '登记一笔交易' : '修改交易' }}</strong>
        <button type="button" class="rw-link-button" @click="formOpen = false; resetForm()">
          取消
        </button>
      </div>
      <div class="rw-form-grid">
        <label class="rw-field">
          <span>交易类型</span>
          <select v-model="form.trade_type">
            <option value="buy">买入</option>
            <option value="redeem">赎回</option>
            <option value="switch">切换</option>
          </select>
        </label>
        <label class="rw-field">
          <span>交易日期</span>
          <input v-model="form.trade_date" type="date" required />
        </label>
        <label class="rw-field">
          <span>状态</span>
          <select v-model="form.status">
            <option value="pending">待确认</option>
            <option value="confirmed">已确认</option>
            <option value="cancelled">已撤销</option>
          </select>
        </label>
        <label class="rw-field">
          <span>确认日期（已确认时）</span>
          <input v-model="form.confirm_date" type="date" />
        </label>
        <label class="rw-field">
          <span>产品代码</span>
          <input v-model="form.product_code" type="text" maxlength="50" required />
        </label>
        <label class="rw-field">
          <span>产品名称</span>
          <input v-model="form.product_name" type="text" maxlength="120" required />
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
          <span>{{ form.trade_type === 'buy' ? '买入金额' : '赎回本金（成本口径）' }}</span>
          <input v-model.number="form.amount" type="number" min="0" step="0.01" required />
        </label>
        <label v-if="form.trade_type !== 'buy'" class="rw-field">
          <span>实际到账金额（含损益）</span>
          <input v-model.number="form.settlement_amount" type="number" min="0" step="0.01" />
        </label>
        <label class="rw-field">
          <span>份额（可选）</span>
          <input v-model.number="form.shares" type="number" min="0" step="0.0001" />
        </label>
        <label class="rw-field">
          <span>期限（天，0 = 日开）</span>
          <input v-model="form.term_days" type="number" min="0" max="3650" step="1" />
        </label>
        <label class="rw-field">
          <span>到期日（可留空自动计算）</span>
          <input v-model="form.maturity_date" type="date" />
        </label>
        <label class="rw-field">
          <span>关联决策</span>
          <select v-model="form.decision_id">
            <option value="">新建本次决策（必填）</option>
            <option v-for="item in decisions" :key="item.id" :value="String(item.id)">
              {{ item.date }} · {{ item.product_name }}
            </option>
          </select>
        </label>
        <template v-if="!form.decision_id">
          <label class="rw-field is-wide">
            <span>交易前决策理由</span>
            <textarea
              v-model="form.decision_reason"
              rows="2"
              maxlength="1000"
              placeholder="为什么做这笔操作？依据了哪些已验证事实？"
              required
            ></textarea>
          </label>
          <label class="rw-field is-wide">
            <span>收益 / 流动性 / 风险预期</span>
            <textarea
              v-model="form.decision_expectation"
              rows="2"
              maxlength="1000"
              placeholder="例如：30 天同比较收益多 0.2pp，等待 2 天，预计净多赚 7 元"
              required
            ></textarea>
          </label>
          <label class="rw-field is-wide">
            <span>失效条件</span>
            <textarea
              v-model="form.decision_invalidation_condition"
              rows="2"
              maxlength="1000"
              placeholder="例如：低于期限 hurdle、额度或赎回规则变化、预计净增益低于门槛"
              required
            ></textarea>
          </label>
          <label class="rw-field">
            <span>证据日期</span>
            <input v-model="form.decision_evidence_date" type="date" required />
          </label>
          <label class="rw-field">
            <span>事后验证日期</span>
            <input v-model="form.decision_verify_date" type="date" required />
          </label>
        </template>
        <template v-if="form.trade_type === 'switch'">
          <label class="rw-field">
            <span>目标产品代码</span>
            <input v-model="form.target_product_code" type="text" maxlength="50" />
          </label>
          <label class="rw-field">
            <span>目标产品名称</span>
            <input v-model="form.target_product_name" type="text" maxlength="120" />
          </label>
          <label class="rw-field">
            <span>目标期限（天）</span>
            <input v-model="form.target_term_days" type="number" min="0" max="3650" step="1" />
          </label>
        </template>
        <label class="rw-field is-wide">
          <span>备注</span>
          <input v-model="form.notes" type="text" maxlength="500" />
        </label>
      </div>
      <p class="rw-form-hint">
        新交易必须先选择已有决策或填写本次决策；保存时先写决策，再关联交易。
        赎回按买入批次先进先出匹配；待确认交易不会进入持仓。
      </p>
      <div class="rw-form-actions">
        <button type="submit" class="rw-button" :disabled="saving">
          {{ saving ? '保存中…' : '保存交易' }}
        </button>
      </div>
    </form>

    <div class="rw-filter-row">
      <button
        v-for="filter in filters"
        :key="filter.key"
        type="button"
        class="rw-period-chip"
        :class="{ 'is-active': statusFilter === filter.key }"
        @click="statusFilter = filter.key"
      >
        {{ filter.label }} {{ filter.count }}
      </button>
    </div>

    <div v-if="filteredTrades.length === 0" class="rw-empty">
      没有符合条件的交易。手工记一笔，或把招行成交截图拖到「交易收件箱」。
    </div>
    <div v-else class="rw-table-wrap">
      <table class="rw-table">
        <thead>
          <tr>
            <th>日期</th>
            <th>类型</th>
            <th>产品</th>
            <th class="is-number">交易金额</th>
            <th>状态</th>
            <th>确认日</th>
            <th>到期日</th>
            <th>来源</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="trade in filteredTrades"
            :key="trade.id"
            :class="{ 'rw-row-pending': trade.status === 'pending' }"
          >
            <td>{{ formatDateShort(trade.trade_date) }}</td>
            <td>
              <span class="rw-type-badge">{{ typeLabel(trade.trade_type) }}</span>
            </td>
            <td>
              <strong>{{ trade.product_name }}</strong>
              <small>
                {{ trade.product_code }}
                <template v-if="trade.trade_type === 'switch'">
                  → {{ trade.target_product_name }}（{{ trade.target_product_code }}）
                </template>
              </small>
              <small v-if="trade.allocations.length" class="rw-allocation-text">
                批次匹配：
                <span v-for="allocation in trade.allocations" :key="allocation.id">
                  #{{ allocation.buy_trade_id }} ¥{{ formatMoney(allocation.principal, 0) }}
                  / 已实现盈亏 ¥{{ formatMoney(allocation.realized_pnl, 2) }}
                </span>
              </small>
            </td>
            <td class="is-number">
              {{ formatMoney(trade.amount, 2) }}
              <small v-if="trade.settlement_amount !== null">
                到账 {{ formatMoney(trade.settlement_amount, 2) }}
              </small>
            </td>
            <td>
              <span class="rw-trade-status" :class="statusClass(trade.status)">
                {{ statusLabel(trade.status) }}
              </span>
            </td>
            <td>{{ trade.confirm_date ? formatDateShort(trade.confirm_date) : '—' }}</td>
            <td>{{ trade.maturity_date ? formatDateShort(trade.maturity_date) : '—' }}</td>
            <td>
              <small>{{ sourceLabel(trade.source) }}</small>
            </td>
            <td>
              <div class="rw-row-actions">
                <button
                  v-if="trade.status === 'pending'"
                  type="button"
                  class="rw-link-button"
                  @click="confirmTrade(trade)"
                >
                  确认
                </button>
                <button type="button" class="rw-link-button" @click="openEdit(trade)">
                  编辑
                </button>
                <button
                  v-if="trade.status !== 'cancelled'"
                  type="button"
                  class="rw-link-button is-danger"
                  @click="cancelTrade(trade)"
                >
                  撤销
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
