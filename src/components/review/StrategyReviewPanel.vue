<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useToast } from '@/composables/useToast'
import {
  getStrategyReview,
  saveStrategyCheck,
  saveStrategyMapping,
  StrategyApiError,
} from '@/api/r2-strategy'
import StrategyFactField from './StrategyFactField.vue'
import type { StrategyReview } from '@/types/r2-strategy'

const props = defineProps<{
  channel?: string
  code?: string
  lot?: string
  ledgerProductCode?: string
}>()

const emit = defineEmits<{ saved: [] }>()
const { show } = useToast()
const channel = ref(props.channel || '')
const code = ref(props.code || '')
const lot = ref(props.lot || '')

const review = ref<StrategyReview | null>(null)
const loading = ref(false)
const error = ref('')
const notDeployed = ref(false)
const loadToken = ref(0)
let controller: AbortController | null = null

const mappingDraft = ref<Record<string, unknown>>({})
const checkDraft = ref<Record<string, unknown>>({})
const factRows = ref<{ key: string; value: string; original: unknown }[]>([])
const savingMapping = ref(false)
const savingCheck = ref(false)
const mappingError = ref('')
const checkError = ref('')

const mappingId = computed(() => {
  const value = mappingDraft.value.id
  return typeof value === 'number' ? value : Number(value) || 0
})
const checkVersion = computed(() => Number(checkDraft.value.version) || 0)
const checkVerifiedAt = computed(() => text(checkDraft.value.verified_at))

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function textInput(key: 'product_code' | 'registration_code') {
  return computed<string>({
    get: () => text(mappingDraft.value[key]),
    set: (value) => {
      mappingDraft.value = {
        ...mappingDraft.value,
        [key]: key === 'registration_code' ? value.trim() || null : value.trim(),
      }
      mappingError.value = ''
    },
  })
}

const productCode = textInput('product_code')
const registrationCode = textInput('registration_code')

const checkLot = computed<string>({
  get: () => text(checkDraft.value.lot_id) || lot.value,
  set: (value) => {
    checkDraft.value = { ...checkDraft.value, lot_id: value.trim() }
    checkError.value = ''
  },
})

function factText(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function blankFacts(data: StrategyReview): Record<string, unknown> {
  const base = { kind: lot.value.startsWith('trade:') ? 'trade_settlement' : lot.value ? 'holding_redemption' : 'product_pretrade', payload_version: 1, status: 'pending', identity: data.identity, registration_code: data.mapping?.registration_code ?? null }
  if (lot.value.startsWith('trade:')) return { ...base, trade_id: Number(lot.value.slice(6)), product_code: data.mapping?.product_code ?? '', arrival_date: null, evidence_hash: null }
  if (lot.value) return { ...base, redemption: { rules_verified: null, source_hash: null, terms_version: null, earliest_redeem_date: null, funds_available_date: null, redemption_fee_bps: null, as_of: null, can_redeem_today: null } }
  const document = () => ({ hash: null, version: null, read_and_verified: null, checked_on: null })
  return { ...base, terms: { document: document(), kind: null, days: null, timing: { verified: null, expected_confirm_on: null, expected_redeem_on: null, expected_arrival_on: null, earliest_funds_available_on: null, calculation_basis: null, holding_day_basis: null, redemption_calendar: null, arrival_calendar: null, application_cutoff: null } }, fees: { purchase_bps: null, redemption_bps: null, evidence_hash: null }, assets: { prospectus: document(), report: { ...document(), period_end: null, is_latest_available: null }, allowed_assets_verified: null, actual_assets_verified: null, equity_upper_pct: null, duration_years: null, prohibited_exposure: { property_bonds: null, low_rated_lgv_bonds: null, nonstandard_trust: null, directional_derivatives: null } }, app: { as_of: null, can_buy: null, available_cents: null, max_order_cents: null, sales_restrictions_verified: null, evidence_hash: null }, allocation: { minimum_cents: null, increment_cents: null, liquidity_eligible: null, liquidity_basis_verified: null, liquidity_evidence_hash: null, strategy_family: { key: null, basis: null, evidence_hash: null } } }
}
const editableFactRows = computed(() => factRows.value.filter(row => !['identity', 'kind', 'payload_version', 'registration_code', 'trade_id', 'product_code'].includes(row.key)))
function updateFact(row: { value: string; original: unknown }, value: unknown) { row.original = value; row.value = factText(value) }
const blockerNames: Record<string, string> = { public_evidence_unavailable: '当前公开份额证据不可用', mapping_unverified: '同份额映射待核实', pretrade_incomplete: '交易前事实尚未核实', pretrade_identity_unverified: '同份额身份待核实', formal_terms_unverified: '正式期限条款待核实', settlement_path_unverified: '申赎与到账路径待核实', fees_unverified: '费用待核实', assets_unverified: '底层资产待核实', prohibited_assets_or_unknown: '禁投资产敞口待核实', equity_limit_unverified: '权益敞口上限待核实', duration_or_distribution_unverified: '久期或期限分布待核实', app_availability_unverified: '当日 App 可买及额度待核实', allocation_limits_unverified: '起购与配置约束待核实', public_quota_unverified: '公开额度待核实', screening_not_automatic: '未满足自动配置准入', verifier_unavailable: '核验人或核验日期不可用', redemption_fee_or_arrival_unverified: '赎回费用或资金到账安排待核实', redemption_rules_unverified: '赎回条款待核实', current_redemption_window_unverified: '当日赎回窗口待核实' }
function applyReview(data: StrategyReview): void {
  review.value = data
  const mapping: Record<string, unknown> = data.mapping ? { ...data.mapping } : {}
  mappingDraft.value = {
    ...mapping,
    source: mapping.source || data.identity.source,
    channel: mapping.channel || data.identity.channel,
    sales_code: mapping.sales_code || data.identity.code,
    product_code: mapping.product_code || props.ledgerProductCode || '',
    registration_code: mapping.registration_code ?? null,
  }
  const check: Record<string, unknown> = data.check ? { ...data.check } : {}
  checkDraft.value = {
    ...check,
    mapping_id: data.mapping?.id ?? null,
    lot_id: check.lot_id || lot.value,
    version: check.version ?? 0,
    verified_by: check.verified_by || '',
  }
  const facts =
    check.facts && typeof check.facts === 'object'
      ? (check.facts as Record<string, unknown>)
      : blankFacts(data)
  factRows.value = Object.entries(facts).map(([key, value]) => ({
    key,
    value: factText(value),
    original: value,
  }))
}

async function loadReview(): Promise<void> {
  if (!channel.value.trim() || !code.value.trim()) return
  if (savingMapping.value || savingCheck.value) return
  const token = ++loadToken.value
  controller?.abort()
  controller = new AbortController()
  loading.value = true
  review.value = null
  error.value = ''
  notDeployed.value = false
  mappingError.value = ''
  checkError.value = ''
  try {
    const data = await getStrategyReview(
      channel.value.trim(),
      code.value.trim(),
      lot.value.trim(),
      controller.signal,
    )
    if (token !== loadToken.value) return
    applyReview(data)
  } catch (caught) {
    if (token !== loadToken.value) return
    if (caught instanceof StrategyApiError && caught.status === 404) {
      notDeployed.value = true
      review.value = null
    } else if ((caught as Error)?.name !== 'AbortError') {
      error.value = caught instanceof Error ? caught.message : '读取复核记录失败'
    }
  } finally {
    if (token === loadToken.value) loading.value = false
  }
}

function patchFacts(): Record<string, unknown> {
  const facts: Record<string, unknown> = Object.create(null)
  for (const row of factRows.value) {
    const key = row.key.trim()
    if (!key) continue
    if (Object.hasOwn(facts, key)) throw new Error(`事实字段 ${key} 重复，请保留一项`)
    if (row.value === factText(row.original)) {
      facts[key] = row.original
      continue
    }
    try {
      facts[key] = JSON.parse(row.value)
    } catch {
      facts[key] = row.value
    }
  }
  return facts
}

function addFact(): void {
  factRows.value = [...factRows.value, { key: '', value: '', original: undefined }]
}

function removeFact(index: number): void {
  factRows.value = factRows.value.filter((_, itemIndex) => itemIndex !== index)
}

function resetMapping(): void {
  if (!review.value) return
  const check = checkDraft.value, facts = factRows.value
  applyReview(review.value)
  checkDraft.value = check; factRows.value = facts
}

function resetCheck(): void {
  if (!review.value) return
  const mapping = mappingDraft.value
  applyReview(review.value)
  mappingDraft.value = mapping
}

async function submitMapping(): Promise<void> {
  if (savingMapping.value || savingCheck.value || loading.value || !review.value || notDeployed.value) return
  if (!productCode.value) {
    mappingError.value = '请先填写账本产品代码'
    return
  }
  savingMapping.value = true
  mappingError.value = ''
  try {
    const payload = {
      source: mappingDraft.value.source || review.value.identity.source,
      channel: review.value.identity.channel,
      sales_code: mappingDraft.value.sales_code || review.value.identity.code,
      product_code: productCode.value,
      registration_code: registrationCode.value || null,
      expected_seq: review.value.activation_seq,
      supersedes_id: review.value.mapping?.id ?? null,
    }
    const result = await saveStrategyMapping(payload)
    mappingDraft.value = { ...payload, ...(result.mapping || {}) }
    show('产品映射已保存')
    savingMapping.value = false
    await loadReview()
    emit('saved')
  } catch (caught) {
    mappingError.value =
      caught instanceof Error && caught.message ? caught.message : '映射保存失败'
  } finally {
    savingMapping.value = false
  }
}

async function submitCheck(): Promise<void> {
  if (savingCheck.value || savingMapping.value || loading.value || !review.value || notDeployed.value) return
  if (!mappingId.value) {
    checkError.value = '请先保存产品映射，再提交交易前检查'
    return
  }
  savingCheck.value = true
  checkError.value = ''
  try {
    const existing = review.value.check
    const payload = {
      mapping_id: mappingId.value,
      lot_id: checkLot.value,
      facts: patchFacts(),
      supersedes_id: existing?.id ?? null,
      expected_seq: review.value.activation_seq,
    }
    await saveStrategyCheck(payload)
    show('交易前检查已保存')
    savingCheck.value = false
    await loadReview()
    emit('saved')
  } catch (caught) {
    checkError.value =
      caught instanceof Error && caught.message ? caught.message : '检查保存失败'
  } finally {
    savingCheck.value = false
  }
}

const blockers = computed(() => review.value?.review?.blockers ?? [])
const evidence = computed(() => review.value?.public_evidence ?? null)

watch(
  () => [props.channel, props.code, props.lot] as const,
  ([nextChannel, nextCode, nextLot]) => {
    if (nextChannel !== undefined) channel.value = nextChannel
    if (nextCode !== undefined) code.value = nextCode
    lot.value = nextLot || ''
    if (channel.value && code.value) void loadReview()
  },
)

watch([channel, code, lot], () => {
  controller?.abort(); loadToken.value++; review.value = null; loading.value = false
}, { flush: 'sync' })

onUnmounted(() => { controller?.abort(); loadToken.value++ })

onMounted(() => {
  if (channel.value && code.value) void loadReview()
})
</script>

<template>
  <div class="rw-panel-body strategy-review">
    <div class="rw-toolbar">
      <div class="rw-card-heading">
        <strong class="rw-panel-title">交易前复核与产品映射</strong>
        <p class="rw-panel-sub">
          把公开份额关联到账本产品，并记录期限、费率、额度等交易前事实。保存不会下单；取消不写入任何内容。
        </p>
      </div>
      <span v-if="review" class="rw-stat-chip">
        复核版本 <strong>v{{ checkVersion || '—' }}</strong>
      </span>
    </div>

<p v-if="lot" class="strategy-hint">当前批次 {{ lot }}<template v-if="ledgerProductCode"> · 账本产品 {{ ledgerProductCode }}</template>。请核实销售渠道与同份额代码后读取复核记录。</p>
    <form class="strategy-identity" @submit.prevent="loadReview">
      <label>
        <span>销售渠道</span>
        <input v-model.trim="channel" name="strategychannel" autocomplete="off" placeholder="如 cmb" />
      </label>
      <label>
        <span>销售代码</span>
        <input v-model.trim="code" name="strategycode" autocomplete="off" placeholder="份额代码" />
      </label>
      <label>
        <span>持仓批次（可选）</span>
        <input v-model.trim="lot" name="strategylot" autocomplete="off" placeholder="产品级复核留空" />
      </label>
      <button
        class="button button-ghost button-small"
        type="submit"
        data-testid="strategy-review-load"
        :disabled="loading || savingMapping || savingCheck || !channel || !code"
      >
        {{ loading ? '读取中…' : '读取复核记录' }}
      </button>
    </form>

    <p v-if="loading" class="strategy-hint" role="status">正在读取复核记录…</p>
    <div v-else-if="notDeployed" class="rw-alert is-warn" role="status" data-testid="strategy-review-missing">
      <strong>策略复核接口尚未部署</strong>
      <p>
        本地服务返回 404，市场映射与交易前检查暂不可提交；候选初筛、资金配置和持仓复核不受影响。
        部署后可在此完成映射与检查。
      </p>
    </div>
    <p v-else-if="error" class="rw-alert is-warn" role="alert">{{ error }}</p>

    <template v-if="review">
      <p v-if="lot" class="rw-alert is-warn">当前核验批次：{{ lot }}。{{ lot.startsWith('trade:') ? '记录此笔赎回实际到账日与原始证据；未核实保持 pending。' : '此处核验该批次赎回窗口和规则，不能用公开申购开放日代替。' }}</p>
      <dl class="strategy-facts">
        <div><dt>公开份额</dt><dd>{{ evidence?.name || review.identity.code }}</dd></div>
        <div><dt>发行方</dt><dd>{{ evidence?.issuer || '—' }}</dd></div>
        <div><dt>登记编码</dt><dd>{{ evidence?.registration || '—' }}</dd></div>
        <div>
          <dt>期限</dt>
          <dd>
            {{ evidence?.term?.days == null ? (evidence?.term?.kind || '待核') : `${evidence.term.days} 天` }}
          </dd>
        </div>
        <div><dt>业绩日</dt><dd>{{ evidence?.performance_date || '待核' }}</dd></div>
        <div>
          <dt>可执行</dt>
          <dd>{{ review.review?.executable ? '复核通过' : '暂不可执行' }}</dd>
        </div>
      </dl>

      <div v-if="blockers.length" class="rw-alert is-warn" role="status">
        <strong>阻碍项</strong>
        <ul>
          <li v-for="blocker in blockers" :key="blocker">{{ blockerNames[blocker] || blocker }}</li>
        </ul>
      </div>

      <form class="strategy-form" @submit.prevent="submitMapping">
        <h3>产品映射</h3>
        <p class="rw-panel-sub">
          未知字段按原记录保留。保存新映射会撤回同一账本产品的旧映射；同一销售份额不能关联两个产品。
        </p>
        <label>
          <span>账本产品代码</span>
          <input v-model="productCode" name="mappingproduct" autocomplete="off" required />
        </label>
        <label>
          <span>登记编码</span>
          <input v-model="registrationCode" name="mappingregistration" autocomplete="off" />
        </label>
        <p class="strategy-hint">
          映射编号 {{ mappingId || '尚未保存' }} · 来源 {{ text(review.identity.source) }} ·
          份额 {{ text(review.identity.code) }}
        </p>
        <p v-if="mappingError" class="strategy-error" role="alert">{{ mappingError }}</p>
        <div class="strategy-actions">
          <button
            class="button button-primary button-small"
            type="submit"
            data-testid="strategy-mapping-save"
            :disabled="savingMapping || savingCheck || loading || notDeployed || !productCode"
          >
            {{ savingMapping ? '保存中…' : '保存产品映射' }}
          </button>
          <button
            class="button button-ghost button-small"
            type="button"
            data-testid="strategy-mapping-cancel"
            :disabled="savingMapping"
            @click="resetMapping"
          >
            取消
          </button>
        </div>
      </form>

      <form class="strategy-form" @submit.prevent="submitCheck">
        <h3>{{ lot.startsWith('trade:') ? '赎回到账事实核验' : lot ? '持仓赎回规则核验' : '交易前检查' }}</h3>
        <p class="rw-panel-sub">
          逐项核实正式条款、费用、底层资产和银行 App 证据。未知项目保持空白或“未核实”，保存后仍需所有阻碍项解除才能执行。金额字段以分为单位。
        </p>
        <div class="strategy-structured-facts"><StrategyFactField v-for="row in editableFactRows" :key="row.key" :field-key="row.key" :model-value="row.original" @update:model-value="updateFact(row, $event)" /></div>
        <details class="strategy-advanced"><summary>高级字段与原始结构</summary>
        <div v-for="(row, index) in factRows" :key="index" class="strategy-fact-row">
          <input v-model="row.key" :aria-label="`事实字段名 ${index + 1}`" placeholder="字段名" />
          <textarea v-model="row.value" :aria-label="`事实字段值 ${index + 1}`" rows="2" placeholder="字段值或 JSON" />
          <button
            class="rw-link-button is-danger"
            type="button"
            :aria-label="`删除字段 ${row.key || index + 1}`"
            @click="removeFact(index)"
          >
            删除
          </button>
        </div>
        <button class="rw-link-button" type="button" @click="addFact">添加字段</button>
        </details>
        <div class="strategy-check-meta">
          <label>
            <span>持仓批次</span>
            <input v-model="checkLot" name="checklot" autocomplete="off" placeholder="产品级复核留空" />
          </label>
          <p class="strategy-hint">核验人及核验时间由服务端在保存时记录。</p>
        </div>
        <p class="strategy-hint">
          {{ checkVersion ? `当前版本 v${checkVersion} · 核验于 ${checkVerifiedAt || '—'}` : '尚未建立检查版本' }}
        </p>
        <p v-if="checkError" class="strategy-error" role="alert">{{ checkError }}</p>
        <div class="strategy-actions">
          <button
            class="button button-primary button-small"
            type="submit"
            data-testid="strategy-check-save"
            :disabled="savingCheck || savingMapping || loading || notDeployed || !mappingId"
          >
            {{ savingCheck ? '保存中…' : '保存交易前检查' }}
          </button>
          <button
            class="button button-ghost button-small"
            type="button"
            data-testid="strategy-check-cancel"
            :disabled="savingCheck"
            @click="resetCheck"
          >
            取消
          </button>
        </div>
      </form>
    </template>
  </div>
</template>

<style scoped>
.strategy-structured-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.strategy-advanced { margin-top: 18px; font-size: 12px; color: var(--ink-soft); }
.strategy-advanced summary { cursor: pointer; }
.strategy-identity {
  display: grid;
  grid-template-columns: repeat(3, minmax(150px, 1fr)) auto;
  gap: 10px;
  align-items: end;
  margin: 12px 0;
}
.strategy-identity label,
.strategy-form label,
.strategy-check-meta label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--ink-soft);
}
.strategy-identity input,
.strategy-form input,
.strategy-form textarea,
.strategy-check-meta input {
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  min-height: 34px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--card);
  color: var(--ink);
  font-size: 13px;
  padding: 6px 9px;
}
.strategy-identity input:focus-visible,
.strategy-form input:focus-visible,
.strategy-check-meta input:focus-visible {
  outline: 2px solid var(--green);
  outline-offset: 1px;
}
.strategy-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px 16px;
  margin: 12px 0;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
}
.strategy-facts dt {
  font-size: 12px;
  color: var(--ink-soft);
}
.strategy-facts dd {
  margin: 3px 0 0;
  font-size: 13px;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.strategy-form {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.strategy-form h3 {
  margin: 0 0 4px;
  font-size: 14px;
}
.strategy-fact-row {
  display: grid;
  grid-template-columns: minmax(120px, 0.8fr) minmax(180px, 1.4fr) auto;
  gap: 8px;
  align-items: center;
  margin: 8px 0;
}
.strategy-check-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(150px, 1fr));
  gap: 10px;
  margin-top: 12px;
}
.strategy-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.strategy-hint {
  margin: 6px 0;
  font-size: 12px;
  color: var(--ink-soft);
}
.strategy-error {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: var(--warning-ink);
}
@media (max-width: 900px) {
  .strategy-identity {
    grid-template-columns: 1fr 1fr;
  }
}
@media (max-width: 600px) {
  .strategy-structured-facts, .strategy-identity, .strategy-check-meta, .strategy-fact-row { grid-template-columns: minmax(0, 1fr); }
}
</style>
