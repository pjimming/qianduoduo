<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import type {
  AutomationWorkspace,
  DecisionEntry,
  DecisionInput,
  DecisionRating,
  TradeTransaction,
} from '@/types/dashboard'

const props = defineProps<{
  decisions: DecisionEntry[]
  today: string
  trades: TradeTransaction[]
  automation: AutomationWorkspace
}>()

const store = useDashboardStore()
const { show } = useToast()

const actions: Array<DecisionInput['action']> = ['买入', '赎回', '切换', '观察']
const ratings: DecisionRating[] = [
  '待评估',
  '流程正确，结果好',
  '流程正确，结果差',
  '流程错误，结果好',
  '流程错误，结果差',
]

const formOpen = ref(false)
const editingId = ref<number | null>(null)
const saving = ref(false)
const form = reactive<DecisionInput>(emptyForm())
const target3Locked = computed(() => /r2-3pct|target3/i.test(form.strategy_version))

watch(
  () => form.strategy_version,
  (value) => {
    if (!/r2-3pct|target3/i.test(value)) return
    form.target_annualized = 3
    form.bucket_plan.short = 30
    form.bucket_plan.medium = 35
    form.bucket_plan.long = 35
  },
)

const stats = computed(() => {
  const currentMonth = props.today.slice(0, 7)
  return {
    thisMonth: props.decisions.filter((item) => item.date.startsWith(currentMonth)).length,
    pending: props.decisions.filter((item) => item.rating === '待评估').length,
    pendingEvaluations: props.automation.pending_evaluations.length,
    wrongGood: props.decisions.filter((item) => item.rating === '流程错误，结果好').length,
    rightBad: props.decisions.filter((item) => item.rating === '流程正确，结果差').length,
  }
})

function emptyForm(): DecisionInput {
  return {
    date: props.today,
    product_name: '',
    action: '买入',
    reason: '',
    expectation: '',
    actual_result: '',
    strategy_version: 'r2-3pct-v1',
    target_annualized: 3,
    bucket_plan: { short: 30, medium: 35, long: 35, max_single: 30 },
    evaluation_at: ['buy_day', 'holding', 'maturity'],
    evidence_date: '',
    verify_date: '',
    review_meta: {},
    rating: '待评估',
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

function openEdit(item: DecisionEntry): void {
  editingId.value = item.id
  Object.assign(form, {
    date: item.date,
    product_name: item.product_name,
    action: item.action,
    reason: item.reason,
    expectation: item.expectation,
    actual_result: item.actual_result,
    strategy_version: item.strategy_version,
    target_annualized: item.target_annualized,
    bucket_plan: { ...item.bucket_plan },
    evaluation_at: [...item.evaluation_at],
    evidence_date: item.evidence_date,
    verify_date: item.verify_date,
    review_meta: { ...item.review_meta },
    rating: item.rating,
  })
  formOpen.value = true
}

async function save(): Promise<void> {
  if (!form.product_name.trim()) {
    show('请填写产品名称', { error: true })
    return
  }
  if (!form.reason.trim()) {
    show('请填写当时的理由', { error: true })
    return
  }
  saving.value = true
  try {
    if (editingId.value !== null) {
      await store.updateDecision(editingId.value, { ...form })
      show('决策记录已更新')
    } else {
      await store.createDecision({ ...form })
      show('决策记录已保存')
    }
    formOpen.value = false
    resetForm()
  } catch (error) {
    show(error instanceof Error ? error.message : '保存失败', { error: true })
  } finally {
    saving.value = false
  }
}

async function remove(item: DecisionEntry): Promise<void> {
  if (!window.confirm(`删除「${item.product_name}」在 ${item.date} 的决策记录？`)) return
  try {
    await store.deleteDecision(item.id)
    show('决策记录已删除')
  } catch (error) {
    show(error instanceof Error ? error.message : '删除失败', { error: true })
  }
}

function ratingClass(rating: DecisionRating): string {
  if (rating === '流程正确，结果好') return 'is-good'
  if (rating === '流程正确，结果差') return 'is-neutral'
  if (rating === '流程错误，结果好') return 'is-warn'
  if (rating === '流程错误，结果差') return 'is-bad'
  return 'is-pending'
}

function actionClass(action: DecisionInput['action']): string {
  if (action === '买入') return 'is-buy'
  if (action === '赎回') return 'is-redeem'
  if (action === '切换') return 'is-switch'
  return 'is-none'
}

function linkedTrades(id: number): TradeTransaction[] {
  return props.trades.filter((trade) => trade.decision_id === id)
}

function decisionRuns(id: number) {
  return props.automation.runs.filter((run) => run.decision_id === id)
}

function latestRun(id: number) {
  return decisionRuns(id)[0] || {
    id: 0,
    stage: 'buy_day',
    status: 'pending',
    confidence: 0,
    rating: '待评估' as DecisionRating,
    summary: '',
  }
}

function hasRun(id: number): boolean {
  return decisionRuns(id).length > 0
}

function stageLabel(stage: string): string {
  return { buy_day: '买入日', holding: '持有期', maturity: '到期/赎回' }[stage] || stage
}

function statusLabel(status: string): string {
  return {
    pending: '待确认',
    auto: '自动写入',
    confirmed: '人工确认',
    undone: '已撤销',
  }[status] || status
}

function reviewMetaRows(item: DecisionEntry): Array<{ label: string; value: string }> {
  const meta = item.review_meta || {}
  const rows: Array<{ label: string; value: string }> = []
  if (meta.candidate_name) {
    rows.push({ label: '候选', value: String(meta.candidate_name) })
  }
  if (meta.snapshot_date) {
    rows.push({ label: '快照', value: String(meta.snapshot_date) })
  }
  if (meta.break_even_yield_pct !== undefined && meta.break_even_yield_pct !== null) {
    rows.push({
      label: '盈亏平衡',
      value: `${Number(meta.break_even_yield_pct).toFixed(2)}%`,
    })
  }
  if (meta.difference !== undefined) {
    rows.push({
      label: '预计多赚',
      value: `¥${Number(meta.difference).toFixed(2)}`,
    })
  }
  if (meta.min_gain_amount !== undefined) {
    rows.push({
      label: '门槛',
      value: `¥${Number(meta.min_gain_amount).toFixed(2)}`,
    })
  }
  return rows
}
</script>

<template>
  <div class="rw-panel-body">
    <div class="rw-toolbar">
      <div class="rw-card-heading">
        <p class="kicker">DECISIONS</p>
        <strong class="rw-panel-title">决策日志</strong>
        <p class="rw-panel-sub">
          记录当时的理由、预期和失效条件；事后评价区分流程与结果。
        </p>
      </div>
      <div class="rw-toolbar-actions">
        <button type="button" class="rw-button" @click="openCreate">新增决策</button>
      </div>
    </div>

    <div class="rw-stat-row rw-stat-row-spaced">
      <span class="rw-stat-chip">本月决策 <strong>{{ stats.thisMonth }}</strong></span>
      <span class="rw-stat-chip">待评估 <strong>{{ stats.pending }}</strong></span>
      <span class="rw-stat-chip" :class="{ 'is-warn': stats.pendingEvaluations > 0 }">
        待确认评估 <strong>{{ stats.pendingEvaluations }}</strong>
      </span>
      <span class="rw-stat-chip" :class="{ 'is-warn': stats.wrongGood > 0 }">
        流程错误结果好 <strong>{{ stats.wrongGood }}</strong>
      </span>
      <span class="rw-stat-chip">流程正确结果差 <strong>{{ stats.rightBad }}</strong></span>
    </div>

    <form v-if="formOpen" class="rw-form" @submit.prevent="save">
      <div class="rw-form-head">
        <strong>{{ editingId === null ? '记录一次决策' : '修改决策记录' }}</strong>
        <button type="button" class="rw-link-button" @click="formOpen = false; resetForm()">
          取消
        </button>
      </div>
      <div class="rw-form-grid">
        <label class="rw-field">
          <span>日期</span>
          <input v-model="form.date" type="date" required />
        </label>
        <label class="rw-field">
          <span>产品名称</span>
          <input v-model="form.product_name" type="text" maxlength="100" required />
        </label>
        <label class="rw-field">
          <span>动作</span>
          <select v-model="form.action">
            <option v-for="action in actions" :key="action" :value="action">{{ action }}</option>
          </select>
        </label>
        <label class="rw-field">
          <span>事后评价</span>
          <select v-model="form.rating">
            <option v-for="rating in ratings" :key="rating" :value="rating">{{ rating }}</option>
          </select>
        </label>
        <label class="rw-field">
          <span>策略版本</span>
          <input v-model="form.strategy_version" type="text" maxlength="60" />
        </label>
        <label class="rw-field">
          <span>目标年化（%）</span>
          <input
            v-model.number="form.target_annualized"
            type="number"
            min="0.1"
            max="20"
            step="0.1"
            :disabled="target3Locked"
          />
        </label>
        <label class="rw-field">
          <span>证据日期</span>
          <input v-model="form.evidence_date" type="date" />
        </label>
        <label class="rw-field">
          <span>事后验证日期</span>
          <input v-model="form.verify_date" type="date" />
        </label>
        <label class="rw-field">
          <span>短桶目标（%，0–30 天）</span>
          <input
            v-model.number="form.bucket_plan.short"
            type="number"
            min="0"
            max="100"
            step="1"
            :disabled="target3Locked"
          />
        </label>
        <label class="rw-field">
          <span>中桶目标（%，31–100 天）</span>
          <input
            v-model.number="form.bucket_plan.medium"
            type="number"
            min="0"
            max="100"
            step="1"
            :disabled="target3Locked"
          />
        </label>
        <label class="rw-field">
          <span>长桶目标（%，100 天以上）</span>
          <input
            v-model.number="form.bucket_plan.long"
            type="number"
            min="0"
            max="100"
            step="1"
            :disabled="target3Locked"
          />
        </label>
        <label class="rw-field">
          <span>单只上限（%）</span>
          <input v-model.number="form.bucket_plan.max_single" type="number" min="0" max="100" step="1" />
        </label>
        <p class="rw-form-hint is-wide">
          本项目日开新增额度固定为 0%；`r2-3pct-v1` / target3 固定为短期 30% / 中期 35% / 长期 35%。
          现有日开持仓只作为真实持仓事实保留，按赎回规则迁移。
        </p>
        <label class="rw-field is-wide">
          <span>当时的理由</span>
          <textarea
            v-model="form.reason"
            rows="2"
            maxlength="1000"
            placeholder="为什么会做这笔操作？看到了什么证据？"
            required
          ></textarea>
        </label>
        <label class="rw-field is-wide">
          <span>预期（收益 / 流动性 / 风险）</span>
          <textarea
            v-model="form.expectation"
            rows="2"
            maxlength="1000"
            placeholder="例如：持有到期年化 2.9%，90 天后可用，最大回撤可接受"
          ></textarea>
        </label>
        <label class="rw-field is-wide">
          <span>实际结果</span>
          <textarea
            v-model="form.actual_result"
            rows="2"
            maxlength="1000"
            placeholder="可以事后补充：实际收益、到账情况、是否偏离预期"
          ></textarea>
        </label>
      </div>
      <div class="rw-form-actions">
        <button type="submit" class="rw-button" :disabled="saving">
          {{ saving ? '保存中…' : '保存决策' }}
        </button>
      </div>
    </form>

    <div v-if="decisions.length === 0" class="rw-empty">
      还没有决策记录。先记下最近一笔买入、赎回或切换的理由，事后才能区分流程和运气。
    </div>
    <div v-else class="rw-list">
      <article v-for="item in decisions" :key="item.id" class="rw-decision">
        <div class="rw-decision-head">
          <div class="rw-decision-title">
            <strong>{{ item.product_name }}</strong>
            <span class="action-tag" :class="actionClass(item.action)">{{ item.action }}</span>
            <span class="rw-muted">{{ item.date }}</span>
          </div>
          <span class="rw-rating" :class="ratingClass(item.rating)">{{ item.rating }}</span>
        </div>
        <p class="rw-decision-reason">{{ item.reason }}</p>
        <div class="rw-decision-meta">
          <span><em>预期</em>{{ item.expectation || '未填写' }}</span>
          <span><em>结果</em>{{ item.actual_result || '待观察' }}</span>
          <span>
            <em>策略</em>{{ item.strategy_version }} · 目标 {{ item.target_annualized.toFixed(2) }}%
          </span>
          <span v-if="item.evidence_date">
            <em>证据日</em>{{ item.evidence_date }}
          </span>
          <span v-if="item.verify_date">
            <em>验证日</em>{{ item.verify_date }}
          </span>
          <span v-if="Object.keys(item.bucket_plan).length">
            <em>期限桶</em>
            短 {{ item.bucket_plan.short ?? '—' }}% / 中 {{ item.bucket_plan.medium ?? '—' }}% /
            长 {{ item.bucket_plan.long ?? '—' }}% · 单只上限
            {{ item.bucket_plan.max_single ?? 30 }}%
          </span>
        </div>
        <div v-if="reviewMetaRows(item).length" class="rw-decision-review">
          <span class="rw-muted">替换测算</span>
          <span v-for="row in reviewMetaRows(item)" :key="row.label">
            <em>{{ row.label }}</em>{{ row.value }}
          </span>
        </div>
        <div v-if="linkedTrades(item.id).length" class="rw-decision-links">
          <span class="rw-muted">关联交易</span>
          <span
            v-for="trade in linkedTrades(item.id)"
            :key="trade.id"
            class="rw-link-chip"
          >
            #{{ trade.id }} {{ trade.product_code }} ¥{{ trade.amount.toLocaleString('zh-CN') }}
            · {{ trade.status === 'confirmed' ? '已确认' : trade.status === 'pending' ? '待确认' : '已撤销' }}
          </span>
        </div>
        <div v-if="hasRun(item.id)" class="rw-eval-inline">
          <div class="rw-eval-inline-head">
            <span class="rw-type-badge">{{ stageLabel(latestRun(item.id).stage) }}评估</span>
            <span class="rw-muted">
              {{ statusLabel(latestRun(item.id).status) }} · 置信度
              {{ latestRun(item.id).confidence }}%
            </span>
            <span class="rw-rating" :class="ratingClass(latestRun(item.id).rating)">
              {{ latestRun(item.id).rating }}
            </span>
          </div>
          <p>{{ latestRun(item.id).summary }}</p>
        </div>
        <div class="rw-row-actions">
          <button type="button" class="rw-link-button" @click="openEdit(item)">编辑</button>
          <button type="button" class="rw-link-button is-danger" @click="remove(item)">删除</button>
        </div>
      </article>
    </div>
  </div>
</template>
