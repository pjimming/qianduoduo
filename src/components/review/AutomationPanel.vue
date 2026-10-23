<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import { formatDateShort } from '@/composables/useFormatters'
import type {
  AutomationWorkspace,
  DecisionEntry,
  EvaluationRun,
} from '@/types/dashboard'

const props = defineProps<{
  automation: AutomationWorkspace
  decisions: DecisionEntry[]
  today: string
}>()

const store = useDashboardStore()
const { show } = useToast()
const busy = ref(false)
const settingsOpen = ref(false)
const showAllHistory = ref(false)
const settings = reactive({
  target_annualized: props.automation.settings.target_annualized,
  hurdle_short: props.automation.settings.hurdle_short,
  hurdle_medium: props.automation.settings.hurdle_medium,
  hurdle_long: props.automation.settings.hurdle_long,
  liquidity_floor_pct: props.automation.settings.liquidity_floor_pct,
  daily_open_target_pct: 0,
  single_product_cap_pct: props.automation.settings.single_product_cap_pct,
  auto_confidence_threshold: props.automation.settings.auto_confidence_threshold,
  scheduler_minutes: props.automation.settings.scheduler_minutes,
  auto_confirm_reviews: props.automation.settings.auto_confirm_reviews,
})

const currentRuns = computed(() => {
  const seen = new Set<string>()
  return props.automation.runs.filter((run) => {
    if (run.status === 'undone') return false
    const key = `${run.scope}:${run.decision_id ?? run.trade_id ?? 'none'}:${run.stage}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
})

const displayedRuns = computed(() =>
  showAllHistory.value ? props.automation.runs : currentRuns.value,
)

async function runNow(): Promise<void> {
  busy.value = true
  try {
    const result = await store.runAutomation()
    if (result.ok) {
      show(
        `自动化完成：新增评估 ${result.summary?.evaluations_created ?? 0} 条，待处理任务 ${
          result.summary?.pending_jobs ?? 0
        } 项`,
      )
    } else {
      show(result.error || '自动化已跳过本次执行', { error: true })
    }
  } catch (error) {
    show(error instanceof Error ? error.message : '自动化失败', { error: true })
  } finally {
    busy.value = false
  }
}

async function saveSettings(): Promise<void> {
  busy.value = true
  try {
    await store.updateAutomationSettings({ ...settings })
    show('评估与自动化设置已保存')
    settingsOpen.value = false
  } catch (error) {
    show(error instanceof Error ? error.message : '保存失败', { error: true })
  } finally {
    busy.value = false
  }
}

async function applyRun(run: EvaluationRun): Promise<void> {
  if (!canConfirm(run)) {
    show('评估结果尚不明确，请先补齐交易、到账或决策证据', { error: true })
    return
  }
  const rating =
    run.rating === '待评估' && run.outcome !== 'unknown'
      ? window.prompt('请输入最终评价', '流程正确，结果好') || run.rating
      : run.rating
  busy.value = true
  try {
    await store.applyEvaluation(run.id, { rating })
    show('评估已写入决策')
  } catch (error) {
    show(error instanceof Error ? error.message : '写入失败', { error: true })
  } finally {
    busy.value = false
  }
}

async function undoRun(run: EvaluationRun): Promise<void> {
  if (!window.confirm('撤销这条自动评估并恢复决策原评价？')) return
  busy.value = true
  try {
    await store.undoEvaluation(run.id)
    show('评估已撤销，决策已恢复')
  } catch (error) {
    show(error instanceof Error ? error.message : '撤销失败', { error: true })
  } finally {
    busy.value = false
  }
}

async function resolveNotification(id: number): Promise<void> {
  try {
    await store.markNotification(id, 'resolve')
  } catch (error) {
    show(error instanceof Error ? error.message : '操作失败', { error: true })
  }
}

async function readAll(): Promise<void> {
  try {
    await store.markAllNotificationsRead()
    show('提醒已全部标为已读')
  } catch (error) {
    show(error instanceof Error ? error.message : '操作失败', { error: true })
  }
}

async function resolveJob(id: number): Promise<void> {
  try {
    await store.resolveAutomationJob(id, 'done', '页面标记已处理')
    show('任务已标记处理')
  } catch (error) {
    show(error instanceof Error ? error.message : '操作失败', { error: true })
  }
}

function decisionName(id: number | null): string {
  if (!id) return '单产品'
  return props.decisions.find((item) => item.id === id)?.product_name || `决策 #${id}`
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

function confidenceClass(level: string): string {
  return level === 'high' ? 'is-good' : level === 'medium' ? 'is-warn' : 'is-bad'
}

function runMeta(run: EvaluationRun): string {
  return `${stageLabel(run.stage)} · ${run.period} · ${run.rule_version} · 置信度 ${run.confidence}% · 更新 ${formatDateShort(run.updated_at.slice(0, 10))}`
}

function jobLabel(type: string): string {
  return {
    screenshot_review: '截图歧义校正',
    income_screenshot_review: '收益截图复核',
    evaluation_review: '评估人工复核',
    monthly_summary: '月度总结润色',
    quarterly_summary: '季度总结润色',
  }[type] || type
}

function canConfirm(run: EvaluationRun): boolean {
  return run.rating !== '待评估' && run.outcome !== 'unknown'
}

function missingDecisionLabels(run: EvaluationRun): string[] {
  const fields = run.evidence.decision_missing_fields || []
  const labels: Record<string, string> = {
    reason: '决策理由',
    expectation: '收益/流动性预期',
    evidence_date: '证据日期',
    verify_date: '验证日期',
    invalidation_condition: '失效条件',
  }
  return fields.map((field) => labels[field] || field)
}

function conclusionLabel(run: EvaluationRun): string {
  if (run.status === 'undone') return '已撤销'
  if (run.stage === 'buy_day') {
    if (run.process_ok === true) return '流程检查通过'
    if (run.process_ok === false) return '流程检查未通过'
    return '等待流程证据'
  }
  if (run.outcome === 'good') return '结果好'
  if (run.outcome === 'bad') return '结果差'
  return '等待结果证据'
}

function conclusionClass(run: EvaluationRun): string {
  if (run.stage === 'buy_day') {
    if (run.process_ok === true) return 'is-good'
    if (run.process_ok === false) return 'is-warn'
    return 'is-pending'
  }
  if (run.outcome === 'good') return 'is-good'
  if (run.outcome === 'bad') return 'is-bad'
  return 'is-pending'
}

function nextUpdateLabel(run: EvaluationRun): string {
  if (run.evidence.next_update) return run.evidence.next_update
  if (missingDecisionLabels(run).length) return '补齐决策证据后自动重评'
  if ((run.evidence.pending_trade_ids || []).length) {
    return '关联交易确认后自动重评'
  }
  if (run.stage === 'buy_day' && run.process_ok !== null) {
    return '结果评价将在持有期或到期/赎回后更新'
  }
  if (run.stage === 'holding') return '满足本月收益记录样本后重评'
  if (run.stage === 'maturity') return '补齐到账金额后重评'
  return '下一证据到达后自动重评'
}
</script>

<template>
  <div class="rw-panel-body">
    <div class="rw-toolbar">
      <div class="rw-card-heading">
        <p class="kicker">AUTOMATION</p>
        <strong class="rw-panel-title">自动评估</strong>
        <p class="rw-panel-sub">
          买入日只判断流程，持有期和到期/赎回才判断结果。“结果待评估”表示证据还没到，
          不是失败；每次更新都会显示下一次触发条件。
        </p>
      </div>
      <div class="rw-toolbar-actions">
        <button type="button" class="rw-button is-secondary" @click="settingsOpen = !settingsOpen">
          评估设置
        </button>
        <button type="button" class="rw-button" :disabled="busy" @click="runNow">
          {{ busy ? '运行中…' : '立即运行自动化' }}
        </button>
      </div>
    </div>

    <div class="rw-stat-row rw-stat-row-spaced">
      <span class="rw-stat-chip" :class="{ 'is-warn': !automation.scheduler.enabled }">
        调度 <strong>{{ automation.scheduler.enabled ? '运行中' : '已关闭' }}</strong>
      </span>
      <span class="rw-stat-chip" :class="{ 'is-warn': automation.runner?.timedOut }">
        执行边界
        <strong>{{
          automation.runner?.running
            ? '运行中'
            : automation.runner?.timedOut
              ? '上次超时'
              : automation.runner
                ? '就绪'
                : '未检测'
        }}</strong>
      </span>
      <span class="rw-stat-chip">
        待确认评估 <strong>{{ automation.pending_evaluations.length }}</strong>
      </span>
      <span class="rw-stat-chip">
        当前结论 <strong>{{ currentRuns.length }}</strong>
      </span>
      <span class="rw-stat-chip" :class="{ 'is-warn': automation.notifications.some((item) => item.level === 'warn') }">
        未读提醒 <strong>{{ automation.notifications.filter((item) => !item.read_at).length }}</strong>
      </span>
      <span class="rw-stat-chip">
        Codex 队列 <strong>{{ automation.jobs.length }}</strong>
      </span>
      <span class="rw-stat-chip" :title="automation.scheduler.next_run || ''">
        上次运行
        <strong>{{ automation.scheduler.last_run?.finished_at ? formatDateShort(automation.scheduler.last_run.finished_at.slice(0, 10)) : '未运行' }}</strong>
      </span>
    </div>

    <form v-if="settingsOpen" class="rw-form" @submit.prevent="saveSettings">
      <div class="rw-form-head">
        <strong>评估口径与调度</strong>
        <button type="button" class="rw-link-button" @click="settingsOpen = false">收起</button>
      </div>
      <div class="rw-form-grid">
        <label class="rw-field">
          <span>组合目标年化（%）</span>
          <input v-model.number="settings.target_annualized" type="number" min="0.1" max="20" step="0.1" />
        </label>
        <label class="rw-field">
          <span>短期限 hurdle（%）</span>
          <input v-model.number="settings.hurdle_short" type="number" min="0" max="20" step="0.1" />
        </label>
        <label class="rw-field">
          <span>中期限 hurdle（%）</span>
          <input v-model.number="settings.hurdle_medium" type="number" min="0" max="20" step="0.1" />
        </label>
        <label class="rw-field">
          <span>长期限 hurdle（%）</span>
          <input v-model.number="settings.hurdle_long" type="number" min="0" max="20" step="0.1" />
        </label>
        <label class="rw-field">
          <span>短期桶下限（%）</span>
          <input v-model.number="settings.liquidity_floor_pct" type="number" min="0" max="100" step="1" />
        </label>
        <label class="rw-field">
          <span>日开新增额度（固定）</span>
          <input :value="0" type="number" disabled />
        </label>
        <label class="rw-field">
          <span>单只产品上限（%）</span>
          <input v-model.number="settings.single_product_cap_pct" type="number" min="0" max="100" step="1" />
        </label>
        <label class="rw-field">
          <span>自动写入置信度门槛（%）</span>
          <input v-model.number="settings.auto_confidence_threshold" type="number" min="0" max="100" step="1" />
        </label>
        <label class="rw-field">
          <span>本地巡检间隔（分钟）</span>
          <input v-model.number="settings.scheduler_minutes" type="number" min="1" max="1440" step="1" />
        </label>
        <label class="rw-field">
          <span>复盘自动归档</span>
          <select v-model="settings.auto_confirm_reviews">
            <option :value="true">开启</option>
            <option :value="false">关闭</option>
          </select>
        </label>
      </div>
      <p class="rw-form-hint">
        3% 作为组合进取目标，不当作保本承诺；单只到期/赎回按期限 hurdle 判断结果好坏。
        本项目新增日开额度固定为 0%，现有日开持仓只作为迁移事实；流动性由短期 7–30 天桶承担。
        置信度低于门槛时不覆盖手工评价，由 AI/平台继续补充证据。
      </p>
      <div class="rw-form-actions">
        <button type="submit" class="rw-button" :disabled="busy">保存设置</button>
      </div>
    </form>

    <section class="rw-subpanel">
      <div class="rw-subhead">
        <strong>待确认评估</strong>
        <span>证据不足或与手工评价冲突时由 AI/平台继续处理</span>
      </div>
      <div v-if="automation.pending_evaluations.length === 0" class="rw-empty is-compact">
        没有待确认评估。
      </div>
      <div v-else class="rw-eval-list">
        <article v-for="run in automation.pending_evaluations" :key="run.id" class="rw-eval-card">
          <div class="rw-eval-head">
            <strong>{{ decisionName(run.decision_id) }}</strong>
            <span class="rw-type-badge">{{ stageLabel(run.stage) }}</span>
            <span class="rw-rating" :class="confidenceClass(run.confidence_level)">
              置信度 {{ run.confidence }}%
            </span>
            <span class="rw-muted">{{ runMeta(run) }}</span>
          </div>
          <p class="rw-eval-summary">{{ run.summary }}</p>
          <div class="rw-eval-checks">
            <span>流程：{{ run.process_ok === null ? '无法确认' : run.process_ok ? '通过' : '未通过' }}</span>
            <span>结果：{{ run.outcome === 'good' ? '好' : run.outcome === 'bad' ? '差' : '未知' }}</span>
            <span>当前结论：{{ conclusionLabel(run) }}</span>
            <span>下次更新：{{ nextUpdateLabel(run) }}</span>
          </div>
          <div class="rw-row-actions">
            <RouterLink
              v-if="missingDecisionLabels(run).length"
              class="rw-link-button"
              :to="{ name: 'r2-evaluation', hash: '#decisions' }"
            >
              补充决策证据
            </RouterLink>
            <button
              v-if="canConfirm(run)"
              type="button"
              class="rw-link-button"
              :disabled="busy"
              @click="applyRun(run)"
            >
              {{ run.scope === 'trade' ? '确认结果' : '确认写入' }}
            </button>
            <span v-else class="rw-muted">等待交易或结果证据</span>
          </div>
        </article>
      </div>
    </section>

    <section class="rw-subpanel">
      <div class="rw-subhead">
        <div class="rw-subhead-copy">
          <strong>{{ showAllHistory ? '全部审计历史' : '当前评估结论' }}</strong>
          <span>
            {{
              showAllHistory
                ? '包含已撤销和旧规则版本记录，仅用于审计'
                : '每个决策阶段只显示最新一条，避免旧版本重复'
            }}
          </span>
        </div>
        <button
          v-if="automation.runs.length > currentRuns.length"
          type="button"
          class="rw-link-button"
          @click="showAllHistory = !showAllHistory"
        >
          {{
            showAllHistory
              ? `仅看当前结论（${currentRuns.length}）`
              : `显示全部审计历史（${automation.runs.length}）`
          }}
        </button>
      </div>
      <div v-if="displayedRuns.length === 0" class="rw-empty is-compact">还没有评估记录。</div>
      <div v-else class="rw-table-wrap">
        <table class="rw-table">
          <thead>
            <tr>
              <th>评估对象</th>
              <th>阶段</th>
              <th>结论</th>
              <th class="is-number">置信度</th>
              <th>状态</th>
              <th>摘要</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="run in displayedRuns.slice(0, 20)" :key="run.id">
              <td>
                <strong>{{ decisionName(run.decision_id) }}</strong>
                <small>{{ runMeta(run) }}</small>
              </td>
              <td>{{ stageLabel(run.stage) }}</td>
              <td>
                <span class="rw-rating" :class="conclusionClass(run)">{{ conclusionLabel(run) }}</span>
                <small>下次：{{ nextUpdateLabel(run) }}</small>
              </td>
              <td class="is-number">
                <span class="rw-rating" :class="confidenceClass(run.confidence_level)">
                  {{ run.confidence }}%
                </span>
              </td>
              <td>{{ statusLabel(run.status) }}</td>
              <td class="rw-eval-cell">{{ run.summary }}</td>
              <td>
                <button
                  v-if="['auto', 'confirmed'].includes(run.status)"
                  type="button"
                  class="rw-link-button"
                  @click="undoRun(run)"
                >
                  撤销
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div class="rw-automation-grid">
      <section class="rw-subpanel">
        <div class="rw-subhead">
          <strong>提醒与异常</strong>
          <button type="button" class="rw-link-button" @click="readAll">全部已读</button>
        </div>
        <div v-if="automation.notifications.length === 0" class="rw-empty is-compact">
          没有未处理提醒。
        </div>
        <div v-else class="rw-notification-list">
          <article
            v-for="item in automation.notifications"
            :key="item.id"
            class="rw-notification"
            :class="{ 'is-warn': item.level === 'warn', 'is-unread': !item.read_at }"
          >
            <div>
              <strong>{{ item.title }}</strong>
              <p>{{ item.message }}</p>
              <small>{{ item.kind }} · {{ formatDateShort(item.created_at.slice(0, 10)) }}</small>
            </div>
            <button type="button" class="rw-link-button" @click="resolveNotification(item.id)">
              已处理
            </button>
          </article>
        </div>
      </section>

      <section class="rw-subpanel">
        <div class="rw-subhead">
          <strong>Codex 判断队列</strong>
          <span>桌面端未运行时保留，下次继续</span>
        </div>
        <div v-if="automation.jobs.length === 0" class="rw-empty is-compact">
          没有需要判断的任务。
        </div>
        <div v-else class="rw-job-list">
          <article v-for="job in automation.jobs" :key="job.id" class="rw-job">
            <div>
              <strong>{{ jobLabel(job.job_type) }}</strong>
              <small>{{ job.dedupe_key }} · 尝试 {{ job.attempts }} 次</small>
            </div>
            <button type="button" class="rw-link-button" @click="resolveJob(job.id)">
              标记已处理
            </button>
          </article>
        </div>
      </section>
    </div>

    <section class="rw-subpanel">
      <div class="rw-subhead">
        <strong>复盘草稿</strong>
        <span>在“月度五问 / 季度复盘”中采用、修改并确认</span>
      </div>
      <div v-if="automation.drafts.length === 0" class="rw-empty is-compact">
        还没有自动生成的复盘草稿。
      </div>
      <div v-else class="rw-draft-list">
        <article v-for="draft in automation.drafts.slice(0, 8)" :key="draft.id" class="rw-draft">
          <div>
            <strong>{{ draft.content.title || draft.period }}</strong>
            <small>
              {{ draft.period_type === 'monthly' ? '月度' : '季度' }} ·
              {{ draft.status === 'confirmed' ? '已确认' : '待确认' }} ·
              生成于 {{ formatDateShort(draft.generated_at.slice(0, 10)) }}
            </small>
          </div>
          <span class="rw-rating" :class="draft.status === 'confirmed' ? 'is-good' : 'is-pending'">
            {{ draft.status === 'confirmed' ? '已确认' : '草稿' }}
          </span>
        </article>
      </div>
    </section>
  </div>
</template>
