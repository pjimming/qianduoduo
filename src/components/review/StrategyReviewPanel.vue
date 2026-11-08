<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useToast } from '@/composables/useToast'
import {
  getStrategyReview,
  matchStrategyShare,
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
const matchingShare = ref(false)
const error = ref('')
const notDeployed = ref(false)
const loadToken = ref(0)
let controller: AbortController | null = null

const mappingDraft = ref<Record<string, unknown>>({})
const checkDraft = ref<Record<string, unknown>>({})
const factRows = ref<{ key: string; value: string; original: unknown }[]>([])
const onlyMissing = ref(false)
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

type FactObject = Record<string, unknown>
type MissingFact = { path: string; label: string }

function factValue(facts: FactObject, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => value !== null && typeof value === 'object'
    ? (value as FactObject)[key]
    : undefined, facts)
}

function mergeMissing(target: FactObject, source: unknown): void {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return
  for (const [key, value] of Object.entries(source as FactObject)) {
    if (value === null || value === undefined) continue
    const current = target[key]
    if (current === null || current === undefined || current === '') {
      target[key] = value
    } else if (current && typeof current === 'object' && !Array.isArray(current) &&
      value && typeof value === 'object' && !Array.isArray(value)) {
      mergeMissing(current as FactObject, value)
    }
  }
}

function setFactRows(facts: FactObject): void {
  factRows.value = Object.entries(facts).map(([key, value]) => ({ key, value: factText(value), original: value }))
}

function blankFacts(data: StrategyReview): Record<string, unknown> {
  const base = { kind: lot.value.startsWith('trade:') ? 'trade_settlement' : lot.value ? 'holding_redemption' : 'product_pretrade', payload_version: 1, status: 'pending', identity: data.identity, registration_code: data.mapping?.registration_code ?? null }
  if (lot.value.startsWith('trade:')) return { ...base, trade_id: Number(lot.value.slice(6)), product_code: data.mapping?.product_code ?? '', arrival_date: null, evidence_hash: null }
  if (lot.value) return { ...base, redemption: { rules_verified: null, source_hash: null, terms_version: null, earliest_redeem_date: null, funds_available_date: null, redemption_fee_bps: null, as_of: null, can_redeem_today: null } }
  const document = () => ({ hash: null, version: null, read_and_verified: null, checked_on: null })
  return { ...base, terms: { document: document(), kind: null, days: null, timing: { verified: null, expected_confirm_on: null, expected_redeem_on: null, expected_arrival_on: null, earliest_funds_available_on: null, calculation_basis: null, holding_day_basis: null, redemption_calendar: null, arrival_calendar: null, application_cutoff: null } }, fees: { purchase_bps: null, redemption_bps: null, evidence_hash: null }, assets: { prospectus: document(), report: { ...document(), period_end: null, is_latest_available: null }, allowed_assets_verified: null, actual_assets_verified: null, equity_upper_pct: null, duration_years: null, prohibited_exposure: { property_bonds: null, low_rated_lgv_bonds: null, nonstandard_trust: null, directional_derivatives: null } }, app: { as_of: null, can_buy: null, available_cents: null, max_order_cents: null, sales_restrictions_verified: null, evidence_hash: null }, allocation: { minimum_cents: null, increment_cents: null, liquidity_eligible: false, liquidity_basis_verified: null, liquidity_evidence_hash: null, strategy_family: { key: null, basis: null, evidence_hash: null } } }
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
  const facts = check.facts && typeof check.facts === 'object'
    ? JSON.parse(JSON.stringify(check.facts)) as FactObject
    : blankFacts(data)
  mergeMissing(facts, data.suggestions?.facts)
  setFactRows(facts)
  onlyMissing.value = Boolean(data.suggestions?.facts) && missingFacts.value.length > 0
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

async function autoMatchShare(): Promise<void> {
  const ledgerCode = props.ledgerProductCode?.trim()
  if (!ledgerCode || matchingShare.value) return
  matchingShare.value = true
  try {
    const result = await matchStrategyShare(ledgerCode)
    if (result.matched) {
      const candidate = result.candidates[0]
      channel.value = candidate.channel
      code.value = candidate.code
      await loadReview()
      show(`已按最新公开快照匹配 ${candidate.channel} / ${candidate.code}`)
    } else if (result.candidates.length) {
      show(`匹配到 ${result.candidates.length} 个公开份额，请手动选择销售渠道和代码`)
    } else {
      show('未找到对应公开份额，请手动填写销售渠道和代码')
    }
  } catch (caught) {
    show(caught instanceof Error && caught.message ? caught.message : '自动匹配失败，请手动填写')
  } finally {
    matchingShare.value = false
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

const currentFacts = computed<FactObject>(() => {
  const facts: FactObject = {}
  for (const row of factRows.value) {
    const key = row.key.trim()
    if (!key) continue
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
})

const missingFacts = computed<MissingFact[]>(() => {
  const data = review.value
  if (!data || lot.value) return []
  const date = data.business_date
  const facts = currentFacts.value
  const missing: MissingFact[] = []
  const add = (path: string, label: string, ok: boolean) => { if (!ok) missing.push({ path, label }) }
  const value = (path: string) => factValue(facts, path)
  const stringValue = (path: string) => typeof value(path) === 'string' && Boolean((value(path) as string).trim())
  const numberValue = (path: string) => typeof value(path) === 'number' && Number.isFinite(value(path) as number)
  const integerValue = (path: string) => Number.isSafeInteger(value(path)) && (value(path) as number) >= 0
  const hashValue = (path: string) => /^[a-f0-9]{64}$/.test(typeof value(path) === 'string' ? value(path) as string : '')
  const dateValue = (path: string) => /^\d{4}-\d{2}-\d{2}$/.test(typeof value(path) === 'string' ? value(path) as string : '')
  const document = (path: string, label: string) => {
    add(`${path}.hash`, `${label}文件 SHA-256`, hashValue(`${path}.hash`))
    add(`${path}.version`, `${label}文件版本`, stringValue(`${path}.version`))
    add(`${path}.read_and_verified`, `${label}已阅读并核实`, value(`${path}.read_and_verified`) === true)
    add(`${path}.checked_on`, `${label}核验日期`, dateValue(`${path}.checked_on`) && (value(`${path}.checked_on`) as string) <= date)
  }
  const term = data.public_evidence?.term
  add('terms.kind', '正式期限类型', ['minimum', 'closed'].includes(value('terms.kind') as string) && (!term?.kind || value('terms.kind') === term.kind))
  add('terms.days', '正式期限天数', Number.isSafeInteger(value('terms.days')) && (value('terms.days') as number) >= 1 && (value('terms.days') as number) <= 190 && (!term?.days || value('terms.days') === term.days))
  document('terms.document', '正式条款')
  add('terms.timing.verified', '申赎路径已核实', value('terms.timing.verified') === true)
  for (const [path, label] of [
    ['terms.timing.expected_confirm_on', '预计申购确认日'],
    ['terms.timing.expected_redeem_on', '预计赎回申请日'],
    ['terms.timing.expected_arrival_on', '预计资金到账日'],
    ['terms.timing.earliest_funds_available_on', '最早资金可用日'],
  ] as const) {
    add(path, label, dateValue(path) && (value(path) as string) >= date)
  }
  const confirmOn = value('terms.timing.expected_confirm_on') as string
  const redeemOn = value('terms.timing.expected_redeem_on') as string
  const arrivalOn = value('terms.timing.expected_arrival_on') as string
  const earliestOn = value('terms.timing.earliest_funds_available_on') as string
  add('terms.timing.expected_redeem_on', '预计赎回申请日不得早于确认日', dateValue('terms.timing.expected_redeem_on') && redeemOn >= confirmOn)
  add('terms.timing.expected_arrival_on', '预计到账日不得早于赎回日', dateValue('terms.timing.expected_arrival_on') && arrivalOn >= redeemOn)
  add('terms.timing.expected_arrival_on', '预计到账日须与最早可用日一致', dateValue('terms.timing.expected_arrival_on') && arrivalOn === earliestOn)
  for (const [path, label] of [
    ['terms.timing.calculation_basis', '日期推算依据'],
    ['terms.timing.holding_day_basis', '持有期计算口径'],
    ['terms.timing.redemption_calendar', '赎回日历依据'],
    ['terms.timing.arrival_calendar', '到账日历依据'],
  ] as const) {
    add(path, label, stringValue(path))
  }
  add('terms.timing.application_cutoff', '申请截止时间（HH:mm）', /^([01]\d|2[0-3]):[0-5]\d$/.test(value('terms.timing.application_cutoff') as string))
  for (const [path, label] of [['fees.purchase_bps', '申购费率（基点）'], ['fees.redemption_bps', '赎回费率（基点）']] as const) {
    add(path, label, numberValue(path) && (value(path) as number) >= 0 && (value(path) as number) <= 500)
  }
  add('fees.evidence_hash', '费用证据 SHA-256', hashValue('fees.evidence_hash'))
  document('assets.prospectus', '产品说明书')
  document('assets.report', '定期报告')
  add('assets.report.period_end', '报告期末', dateValue('assets.report.period_end') && (value('assets.report.period_end') as string) <= date)
  add('assets.report.is_latest_available', '确认是最新可得报告', value('assets.report.is_latest_available') === true)
  add('assets.allowed_assets_verified', '允许投资范围已核实', value('assets.allowed_assets_verified') === true)
  add('assets.actual_assets_verified', '实际资产组合已核实', value('assets.actual_assets_verified') === true)
  add('assets.equity_upper_pct', '权益敞口上限（%）', numberValue('assets.equity_upper_pct') && (value('assets.equity_upper_pct') as number) >= 0 && (value('assets.equity_upper_pct') as number) <= 5)
  for (const [key, label] of [['property_bonds', '地产债'], ['low_rated_lgv_bonds', '低评级城投债'], ['nonstandard_trust', '非标信托'], ['directional_derivatives', '方向性衍生品']] as const) {
    add(`assets.prohibited_exposure.${key}`, `${label}无敞口`, value(`assets.prohibited_exposure.${key}`) === false)
  }
  const duration = numberValue('assets.duration_years') && (value('assets.duration_years') as number) >= 0
  const distribution = value('assets.duration_status') === 'pending' && value('assets.maturity_distribution_verified') === true && hashValue('assets.maturity_distribution_hash')
  add('assets.duration_years', '久期或期限分布', duration || distribution)
  add('app.as_of', 'App 数据截至日（当天）', value('app.as_of') === date)
  add('app.can_buy', '当前可买', value('app.can_buy') === true)
  add('app.available_cents', '可用额度（分）', integerValue('app.available_cents'))
  add('app.max_order_cents', '单笔上限（分）', value('app.max_order_cents') === null || value('app.max_order_cents') === undefined || integerValue('app.max_order_cents'))
  add('app.sales_restrictions_verified', '销售限制已核实', value('app.sales_restrictions_verified') === true)
  add('app.evidence_hash', 'App 额度证据 SHA-256', hashValue('app.evidence_hash'))
  add('allocation.minimum_cents', '起购金额（分）', integerValue('allocation.minimum_cents'))
  add('allocation.increment_cents', '递增金额（分）', integerValue('allocation.increment_cents') && (value('allocation.increment_cents') as number) > 0)
  add('allocation.strategy_family.key', '策略族标识', stringValue('allocation.strategy_family.key'))
  add('allocation.strategy_family.basis', '策略族依据', ['verified_underlying', 'benchmark_proxy'].includes(value('allocation.strategy_family.basis') as string))
  add('allocation.strategy_family.evidence_hash', '策略族证据 SHA-256', hashValue('allocation.strategy_family.evidence_hash'))
  add('allocation.liquidity_eligible', '是否计入流动性子集', typeof value('allocation.liquidity_eligible') === 'boolean')
  if (value('allocation.liquidity_eligible') === true) {
    add('allocation.liquidity_basis_verified', '流动性依据已核实', value('allocation.liquidity_basis_verified') === true)
    add('allocation.liquidity_evidence_hash', '流动性证据 SHA-256', hashValue('allocation.liquidity_evidence_hash'))
  }
  return [...new Map(missing.map(item => [item.path, item])).values()]
})

const suggestions = computed(() => review.value?.suggestions ?? null)
const autoFilledCount = computed(() => suggestions.value?.paths.filter(path => {
  const value = factValue(currentFacts.value, path)
  return value !== null && value !== undefined && value !== ''
}).length ?? 0)
const missingCount = computed(() => missingFacts.value.length)
const missingPaths = computed(() => missingFacts.value.map(item => item.path))

function applyPublicPrefill(): void {
  if (!review.value?.suggestions) return
  const facts = currentFacts.value
  mergeMissing(facts, review.value.suggestions.facts)
  setFactRows(facts)
  onlyMissing.value = true
  checkError.value = ''
  show(`已带出 ${autoFilledCount.value} 项公开数据，请补齐待补项`)
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

async function submitCheck(confirmed = false): Promise<void> {
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
    show(confirmed ? '交易前复核已确认并保存' : '交易前检查已保存')
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

function confirmCheck(): void {
  if (lot.value) return
  if (missingFacts.value.length) {
    onlyMissing.value = true
    const names = missingFacts.value.slice(0, 3).map(item => item.label).join('、')
    checkError.value = `还有 ${missingFacts.value.length} 项必填待补：${names}${missingFacts.value.length > 3 ? '…' : ''}`
    return
  }
  const statusRow = factRows.value.find(row => row.key === 'status')
  if (!statusRow) {
    checkError.value = '核验状态字段缺失，无法确认'
    return
  }
  updateFact(statusRow, 'verified')
  void submitCheck(true)
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
  else if (props.ledgerProductCode) void autoMatchShare()
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

<p v-if="lot" class="strategy-hint">当前批次 {{ lot }}<template v-if="ledgerProductCode"> · 账本产品 {{ ledgerProductCode }}</template>。读取复核前会按账本产品匹配最新公开份额；也可手动核对销售渠道与同份额代码。</p>
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
    <p v-if="ledgerProductCode" class="strategy-hint">
      渠道或代码不确定？
      <button class="rw-link-button" type="button" data-testid="strategy-share-match"
        :disabled="matchingShare || loading" @click="autoMatchShare">
        {{ matchingShare ? '正在匹配…' : '按账本产品自动匹配公开份额' }}
      </button>
    </p>

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

      <form class="strategy-form" @submit.prevent="submitCheck(false)">
        <h3>{{ lot.startsWith('trade:') ? '赎回到账事实核验' : lot ? '持仓赎回规则核验' : '交易前检查' }}</h3>
        <p class="rw-panel-sub">
          逐项核实正式条款、费用、底层资产和银行 App 证据。未知项目保持空白或“未核实”，保存后仍需所有阻碍项解除才能执行。金额字段以分为单位。
        </p>
        <div v-if="!lot" class="strategy-prefill" data-testid="strategy-prefill">
          <div class="strategy-prefill-copy">
            <strong>公开数据已带出 {{ autoFilledCount }} 项</strong>
            <span class="strategy-prefill-count" :class="{ 'is-ready': !missingCount }">待补 {{ missingCount }} 项</span>
            <p>条款版本、起购金额和策略族来自公开证据，只作建议；文件核验、费率、资产报告与当日 App 数据仍需你确认。</p>
          </div>
          <div class="strategy-prefill-actions">
            <button
              v-if="suggestions"
              class="button button-ghost button-small"
              type="button"
              data-testid="strategy-prefill-apply"
              :disabled="savingCheck || !review"
              @click="applyPublicPrefill"
            >
              重新带出公开数据
            </button>
            <button class="button button-ghost button-small" type="button" data-testid="strategy-prefill-toggle" @click="onlyMissing = !onlyMissing">
              {{ onlyMissing ? '查看全部字段' : '只看待补项' }}
            </button>
          </div>
        </div>
        <div class="strategy-structured-facts">
          <StrategyFactField
            v-for="row in editableFactRows"
            :key="row.key"
            :field-key="row.key"
            :model-value="row.original"
            :only-missing="onlyMissing"
            :missing-paths="missingPaths"
            @update:model-value="updateFact(row, $event)"
          />
        </div>
        <p v-if="!lot && onlyMissing && !missingCount" class="strategy-hint" role="status">必填项已全部补齐，可点“一键确认并保存”完成核验。</p>
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
            v-if="!lot"
            class="button button-primary button-small"
            type="button"
            data-testid="strategy-check-confirm"
            :disabled="savingCheck || savingMapping || loading || notDeployed || !mappingId"
            @click="confirmCheck"
          >
            {{ savingCheck ? '保存中…' : missingCount ? `待补 ${missingCount} 项` : '一键确认并保存' }}
          </button>
          <button
            :class="lot ? 'button button-primary button-small' : 'button button-ghost button-small'"
            type="submit"
            data-testid="strategy-check-save"
            :disabled="savingCheck || savingMapping || loading || notDeployed || !mappingId"
          >
            {{ savingCheck ? '保存中…' : lot ? '保存交易前检查' : '保存草稿' }}
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
.strategy-prefill {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px 16px;
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--card);
}
.strategy-prefill-copy {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  min-width: 0;
}
.strategy-prefill-copy strong { color: var(--ink); font-size: 13px; }
.strategy-prefill-count {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--field-bg);
  color: var(--warning-ink);
  font-size: 12px;
  font-weight: 650;
}
.strategy-prefill-count.is-ready { color: var(--green); }
.strategy-prefill-copy p {
  flex-basis: 100%;
  margin: 0;
  color: var(--ink-soft);
  font-size: 12px;
  line-height: 1.55;
}
.strategy-prefill-actions { display: flex; flex-wrap: wrap; gap: 8px; }
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
