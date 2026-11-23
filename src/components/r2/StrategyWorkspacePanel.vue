<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { computeStrategy, generateStrategyProposals, generateHoldingExit, saveStrategyCashflow } from '@/api/r2-strategy'
import type { StrategyCashflow, StrategyHoldingRow } from '@/types/r2-strategy'
import type { StrategyWorkspace } from '@/types/r2-strategy'
import type { HoldingReview } from '@/types/dashboard'
import { formatMoney } from '@/composables/useFormatters'

const props = defineProps<{
  workspace: StrategyWorkspace
  section: 'allocation' | 'holdings'
  holdingReviews?: readonly Pick<HoldingReview, 'product_code' | 'product_name'>[]
}>()
const emit = defineEmits<{ refresh: [] }>()
const busy = ref(false)
const message = ref('')
const error = ref('')
const cashflowText = ref('')
watch(() => props.workspace.cashflow_dates, dates => {
  cashflowText.value = (dates ?? []).map(row => `${row.by_date} ${(row.amount_cents / 100).toFixed(2)}`).join('\n')
}, { immediate: true })
async function saveCashflow() {
  if (busy.value) return
  error.value = ''; message.value = ''; busy.value = true
  try {
    const dates: StrategyCashflow[] = cashflowText.value.split('\n').filter(line => line.trim()).map(line => {
      const [by_date, amount, extra] = line.trim().split(/\s+/)
      if (extra || !by_date || !amount || !/^\d+(\.\d{1,2})?$/.test(amount)) throw new Error('每行填写一个付款日和金额，例如 2026-12-01 1000.00')
      return { by_date, amount_cents: Math.round(Number(amount) * 100) }
    })
    await saveStrategyCashflow(dates)
    message.value = '付款日需求已保存，请按最新设置重算。'
    emit('refresh')
  } catch (caught) { error.value = caught instanceof Error ? caught.message : '保存付款日失败' }
  finally { busy.value = false }
}
async function exitHolding(lot: string) {
  if (busy.value) return
  busy.value = true; error.value = ''; message.value = ''
  try {
    const response = await generateHoldingExit(lot, props.workspace.input_fingerprint)
    message.value = response.created.length ? '退出提案已生成，请到决策与评估审阅；采纳后仍需在银行执行。' : '退出提案暂不可生成：' + (response.blockers || ['约束条件待满足']).map(label).join('；')
    emit('refresh')
  } catch (caught) { error.value = caught instanceof Error ? caught.message : '生成退出提案失败' }
  finally { busy.value = false }
}
const result = computed(() => props.workspace.result)
const current = computed(() => props.workspace.contract_matches !== false && !props.workspace.stale && result.value?.input.activation_seq === props.workspace.activation_seq && result.value?.input.mode === props.workspace.mode)
const exitStates = new Set(['exit_required', 'exit_at_open', 'exit_rules_pending'])
const holdingNames = computed(() => {
  const names = new Map<string, string>()
  for (const { product_code, product_name } of props.holdingReviews ?? []) {
    const name = product_name.trim()
    if (name && name !== product_code) names.set(product_code, name)
  }
  return names
})
const holdingProducts = computed(() => {
  const groups = new Map<string, StrategyHoldingRow[]>()
  for (const row of result.value?.monitoring.rows ?? []) {
    const group = groups.get(row.product_code)
    if (group) group.push(row)
    else groups.set(row.product_code, [row])
  }
  return [...groups.values()].map(rows => ({
    row: rows[0],
    exits: rows.filter(row => exitStates.has(row.state)),
    amount: rows.every(row => row.amount != null)
      ? rows.reduce((total, row) => total + Math.round(row.amount! * 100), 0)
      : null,
  }))
})
const stateNames: Record<string, string> = { exit_required: '准备退出', exit_at_open: '锁定中 · 到期核验退出', exit_rules_pending: '退出规则待核', risk_review: '风险复核', hold: '达到续持门槛', simulation_passed: '约束测算通过', pending: '证据或账户待核', no_feasible_full_allocation: '无可行满仓方案' }
const reasons: Record<string, string> = { principal_unavailable: '本金尚未初始化', evidence_unavailable: '公开证据不可用', account_unverified: '账户占用或持仓信息待核', account_invalid: '账户输入异常', account_overcommitted: '持仓及承诺金额超出本金', existing_evidence_single_cap: '存量持仓超出证据层单一上限', existing_evidence_tier_cap: '存量持仓超出证据层合计上限', existing_product_cap: '存量持仓超出单一产品上限', existing_family_cap: '存量持仓超出策略家族上限', liquidity_or_cashflow_conflict: '流动性或近期用款约束冲突', exposure_unverified: '持仓风险敞口待核', settings_invalid: '配置约束待核', cash_needs_invalid: '用款约束待核', allocation_model_limit: '候选规模超出计算限制', screening_not_automatic: '尚未满足自动配置门槛', formal_terms_unverified: '正式期限条款待核', settlement_path_unverified: '申赎到账路径待核', fees_unverified: '费用待核', assets_unverified: '底层资产待核', prohibited_assets_or_unknown: '禁投资产敞口待核', equity_limit_unverified: '权益上限待核', duration_or_distribution_unverified: '久期或期限分布待核', app_availability_unverified: '当日 App 额度待核', allocation_limits_unverified: '起购、递增或集中度依据待核', public_quota_unverified: '公开额度待核', redemption_fee_unverified: '赎回费用待核', redemption_fee_or_arrival_unverified: '赎回费用或资金到账安排待核', redemption_rules_unverified: '赎回条款待核', current_redemption_window_unverified: '当日赎回窗口待核', holding_exit_not_current_plan: '当前批次尚未形成可执行退出计划' }
Object.assign(reasons, {
  capacity_or_increment_gap: '现有约束下，仍有可分配资金无法配置',
  cash_in_transit: '部分资金尚未到账，暂不能用于配置',
  solver_budget_exhausted: '配置测算未在计算时限内完成，请重算',
  allocation_not_verified: '配置金额尚未通过校验，请重算',
  allocation_preferences_not_verified: '配置排序尚未完成校验，请重算',
  candidate_limit: '候选数量超过计算上限',
  duplicate_candidate: '候选产品存在重复记录，需核对公开批次',
  existing_evidence_single_cap: '现有单只产品持仓超过其证据等级允许的上限',
  existing_evidence_tier_cap: '同一证据等级的现有持仓合计超过上限',
  liquidity_or_cashflow_conflict: '当前方案无法同时满足流动性要求和用款安排',
})
function allocationHint(code: string) {
  if (code === 'capacity_or_increment_gap') {
    const allocation = result.value?.allocation
    const gap = allocation ? Math.max(0, allocation.available_cents - allocation.allocated_cents) : null
    return `尚有 ${money(gap)} 可分配资金未配置。可能受可买额度、配置上限、起购或递增金额限制；请结合下方期限占用与候选明细核对。`
  }
  if (code === 'existing_medium_bucket_cap' || code === 'existing_long_bucket_cap') return '具体占用和超出金额见下方期限明细；复核现有持仓及待确认买入后，再重算配置。'
  if (code === 'existing_evidence_tier_cap' || code === 'existing_evidence_single_cap') return '证据等级取决于可核验的业绩历史；请核对持仓匹配的证据等级与集中度限制。'
  if (code === 'liquidity_or_cashflow_conflict') return '请核对付款日、所需金额及产品到账安排；当前配置金额仅供诊断，尚未满足全部约束。'
  if (code === 'cash_in_transit') return '资金到账并完成记账后，重新测算配置。'
  return ''
}
const bucketReasons: Record<string, string> = { existing_medium_bucket_cap: '中期持仓及承诺占用超过组合的 20% 上限', existing_long_bucket_cap: '长期持仓及承诺占用超过组合的 10% 上限' }
const label = (value: string) => reasons[value] || bucketReasons[value] || stateNames[value] || value
type HoldingProduct = (typeof holdingProducts.value)[number]
const holdingColumns = [
  { key: 'product', title: '持仓产品', value: ({ row }: HoldingProduct) => row.product_code },
  { key: 'amount', title: '持仓本金', value: ({ amount }: HoldingProduct) => amount },
  { key: 'yield', title: '近 1 月年化', value: ({ row }: HoldingProduct) => row.yield_1m == null ? null : Number(row.yield_1m) },
  { key: 'date', title: '业绩日', value: ({ row }: HoldingProduct) => row.performance_date || null },
  { key: 'conclusion', title: '复核结论', value: ({ row, exits }: HoldingProduct) => holdingConclusion(row, exits) },
] as const
type HoldingColumn = (typeof holdingColumns)[number]
const holdingSort = ref<{ column: HoldingColumn; direction: 'ascending' | 'descending' }>()
const holdingCollator = new Intl.Collator('zh-CN', { numeric: true })

function holdingConclusion(row: StrategyHoldingRow, exits: StrategyHoldingRow[]) {
  if (exits.length) return '三项退出条件满足 · 准备换出'
  if (row.yield_1m != null && Number(row.yield_1m) < 2.15 && row.exit_conditions) return row.exit_conditions.status === 'pending' ? '退出证据待核 · 观察' : '退出条件未同时满足 · 观察'
  if (row.state === 'evidence_pending') return row.identity ? '缺少有效近 1 月年化' : '未匹配同份额证据'
  if (row.state === 'hold' && row.observation?.state === 'watch') return '收益预警 · 观察'
  return label(row.state)
}

const observationLabels: Record<string, string> = {
  monthly_trend_weak: '连续三个月收益走弱', recent_yield_weak: '近7天收益偏低',
  nav_insufficient: '净值样本不足', valuation_basis_unverified: '估值日规则待核',
  cumulative_unavailable: '缺少累计净值，分红影响待核', calendar_gap: '日历覆盖不足',
  holiday_window: '跨节假日，暂不比较', nav_gap: '披露日或区间端点不完整',
  month_end_missing: '完整月份端点不足', cumulative_conflict: '累计净值存在冲突',
}
const observationLabel = (code?: string | null) => code ? observationLabels[code] || '收益证据待核' : '尚无有效收益证据'
const observationPct = (value?: number) => value == null ? '待核' : `${value.toFixed(2)}%`
const observationReturnPct = (value?: number) => value == null ? '待核' : `${value.toFixed(6)}%`

function sortHoldings(column: HoldingColumn) {
  holdingSort.value = {
    column,
    direction: holdingSort.value?.column.key === column.key && holdingSort.value.direction === 'ascending' ? 'descending' : 'ascending',
  }
}

const sortedHoldingProducts = computed(() => {
  const sort = holdingSort.value
  if (!sort) return holdingProducts.value
  const { column } = sort
  return [...holdingProducts.value].sort((left, right) => {
    const a = column.value(left)
    const b = column.value(right)
    if (a === b) return 0
    if (a == null) return 1
    if (b == null) return -1
    const comparison = typeof a === 'number' && typeof b === 'number'
      ? a - b
      : holdingCollator.compare(String(a), String(b))
    return sort.direction === 'ascending' ? comparison : -comparison
  })
})

const money = (cents: number | null) => cents == null ? '未获取到' : `¥${formatMoney(cents / 100, 2)}`
async function run(kind: 'compute' | 'proposals') {
  if (busy.value) return
  busy.value = true; message.value = ''; error.value = ''
  try {
    if (kind === 'compute') {
      const response = await computeStrategy(props.workspace.input_fingerprint)
      message.value = response.pending ? '重算任务已排队，请稍后读取最新状态。' : '策略快照已重算。'
    } else {
      const response = await generateStrategyProposals(props.workspace.input_fingerprint)
      message.value = response.created.length ? `已生成或复用 ${response.created.length} 条提案，请到决策与评估审阅。` : '当前未生成提案，请先解除约束冲突或补齐公开证据。'
    }
    emit('refresh')
  } catch (caught) { error.value = caught instanceof Error ? caught.message : '操作失败，请重试' }
  finally { busy.value = false }
}
</script>

<template>
  <section class="rw-panel strategy-workspace" data-testid="strategy-workspace" :aria-label="section === 'allocation' ? 'v9 资金配置' : 'v9 持仓监控'">
    <div class="strategy-heading">
      <div><h2>{{ section === 'allocation' ? '当前策略资金配置' : '持仓产品复核' }}</h2><p>v9 · 激活序号 {{ workspace.activation_seq }} · 业务日 {{ workspace.business_date }} · 公开批次 {{ workspace.run_id == null ? '未获取到' : `#${workspace.run_id}` }}</p></div>
      <div class="strategy-actions">
        <button type="button" class="button button-ghost button-small" :disabled="busy" @click="emit('refresh')">读取最新状态</button>
        <button type="button" class="button button-primary button-small" :disabled="busy" @click="run('compute')">{{ busy ? '处理中…' : '重算当前策略' }}</button>
      </div>
    </div>
    <p v-if="error" class="rw-alert is-warn" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="workspace.source_issue" class="rw-alert is-warn">公开证据异常：{{ workspace.source_issue }}</p>
    <p v-if="!result" class="rw-alert is-warn" role="status">尚无策略快照，请重算当前策略。完成之前不显示确定金额建议。</p>
    <p v-else-if="!current" class="rw-alert is-warn" role="status">账户、公开证据或策略已变化，以下为上次快照，不能据此执行；请重算当前策略。</p>
    <details v-if="section === 'allocation' && workspace.cashflow_dates !== undefined">
      <summary>按付款日设置现金需求</summary>
      <ul v-if="workspace.cash_needs?.length">
        <li v-for="(need, index) in workspace.cash_needs" :key="index">{{ need.by_date }} · 累计 {{ money(need.required_cents) }}{{ need.basis === 'legacy_window_end' ? '（旧区间估算）' : '' }}</li>
      </ul>
      <form @submit.prevent="saveCashflow">
        <label class="strategy-cashflow">每行填写付款日和金额（元）。保存后以此列表为准，空列表表示无待付款需求。
          <textarea v-model="cashflowText" rows="3" placeholder="2026-12-01 1000.00" />
        </label>
        <button type="submit" class="button button-primary button-small" :disabled="busy">保存现金需求</button>
      </form>
    </details>
    <template v-if="result && section === 'allocation'">
      <h3>{{ label(result.allocation.status) }}{{ !current ? '（旧快照）' : '' }}</h3>
      <dl class="strategy-amounts">
        <div><dt>{{ result.allocation.external_principal_cents === undefined ? '组合本金（旧口径）' : '本金＋已到账收益' }}</dt><dd>{{ money(result.allocation.principal_cents) }}</dd></div>
        <template v-if="result.allocation.external_principal_cents !== undefined">
          <div><dt>自己投入的钱</dt><dd>{{ money(result.allocation.external_principal_cents) }}</dd></div>
          <div><dt>赎回收益（已到账）</dt><dd>{{ money(result.allocation.settled_realized_pnl_cents ?? null) }}</dd></div>
        </template>
        <div><dt>持仓及承诺占用</dt><dd>{{ money(result.allocation.committed_cents) }}</dd></div>
        <div><dt>可分配资金</dt><dd>{{ money(result.allocation.available_cents) }}</dd></div>
        <div><dt>本次配置金额</dt><dd>{{ money(result.allocation.allocated_cents) }}</dd></div>
        <div><dt>未分配金额</dt><dd>{{ money(result.allocation.unallocated_cents) }}</dd></div>
      </dl>
      <div v-if="result.allocation.blockers.length" class="strategy-blockers" role="status">
        <p><strong>配置前需处理以下事项</strong></p>
        <ul><li v-for="item in result.allocation.blockers" :key="item">
          {{ label(item) }}
          <p v-if="allocationHint(item)" class="strategy-blocker-hint">{{ allocationHint(item) }}</p>
        </li></ul>
      </div>
      <ul v-if="result.allocation.bucket_limits">
        <li v-for="(limit, bucket) in result.allocation.bucket_limits" :key="bucket">
          {{ bucket === 'medium' ? '中期' : '长期' }}上限 {{ money(limit.limit_cents) }}，实际持仓 {{ money(limit.actual_cents) }}，含承诺占用 {{ money(limit.occupied_cents) }}，
          {{ limit.excess_cents ? '超出 ' + money(limit.excess_cents) : '剩余 ' + money(limit.remaining_cents) }}
        </li>
      </ul>
      <details v-if="result.allocation.liquidity_coverage?.length">
        <summary>未来 7／30／90 天到账覆盖</summary>
        <ul>
          <li v-for="row in result.allocation.liquidity_coverage" :key="row.days">
            {{ row.days }} 天（{{ row.by_date }}）：可用现金 {{ money(row.free_cash_cents) }}，已核验计划到账 {{ money(row.verified_arrival_cents) }}，到账日待核 {{ money(row.unknown_arrival_cents) }}
          </li>
        </ul>
      </details>
      <p>配置测算基于公开数据与账户现状；近 1 月年化用于准入和排序，测算结果不代表未来收益。</p>
      <div v-if="result.allocation.rows.length" class="strategy-table-wrap"><table><thead><tr><th>销售份额 / 渠道</th><th>组内排名</th><th>配置金额</th></tr></thead><tbody>
        <tr v-for="row in result.allocation.rows" :key="`${row.identity.channel}:${row.identity.code}`"><td>{{ row.identity.code }} / {{ row.identity.channel }}</td><td>{{ row.rank }}</td><td>{{ money(row.amount_cents) }}</td></tr>
      </tbody></table></div>
      <p v-else>尚无可分配份额；可先到候选初筛选择公开份额。</p>
      <div class="strategy-actions"><button type="button" class="button button-primary button-small" :disabled="busy || !current || !result.may_generate_buy_proposals" @click="run('proposals')">生成买入提案</button><RouterLink :to="{ name: 'r2-evaluation', query: { section: 'proposals' } }">审阅提案</RouterLink></div>
    </template>
    <template v-else-if="result">
      <p>近7日总收益率低于0.04123288%、近1月年化低于2.15%，且近6月年化&gt;近3月年化&gt;近1月年化，三项同时满足后生成退出决策提案，按可赎窗口处理。2.15%至不足2.5%且收益走弱时优先观察。缺少有效证据的产品暂停新增或加仓。</p>
      <div v-if="holdingProducts.length" class="strategy-table-wrap">
          <table class="strategy-holdings-table">
            <thead>
              <tr>
                <th v-for="column in holdingColumns" :key="column.key" scope="col"
                  :aria-sort="holdingSort?.column.key === column.key ? holdingSort.direction : undefined">
                  <button type="button" class="strategy-holding-sort" @click="sortHoldings(column)">
                    {{ column.title }}
                    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor">
                      <path v-if="holdingSort?.column.key !== column.key || holdingSort.direction === 'ascending'" d="M2 5l4-3 4 3" />
                      <path v-if="holdingSort?.column.key !== column.key || holdingSort.direction === 'descending'" d="M2 7l4 3 4-3" />
                    </svg>
                  </button>
                </th>
                <th scope="col">处理</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="{ row, exits, amount } in sortedHoldingProducts" :key="row.product_code">
                <th scope="row">
                  {{ row.product_code }}
                  <small v-if="holdingNames.has(row.product_code)" class="strategy-holding-name">{{ holdingNames.get(row.product_code) }}</small>
                </th>
                <td>{{ money(amount) }}</td>
                <td>{{ row.yield_1m == null ? '未获取到' : `${row.yield_1m}%` }}<small v-if="row.yield_1m != null && row.state === 'evidence_pending'">待核</small></td>
                <td>{{ row.performance_date || '未获取到' }}</td>
                <td>
                  <span :class="{ 'strategy-observation-watch': row.observation?.state === 'watch' }">{{ holdingConclusion(row, exits) }}</span>
                  <small v-if="row.observation?.state === 'watch'">{{ row.observation.reasons.map(observationLabel).join('；') }}。仅观察。</small>
                  <details v-if="row.exit_conditions" class="strategy-observation">
                    <summary>查看三项退出条件</summary>
                    <small>三项需同时满足；等于阈值或窗口年化相等不触发。</small>
                    <small>近7日总收益率：{{ row.exit_conditions.recent == null ? '待核' : `${observationReturnPct(row.exit_conditions.recent.return_pct)}（${row.exit_conditions.recent.start_date} 至 ${row.exit_conditions.recent.end_date}）` }}；退出阈值 &lt;0.04123288%</small>
                    <small>近1月年化：{{ row.yield_1m == null ? '待核' : `${row.yield_1m}%` }}；退出阈值 &lt;2.15%</small>
                    <small>近6月 / 近3月 / 近1月年化：{{ ['6m', '3m', '1m'].map(key => row.exit_conditions?.performance[key] == null ? '待核' : `${row.exit_conditions.performance[key]}%`).join(' / ') }}；须依次严格下降。</small>
                    <small>{{ row.summary }}</small>
                  </details>
                  <details v-if="row.observation" class="strategy-observation">
                    <summary>查看收益证据</summary>
                    <template v-if="row.observation.metrics?.recent.status === 'available'">
                      <small>{{ row.observation.metrics.recent.start_date }} 至 {{ row.observation.metrics.recent.end_date }}（{{ row.observation.metrics.recent.days }}个自然日）</small>
                      <small>7日涨跌幅 {{ observationReturnPct(row.observation.metrics.recent.return_pct) }}</small>
                      <small v-if="row.observation.recent_return_threshold_pct != null">预警参考线约 {{ observationPct(row.observation.recent_return_threshold_pct) }}（精确按2.15%×7÷365计算）</small>
                      <small>区间年化 {{ observationPct(row.observation.metrics.recent.annualized_pct) }}，仅供参考</small>
                      <small>{{ row.observation.metrics.recent.interval_count }}个披露区间：零收益{{ row.observation.metrics.recent.zero_count }}次，负收益{{ row.observation.metrics.recent.negative_count }}次</small>
                      <small>零、负收益次数仅作展示，不单独触发预警。</small>
                    </template>
                    <small v-else>近7天：{{ observationLabel(row.observation.metrics?.recent.reason) }}</small>
                    <template v-if="row.observation.metrics?.trend.status === 'available'">
                      <small>完整月份年化（按实际天数折算）：</small>
                      <small v-for="period in row.observation.metrics.trend.periods" :key="period.end_date">{{ period.start_date }} 至 {{ period.end_date }}：{{ observationPct(period.annualized_pct) }}</small>
                    </template>
                    <small v-else>月度趋势：{{ observationLabel(row.observation.metrics?.trend.reason) }}</small>
                    <small>按累计净值变化与期初单位净值计算，含分红影响；短期年化仅供观察，不预测未来收益。</small>
                  </details>
                </td>
                <td>
                  <details v-if="exits.length" class="strategy-exit">
                    <summary>查看赎回安排</summary>
                    <ul>
                      <li v-for="exit in exits" :key="exit.lot_id">
                        <span>{{ exit.amount == null ? exit.lot_id : money(Math.round(exit.amount * 100)) }} · {{ label(exit.state) }}</span>
                        <small v-if="exit.redemption?.earliest_redeem_date">最早赎回日 {{ exit.redemption.earliest_redeem_date }}</small>
                        <button v-if="exit.state === 'exit_required'" class="button button-ghost button-small" type="button"
                          :disabled="busy || !current" @click="exitHolding(exit.lot_id)">生成退出提案</button>
                      </li>
                    </ul>
                    <RouterLink :to="{ name: 'r2-products', query: { section: 'screening' } }">查看候选产品</RouterLink>
                  </details>
                  <span v-else>—</span>
                </td>
              </tr>
            </tbody>
          </table>
      </div>
      <p v-else>当前没有已确认持仓。</p>
    </template>
  </section>
</template>

<style scoped>
.strategy-workspace { padding: 20px; font-size: 13px; min-width: 0; }
.strategy-heading { display: flex; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: 16px; }
h2 { font-size: 19px; margin: 0; } h3 { font-size: 15px; margin: 20px 0 12px; }
p { color: var(--ink-soft); line-height: 1.6; overflow-wrap: anywhere; }
.strategy-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.strategy-cashflow { display: grid; gap: 8px; margin: 10px 0; max-width: 520px; }
.strategy-cashflow textarea { box-sizing: border-box; width: 100%; padding: 8px; font: inherit; color: inherit; background: transparent; border: 1px solid currentColor; border-radius: 6px; }
.strategy-amounts { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 16px; margin: 20px 0; }
dt { color: var(--ink-soft); font-size: 12px; } dd { margin: 5px 0 0; font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; }
.strategy-blockers { color: var(--warning-ink); line-height: 1.8; font-size: 13px; }
.strategy-blockers > p { margin-bottom: 6px; }
.strategy-blockers li + li { margin-top: 10px; }
.strategy-blocker-hint { margin: 2px 0 0; max-width: 75ch; font-size: 13px; line-height: 1.6; }
.strategy-exit summary { cursor: pointer; }
.strategy-observation { margin-top: 6px; font-size: 12px; }
.strategy-observation summary { cursor: pointer; color: var(--green-deep); }
.strategy-observation-watch { color: var(--warning-ink); font-weight: 650; }
.strategy-exit ul { padding-left: 16px; }
.strategy-exit li + li { margin-top: 8px; }
.strategy-exit button { display: block; margin-top: 4px; }
.strategy-table-wrap { width: 100%; overflow-x: auto; margin: 16px 0; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 12px 10px; text-align: left; border-bottom: 1px solid var(--line); font-size: 13px; min-width: 100px; }
th { color: var(--ink-soft); font-size: 12px; } small { display: block; font-size: 12px; color: var(--ink-soft); margin-top: 4px; }
.strategy-holdings-table { table-layout: fixed; min-width: 900px; overflow-wrap: anywhere; }
.strategy-holdings-table th,
.strategy-holdings-table td { vertical-align: top; }
.strategy-holdings-table thead th:first-child { width: 20%; }
.strategy-holdings-table thead th:nth-child(n + 2):nth-child(-n + 4) { width: 12%; }
.strategy-holdings-table thead th:nth-child(5) { width: 20%; }
.strategy-holding-name { font-weight: 400; }
.strategy-holding-sort {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.strategy-holding-sort svg { flex: none; }
.strategy-holding-sort:hover,
.strategy-holdings-table th[aria-sort] .strategy-holding-sort { color: var(--green-deep); }
.strategy-holding-sort:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; }
a { color: var(--green-deep); } a:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; }
</style>
