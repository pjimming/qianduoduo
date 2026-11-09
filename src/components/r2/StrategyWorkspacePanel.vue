<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { computeStrategy, generateStrategyProposals, generateHoldingExit, saveStrategyCashflow } from '@/api/r2-strategy'
import type { StrategyCashflow } from '@/types/r2-strategy'
import type { StrategyWorkspace } from '@/types/r2-strategy'
import { formatMoney } from '@/composables/useFormatters'

const props = defineProps<{ workspace: StrategyWorkspace; section: 'allocation' | 'holdings' }>()
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
const stateNames: Record<string, string> = { exit_required: '准备退出', exit_at_open: '锁定中 · 到期核验退出', exit_rules_pending: '退出规则待核', evidence_pending: '续持证据待核', risk_review: '风险复核', hold: '达到续持门槛', simulation_passed: '约束测算通过', pending: '证据或账户待核', no_feasible_full_allocation: '无可行满仓方案' }
const reasons: Record<string, string> = { principal_unavailable: '本金尚未初始化', evidence_unavailable: '公开证据不可用', account_unverified: '账户占用或持仓信息待核', account_invalid: '账户输入异常', account_overcommitted: '持仓及承诺金额超出本金', existing_evidence_single_cap: '存量持仓超出证据层单一上限', existing_evidence_tier_cap: '存量持仓超出证据层合计上限', existing_product_cap: '存量持仓超出单一产品上限', existing_family_cap: '存量持仓超出策略家族上限', liquidity_or_cashflow_conflict: '流动性或近期用款约束冲突', exposure_unverified: '持仓风险敞口待核', settings_invalid: '配置约束待核', cash_needs_invalid: '用款约束待核', allocation_model_limit: '候选规模超出计算限制', screening_not_automatic: '尚未满足自动配置门槛', formal_terms_unverified: '正式期限条款待核', settlement_path_unverified: '申赎到账路径待核', fees_unverified: '费用待核', assets_unverified: '底层资产待核', prohibited_assets_or_unknown: '禁投资产敞口待核', equity_limit_unverified: '权益上限待核', duration_or_distribution_unverified: '久期或期限分布待核', app_availability_unverified: '当日 App 额度待核', allocation_limits_unverified: '起购、递增或集中度依据待核', public_quota_unverified: '公开额度待核', redemption_fee_unverified: '赎回费用待核', redemption_fee_or_arrival_unverified: '赎回费用或资金到账安排待核', redemption_rules_unverified: '赎回条款待核', current_redemption_window_unverified: '当日赎回窗口待核', holding_exit_not_current_plan: '当前批次尚未形成可执行退出计划' }
const bucketReasons: Record<string, string> = { existing_medium_bucket_cap: '中期占用超过 20%', existing_long_bucket_cap: '长期占用超过 10%' }
const label = (value: string) => reasons[value] || bucketReasons[value] || stateNames[value] || value
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
      <div><h2>{{ section === 'allocation' ? '当前策略资金配置' : '当前策略逐批次复核' }}</h2><p>v9 · 激活序号 {{ workspace.activation_seq }} · 业务日 {{ workspace.business_date }} · 公开批次 {{ workspace.run_id == null ? '未获取到' : `#${workspace.run_id}` }}</p></div>
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
        <div><dt>组合本金</dt><dd>{{ money(result.allocation.principal_cents) }}</dd></div>
        <div><dt>持仓及承诺占用</dt><dd>{{ money(result.allocation.committed_cents) }}</dd></div>
        <div><dt>可分配资金</dt><dd>{{ money(result.allocation.available_cents) }}</dd></div>
        <div><dt>本次配置金额</dt><dd>{{ money(result.allocation.allocated_cents) }}</dd></div>
        <div><dt>未分配金额</dt><dd>{{ money(result.allocation.unallocated_cents) }}</dd></div>
      </dl>
      <ul v-if="result.allocation.blockers.length" class="strategy-blockers"><li v-for="item in result.allocation.blockers" :key="item">{{ label(item) }}</li></ul>
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
      <p>近 1 月有效年化低于 2.15% 时准备退出；证据缺失保持待核。所有银行交易由你确认执行。</p>
      <div v-if="result.monitoring.rows.length" class="strategy-table-wrap"><table><thead><tr><th>账本产品 / 批次</th><th>当前结论</th><th>近 1 月年化</th><th>业绩日</th><th>下次核验</th><th>处理</th></tr></thead><tbody><tr v-for="row in result.monitoring.rows" :key="row.lot_id"><td>{{ row.product_code }}<small>{{ row.lot_id }}</small></td><td>{{ label(row.state) }}<small v-if="row.summary">{{ row.summary }}</small></td><td>{{ row.yield_1m == null ? '未获取到' : `${row.yield_1m}%` }}</td><td>{{ row.performance_date || '未获取到' }}</td><td>{{ row.next_verify_date }}</td><td><button v-if="row.state === 'exit_required'" class="button button-ghost button-small" type="button" :disabled="busy || !current" @click="exitHolding(row.lot_id)">生成退出提案</button></td></tr></tbody></table></div>
      <p v-else>当前没有已确认持仓批次。</p>
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
.strategy-blockers { color: var(--warning-ink); line-height: 1.8; }
.strategy-table-wrap { width: 100%; overflow-x: auto; margin: 16px 0; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 12px 10px; text-align: left; border-bottom: 1px solid var(--line); font-size: 13px; min-width: 100px; }
th { color: var(--ink-soft); font-size: 12px; } small { display: block; font-size: 12px; color: var(--ink-soft); margin-top: 4px; }
a { color: var(--green-deep); } a:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; }
</style>
