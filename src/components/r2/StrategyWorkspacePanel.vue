<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { computeStrategy, generateStrategyProposals, generateHoldingExit } from '@/api/r2-strategy'
import type { StrategyWorkspace } from '@/types/r2-strategy'
import { formatMoney } from '@/composables/useFormatters'

const props = defineProps<{ workspace: StrategyWorkspace; section: 'allocation' | 'holdings' }>()
const emit = defineEmits<{ refresh: [] }>()
const busy = ref(false)
const message = ref('')
const error = ref('')
async function exitHolding(lot: string) {
  if (busy.value) return
  busy.value = true; error.value = ''; message.value = ''
  try {
    const response = await generateHoldingExit(lot, props.workspace.input_fingerprint)
    message.value = response.created.length ? '退出提案已生成，请到决策与评估审阅；采纳后仍需在银行执行。' : '退出提案暂不可生成：' + (response.blockers || ['复核证据待补齐']).map(label).join('；')
    emit('refresh')
  } catch (caught) { error.value = caught instanceof Error ? caught.message : '生成退出提案失败' }
  finally { busy.value = false }
}
const result = computed(() => props.workspace.result)
const current = computed(() => !props.workspace.stale && result.value?.input.activation_seq === props.workspace.activation_seq && result.value?.input.mode === props.workspace.mode)
const stateNames: Record<string, string> = { exit_required: '准备退出', exit_at_open: '锁定中 · 到期核验退出', exit_rules_pending: '退出规则待核', evidence_pending: '续持证据待核', risk_review: '风险复核', hold: '达到续持门槛', simulation_passed: '约束测算通过', pending: '证据或账户待核', no_feasible_full_allocation: '无可行满仓方案' }
const reasons: Record<string, string> = { principal_unavailable: '本金尚未初始化', evidence_unavailable: '公开证据不可用', account_unverified: '账户占用或持仓信息待核', account_invalid: '账户输入异常', account_overcommitted: '持仓及承诺金额超出本金', exposure_unverified: '持仓风险敞口待核', settings_invalid: '配置约束待核', cash_needs_invalid: '用款约束待核', allocation_model_limit: '候选规模超出计算限制', pretrade_identity_unverified: '同份额身份待核', screening_not_automatic: '尚未满足自动配置门槛', pretrade_incomplete: '交易前事实未核实', pretrade_withdrawn: '交易前复核已撤回', formal_terms_unverified: '正式期限条款待核', settlement_path_unverified: '申赎到账路径待核', fees_unverified: '费用待核', assets_unverified: '底层资产待核', prohibited_assets_or_unknown: '禁投资产敞口待核', equity_limit_unverified: '权益上限待核', duration_or_distribution_unverified: '久期或期限分布待核', app_availability_unverified: '当日 App 额度待核', allocation_limits_unverified: '起购、递增或集中度依据待核', public_quota_unverified: '公开额度待核', redemption_fee_or_arrival_unverified: '赎回费用或资金到账安排待核', redemption_rules_unverified: '赎回条款待核', current_redemption_window_unverified: '当日赎回窗口待核', holding_exit_not_current_plan: '当前批次尚未形成可执行退出计划' }
const label = (value: string) => reasons[value] || stateNames[value] || value
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
      message.value = response.created.length ? `已生成或复用 ${response.created.length} 条提案，请到决策与评估审阅。` : '当前未生成提案，请先补齐复核证据或解除约束冲突。'
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
      <p>配置测算与交易前可执行性分别校验。近 1 月年化用于准入和排序，测算结果不代表未来收益。</p>
      <div v-if="result.allocation.rows.length" class="strategy-table-wrap"><table><thead><tr><th>销售份额 / 渠道</th><th>组内排名</th><th>配置金额</th><th>交易前状态</th><th>核验</th></tr></thead><tbody>
        <tr v-for="row in result.allocation.rows" :key="`${row.identity.channel}:${row.identity.code}`"><td>{{ row.identity.code }} / {{ row.identity.channel }}</td><td>{{ row.rank }}</td><td>{{ money(row.amount_cents) }}</td><td>{{ result.selected_reviews.find(item => item.identity.code === row.identity.code && item.identity.channel === row.identity.channel)?.executable ? '复核通过' : '交易前待核' }}</td><td><RouterLink :to="{ name: 'r2-products', query: { section: 'allocation', channel: row.identity.channel, code: row.identity.code }, hash: '#strategy-review' }">交易前复核</RouterLink></td></tr>
      </tbody></table></div>
      <p v-else>尚无可分配份额；可先到候选初筛选择份额，完成产品映射与交易前复核。</p>
      <ul v-for="review in result.selected_reviews.filter(item => item.blockers.length)" :key="`${review.identity.channel}:${review.identity.code}`"><li>{{ review.identity.code }}：{{ review.blockers.map(label).join('；') }}</li></ul>
      <div class="strategy-actions"><button type="button" class="button button-primary button-small" :disabled="busy || !current || !result.may_generate_buy_proposals" @click="run('proposals')">生成买入提案</button><RouterLink :to="{ name: 'r2-evaluation', query: { section: 'proposals' } }">审阅提案</RouterLink></div>
    </template>
    <template v-else-if="result">
      <p>近 1 月有效年化低于 2.15% 时准备退出；证据缺失保持待核。所有银行交易由你确认执行。</p>
      <div v-if="result.monitoring.rows.length" class="strategy-table-wrap"><table><thead><tr><th>账本产品 / 批次</th><th>当前结论</th><th>近 1 月年化</th><th>业绩日</th><th>下次核验</th><th>处理</th></tr></thead><tbody><tr v-for="row in result.monitoring.rows" :key="row.lot_id"><td>{{ row.product_code }}<small>{{ row.lot_id }}</small></td><td>{{ label(row.state) }}<small v-if="row.summary">{{ row.summary }}</small></td><td>{{ row.yield_1m == null ? '未获取到' : `${row.yield_1m}%` }}</td><td>{{ row.performance_date || '未获取到' }}</td><td>{{ row.next_verify_date }}</td><td><RouterLink v-if="row.identity" :to="{ name: 'r2-products', query: { section: 'allocation', channel: row.identity.channel, code: row.identity.code, lot: row.lot_id }, hash: '#strategy-review' }">核验此批次</RouterLink><RouterLink v-else :to="{ name: 'r2-products', query: { section: 'allocation', lot: row.lot_id, product_code: row.product_code }, hash: '#strategy-review' }">先核实同份额映射</RouterLink><button v-if="row.state === 'exit_required'" class="button button-ghost button-small" type="button" :disabled="busy || !current" @click="exitHolding(row.lot_id)">生成退出提案</button></td></tr></tbody></table></div>
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
.strategy-amounts { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 16px; margin: 20px 0; }
dt { color: var(--ink-soft); font-size: 12px; } dd { margin: 5px 0 0; font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; }
.strategy-blockers { color: var(--warning-ink); line-height: 1.8; }
.strategy-table-wrap { width: 100%; overflow-x: auto; margin: 16px 0; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 12px 10px; text-align: left; border-bottom: 1px solid var(--line); font-size: 13px; min-width: 100px; }
th { color: var(--ink-soft); font-size: 12px; } small { display: block; font-size: 12px; color: var(--ink-soft); margin-top: 4px; }
a { color: var(--green-deep); } a:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; }
</style>
