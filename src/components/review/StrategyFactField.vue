<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ modelValue: unknown; fieldKey: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: unknown] }>()
const labels: Record<string, string> = {
  status: '核验状态', terms: '正式期限与申赎安排', document: '正式条款文件', fees: '费用', assets: '底层资产', app: '当日银行 App 核验', allocation: '起购与配置约束', redemption: '持仓赎回规则',
  hash: '文件 SHA-256', version: '文件版本', read_and_verified: '已阅读并核实', checked_on: '核验日期', kind: '期限类型（minimum / closed）', days: '期限天数', timing: '申赎到账路径', verified: '路径已核实',
  expected_confirm_on: '预计申购确认日', expected_redeem_on: '预计赎回申请日', expected_arrival_on: '预计资金到账日', earliest_funds_available_on: '最早资金可用日', calculation_basis: '日期推算依据', holding_day_basis: '持有期计算口径', redemption_calendar: '赎回日历依据', arrival_calendar: '到账日历依据', application_cutoff: '申请截止时间（HH:mm）',
  purchase_bps: '申购费率（基点，1 基点 = 0.01%）', redemption_fee_bps: '赎回费率（基点）', redemption_bps: '赎回费率（基点）', evidence_hash: '证据 SHA-256', prospectus: '产品说明书', report: '定期报告', period_end: '报告期末', is_latest_available: '确认是最新可得报告', allowed_assets_verified: '允许投资范围已核实', actual_assets_verified: '实际资产组合已核实', equity_upper_pct: '权益敞口上限（%）', duration_years: '久期（年）', prohibited_exposure: '禁投资产敞口（无敞口选否）', property_bonds: '地产债', low_rated_lgv_bonds: '低评级城投债', nonstandard_trust: '非标信托', directional_derivatives: '方向性衍生品',
  as_of: '数据截至日', can_buy: '当前可买', available_cents: '可用额度（分）', max_order_cents: '单笔上限（分）', sales_restrictions_verified: '销售限制已核实', minimum_cents: '起购金额（分）', increment_cents: '递增金额（分）', liquidity_eligible: '计入流动性子集', liquidity_basis_verified: '流动性依据已核实', liquidity_evidence_hash: '流动性证据 SHA-256', strategy_family: '底层策略族', key: '策略族标识', basis: '依据（verified_underlying / benchmark_proxy）',
  rules_verified: '赎回条款已核实', source_hash: '条款证据 SHA-256', terms_version: '赎回条款版本', earliest_redeem_date: '最早赎回申请日', funds_available_date: '预计资金到账日', can_redeem_today: '当日赎回窗口已确认开放', arrival_date: '实际资金到账日', trade_id: '赎回交易编号', product_code: '账本产品代码',
}
const label = computed(() => labels[props.fieldKey] || props.fieldKey)
const object = computed(() => props.modelValue !== null && typeof props.modelValue === 'object' && !Array.isArray(props.modelValue) ? props.modelValue as Record<string, unknown> : null)
const isBoolean = computed(() => typeof props.modelValue === 'boolean' || /^(read_and_verified|verified|is_latest_available|allowed_assets_verified|actual_assets_verified|property_bonds|low_rated_lgv_bonds|nonstandard_trust|directional_derivatives|can_buy|sales_restrictions_verified|liquidity_eligible|liquidity_basis_verified|rules_verified|can_redeem_today)$/.test(props.fieldKey))
const isNumber = computed(() => typeof props.modelValue === 'number' || /(_cents|_bps|_pct|_years)$/.test(props.fieldKey) || ['days', 'trade_id'].includes(props.fieldKey))
function valueChange(event: Event) {
  const value = (event.target as HTMLInputElement).value
  emit('update:modelValue', value === '' ? null : isNumber.value ? Number(value) : value)
}
</script>

<template>
  <details v-if="object" class="fact-group" :open="fieldKey === 'redemption'">
    <summary>{{ label }}</summary>
    <div class="fact-grid">
      <StrategyFactField v-for="(value, key) in object" :key="key" :field-key="String(key)" :model-value="value" @update:model-value="emit('update:modelValue', { ...object, [key]: $event })" />
    </div>
  </details>
  <label v-else class="fact-field">
    <span>{{ label }}</span>
    <select v-if="fieldKey === 'status'" :value="modelValue || 'pending'" @change="valueChange">
      <option value="pending">待核实</option><option value="verified">已核实</option><option value="withdrawn">撤回核验</option>
    </select>
    <select v-else-if="isBoolean" :value="modelValue == null ? '' : String(modelValue)" @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value === '' ? null : ($event.target as HTMLSelectElement).value === 'true')">
      <option value="">未核实</option><option value="true">是</option><option value="false">否</option>
    </select>
    <textarea v-else-if="Array.isArray(modelValue)" :value="JSON.stringify(modelValue)" rows="2" readonly aria-label="原记录数组，保留原值" />
    <input v-else :type="isNumber ? 'number' : 'text'" :step="isNumber ? 'any' : undefined" :value="modelValue ?? ''" placeholder="未获取到" @input="valueChange" />
  </label>
</template>

<style scoped>
.fact-group { min-width: 0; grid-column: 1 / -1; padding: 12px 0; border-bottom: 1px solid var(--line); }
summary { cursor: pointer; font-size: 13px; font-weight: 650; color: var(--ink); }
summary:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; }
.fact-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
.fact-field { display: flex; min-width: 0; flex-direction: column; gap: 5px; color: var(--ink-soft); font-size: 12px; }
input, select, textarea { width: 100%; min-width: 0; box-sizing: border-box; min-height: 36px; border: 1px solid var(--line-strong); border-radius: 10px; padding: 7px 9px; background: var(--field-bg); color: var(--ink); font: inherit; font-size: 13px; }
input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--green); outline-offset: 1px; }
@media (max-width: 600px) { .fact-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
