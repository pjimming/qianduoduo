<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { computeStrategy, getStrategySettings, saveStrategySettings, StrategyApiError } from '@/api/r2-strategy'
import type { StrategyPolicy, StrategySettingGroup, StrategySettings } from '@/types/r2-strategy'

const emit = defineEmits<{ refresh: [] }>()
const props = defineProps<{ mode?: string; screeningStale?: boolean; calculationStale?: boolean }>()

const groups: { key: StrategySettingGroup; title: string; description: string }[] = [
  { key: 'screening', title: '选品策略', description: '下次初筛按这些值采集并筛选同期限、同分类的人民币公募 R2/PR2 份额。' },
  { key: 'allocation', title: '资金配置', description: '按策略核算本金限制持仓与待确认买入的合计占用。日开目标固定为 0%。' },
  { key: 'exit', title: '退出与收益预警', description: '退出须同时满足两项收益严格低于阈值，以及同份额同披露日的 6 月、3 月、1 月年化依次下降。' },
  { key: 'replacement', title: '换仓策略', description: '同期限桶内比较扣费、到账空档后的增益。仍需核验赎回窗口和换仓后的组合约束。' },
]

const labels: Record<string, [string, string]> = {
  min_monthly_yield: ['近 1 月年化准入线', '%'],
  max_data_age_days: ['公开数据最大账龄', '自然日'],
  max_term_days: ['产品期限上限', '天'],
  drawdown_watch_pct: ['最大回撤观察线（含）', '%'],
  drawdown_reject_pct: ['最大回撤淘汰线（超过）', '%'],
  shortlist_per_group: ['每组正式候选数', '只'],
  frequent_zero_count: ['频繁挂零提示阈值', '次'],
  equity_review_pct: ['权益敞口复核线（超过）', '%'],
  low_quota_hint_cny: ['公开低额度提示线（含）', '元'],
  principal_override: ['配置本金覆盖值', '元'],
  max_single_pct: ['单只产品占比上限', '%'],
  liquidity_floor_pct: ['流动性占比下限', '%'],
  medium_cap_pct: ['中期占比上限', '%'],
  long_cap_pct: ['长期占比上限', '%'],
  max_strategy_family_pct: ['同策略家族占比上限', '%'],
  six_month_single_pct: ['仅 6 月证据层 · 单只上限', '%'],
  six_month_aggregate_pct: ['仅 6 月证据层 · 合计上限', '%'],
  three_month_single_pct: ['仅 3 月证据层 · 单只上限', '%'],
  three_month_aggregate_pct: ['仅 3 月证据层 · 合计上限', '%'],
  blank_quota_cny: ['公开额度为空时的假设金额', '元'],
  monthly_yield_threshold_pct: ['近 1 月年化退出线', '%'],
  recent_return_threshold_pct: ['近 7 日总收益率退出线', '%'],
  observation_upper_pct: ['收益预警年化上界（不含）', '%'],
  min_yield_edge_pp: ['换仓年化差下限', '百分点'],
  break_even_margin_pp: ['盈亏平衡年化余量', '百分点'],
  minimum_gain_cny: ['换仓最低净增益', '元'],
  minimum_gain_90d_pct: ['90 天净增益比例下限', '%'],
  candidate_limit: ['每只持仓展示候选数上限', '只'],
  short_comparison_days: ['短期换仓比较期', '天'],
  medium_comparison_days: ['中期换仓比较期', '天'],
  long_comparison_days: ['长期换仓比较期', '天'],
}

const state = ref<StrategySettings | null>(null)
type PolicyDraft = Record<StrategySettingGroup, Record<string, number | null | ''>>
const draft = ref<PolicyDraft | null>(null)
const action = ref<'load' | 'save' | 'compute' | null>('load')
const error = ref('')
const message = ref('')
const conflict = ref(false)
const screeningChanged = ref(false)
const changed = computed(() => state.value && draft.value ? groups.reduce((total, { key }) =>
  total + Object.entries(draft.value![key]).filter(([field, value]) => (value === '' ? null : value) !== state.value!.settings[key][field]).length, 0) : 0)
const defaultsChanged = computed(() => state.value && draft.value ? groups.some(({ key }) =>
  Object.entries(draft.value![key]).some(([field, value]) => (value === '' ? null : value) !== state.value!.defaults[key][field])) : false)
const controller = new AbortController()
const copy = (policy: StrategyPolicy): StrategyPolicy => JSON.parse(JSON.stringify(policy))
const displayNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 })

function jumpToGroup(key: StrategySettingGroup) {
  const group = document.getElementById(`policy-${key}`)
  group?.focus({ preventScroll: true })
  group?.scrollIntoView({ block: 'start' })
}

function apply(value: StrategySettings) {
  state.value = value
  draft.value = copy(value.settings)
  conflict.value = false
}

async function load() {
  action.value = 'load'
  error.value = ''
  message.value = ''
  try {
    apply(await getStrategySettings(controller.signal))
  } catch (caught) {
    if (!controller.signal.aborted) error.value = caught instanceof Error ? caught.message : '读取策略设置失败'
  } finally {
    action.value = null
  }
}

function restore(defaults = false) {
  if (!state.value) return
  draft.value = copy(defaults ? state.value.defaults : state.value.settings)
  error.value = ''
  message.value = defaults ? '已填入默认值，保存后生效。' : ''
}

async function save() {
  if (!draft.value || !state.value || !changed.value || action.value) return
  action.value = 'save'
  error.value = ''
  message.value = ''
  const updatesScreening = Object.entries(draft.value.screening).some(([key, value]) => value !== state.value?.settings.screening[key])
  const next = Object.fromEntries(groups.map(({ key }) => [key,
    Object.fromEntries(Object.entries(draft.value![key]).map(([field, value]) => [field, value === '' ? null : value]))])) as StrategyPolicy
  try {
    apply(await saveStrategySettings(state.value.revision, next))
    screeningChanged.value = updatesScreening
    message.value = updatesScreening ? '已保存。请刷新初筛，再用新批次重算资金配置。' : '已保存。重算后可查看新策略的配置和持仓结果。'
    emit('refresh')
  } catch (caught) {
    conflict.value = caught instanceof StrategyApiError && caught.status === 409
    error.value = caught instanceof Error ? caught.message : '保存策略设置失败'
  } finally {
    action.value = null
  }
}

async function recompute() {
  action.value = 'compute'
  message.value = ''
  error.value = ''
  try {
    const response = await computeStrategy()
    message.value = response.pending ? '已有重算任务正在处理。可在资金配置或持仓复核查看状态。' : '已按保存的设置重算，可查看资金配置和持仓复核。'
    emit('refresh')
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '重算失败，请稍后重试'
  } finally {
    action.value = null
  }
}

onMounted(load)
onUnmounted(() => controller.abort())
</script>

<template>
  <section id="settings" class="rw-panel strategy-settings" aria-labelledby="strategy-settings-title">
    <header class="settings-heading">
      <h2 id="strategy-settings-title">策略设置</h2>
      <p>修改后保存到本机。当前策略在重算时生效，旧批次与已采纳决策保留生成时的依据。</p>
    </header>
    <p v-if="action === 'load' && !draft" role="status">正在读取策略设置…</p>
    <div v-else-if="!draft && error" class="settings-error" role="alert">
      {{ error }} <button class="link-button" type="button" @click="load">重试</button>
    </div>
    <nav v-if="draft" class="settings-index" aria-label="策略设置分组">
      <button v-for="group in groups" :key="group.key" class="link-button" type="button" @click="jumpToGroup(group.key)">{{ group.title }}</button>
    </nav>
    <form v-if="state && draft" @submit.prevent="save">
      <fieldset v-for="group in groups" :id="'policy-' + group.key" :key="group.key" class="settings-group" tabindex="-1" :disabled="Boolean(action)">
        <legend>{{ group.title }}</legend>
        <p>{{ group.description }}
          <RouterLink v-if="group.key === 'allocation'" :to="{ query: { section: 'allocation' }, hash: '#allocation-cash-needs' }">按付款日设置现金需求</RouterLink>
        </p>
        <div class="settings-fields">
          <label v-for="([initial, min, max, step], key) in state.fields[group.key]" :key="key">
            <span>{{ labels[key]?.[0] ?? key }}</span>
            <span class="settings-input">
              <input v-model="draft[group.key][key]" type="number" :min :max :step :required="key !== 'principal_override'"
                :placeholder="key === 'principal_override' ? '按账本算' : undefined"
                :name="group.key + '.' + key" :aria-describedby="group.key + '-' + key + '-detail'">
              <span>{{ labels[key]?.[1] }}</span>
            </span>
            <small :id="group.key + '-' + key + '-detail'">{{ initial === null ? '留空时使用账本本金' : '默认 ' + displayNumber.format(initial) + ' · 范围 ' + displayNumber.format(min) + ' 至 ' + displayNumber.format(max) }}</small>
          </label>
        </div>
      </fieldset>
      <footer class="settings-footer" :class="{ 'is-sticky': changed || action || message || error }">
        <div v-if="error" class="settings-error" role="alert">
          {{ error }}
          <button v-if="conflict" type="button" class="link-button" :disabled="Boolean(action)" @click="load">重新读取并放弃本次编辑</button>
        </div>
        <p v-if="message" role="status">{{ message }}</p>
        <div class="settings-toolbar">
          <div class="settings-actions">
            <button type="submit" class="button button-primary button-small" :disabled="!changed || Boolean(action) || conflict">{{ action === 'save' ? '保存中…' : '保存策略设置' }}</button>
            <button type="button" class="button button-ghost button-small" :disabled="!changed || Boolean(action)" @click="restore()">撤销修改</button>
            <button type="button" class="button button-ghost button-small" :disabled="!defaultsChanged || Boolean(action)" @click="restore(true)">填入默认值</button>
          </div>
          <div class="settings-actions">
            <span v-if="changed">{{ changed }} 项待保存</span>
            <RouterLink v-if="screeningStale || screeningChanged" class="button button-ghost button-small" :to="{ query: { section: 'screening' } }">前往刷新初筛</RouterLink>
            <button v-else-if="props.mode === 'v9' && (calculationStale || message || action === 'compute')" class="button button-ghost button-small" type="button"
              :disabled="Boolean(action) || Boolean(changed)" @click="recompute">{{ action === 'compute' ? '正在重算…' : '重算当前策略' }}</button>
          </div>
        </div>
      </footer>
    </form>
  </section>
</template>

<style scoped>
.strategy-settings { padding: 22px 24px 0; font-size: 13px; color: var(--ink); }
.settings-heading h2 { margin: 0; font-size: 19px; }
.settings-heading p, .settings-group p, .settings-footer p { margin: 6px 0 0; color: var(--ink-soft); line-height: 1.55; }
.settings-index { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 12px; }
.settings-index .link-button { appearance: none; padding: 3px 0; border: 0; color: var(--green); background: transparent; font: inherit; font-weight: 650; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.settings-index .link-button:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; }
.settings-group { min-inline-size: 0; margin: 23px 0 0; padding: 0 0 19px; border: 0; border-bottom: 1px solid var(--line); scroll-margin-block-start: 18px; }
.settings-group legend { padding: 0; font-size: 15px; font-weight: 700; }
.settings-group a { margin-inline-start: 8px; color: var(--green); text-decoration: underline; text-underline-offset: 3px; }
.settings-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(215px, 100%), 1fr)); gap: 13px 18px; margin-top: 12px; }
.settings-fields label { display: grid; align-content: start; gap: 5px; min-width: 0; font-weight: 650; }
.settings-fields small { font-size: 12px; font-weight: 400; color: var(--ink-soft); }
.settings-input { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; }
.settings-input input { width: 100%; height: 36px; min-width: 0; padding: 0 9px; font: inherit; font-variant-numeric: tabular-nums; font-weight: 500; color: var(--ink); background: var(--field-bg); border: 1px solid color-mix(in srgb, var(--ink) 49%, var(--field-bg)); border-radius: 10px; scroll-margin-block-end: 85px; }
.settings-input input:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
.settings-input > span { min-width: 27px; color: var(--ink-soft); font-weight: 500; }
.settings-footer { padding: 10px 0 14px; background: var(--card); }
.settings-footer.is-sticky { position: sticky; bottom: 0; z-index: 1; }
.settings-footer p { margin: 0 0 8px; }
.settings-toolbar, .settings-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.settings-toolbar { justify-content: space-between; }
.settings-actions .button { flex: 0 0 auto; }
.settings-actions .button:disabled { opacity: 0.66; cursor: default; transform: none; }
.settings-error { padding: 8px 10px; margin-bottom: 8px; border-radius: 10px; background: var(--surface-danger); color: var(--danger-ink); }
</style>
