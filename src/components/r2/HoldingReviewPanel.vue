<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import {
  formatDateShort,
  formatMoney,
  formatPct,
  formatPp,
  formatTerm,
} from '@/composables/useFormatters'
import type {
  DecisionEntry,
  HoldingReview,
  HoldingReviewCandidate,
  HoldingReviewSettingInput,
  Product,
} from '@/types/dashboard'
import ProductDetailDialog from '@/components/ProductDetailDialog.vue'

const props = defineProps<{
  reviews: HoldingReview[]
  today: string
  snapshotDate: string | null
  historyDate: string | null
}>()

const store = useDashboardStore()
const { show } = useToast()

interface SettingDraft {
  redemption_days: string | number
  arrival_days: string | number
  redemption_fee_bps: string | number
  purchase_fee_bps: string | number
  next_redeem_open_date: string
  notes: string
  verified_at: string
}

type HoldingReviewFilter = 'all' | 'replace' | 'watch' | 'hold' | 'window'

const expanded = ref<string | null>(null)
const expandedCandidates = reactive<Record<string, boolean>>({})
const searchQuery = ref('')
const searchOpen = ref(false)
const searchMenuOpensUp = ref(false)
const activeSearchOption = ref(-1)
const searchRoot = ref<HTMLElement | null>(null)
const reviewFilter = ref<HoldingReviewFilter>('all')
const savingProduct = ref('')
const detailOpen = ref(false)
const detailProduct = ref<Product | null>(null)
const decisionLot = ref<string | null>(null)
const decisionCandidate = ref<HoldingReviewCandidate | null>(null)
const decisionSaving = ref(false)
const drafts = reactive<Record<string, SettingDraft>>({})
const decisionForm = reactive({
  reason: '',
  expectation: '',
  verify_date: '',
})

const summary = computed(() => {
  const reviews = props.reviews
  return {
    total: reviews.length,
    replace: reviews.filter((item) => item.verdict === 'replace').length,
    watch: reviews.filter((item) => item.verdict === 'watch').length,
    hold: reviews.filter((item) => item.verdict === 'hold').length,
    window: reviews.filter((item) => item.reminder.level !== 'none').length,
  }
})

const reviewFilters = computed(() => [
  { key: 'all' as const, label: '全部', count: summary.value.total },
  { key: 'replace' as const, label: '建议替换', count: summary.value.replace },
  { key: 'watch' as const, label: '观察', count: summary.value.watch },
  { key: 'hold' as const, label: '继续持有', count: summary.value.hold },
  { key: 'window' as const, label: '到期/开放窗口', count: summary.value.window },
])

const filteredReviews = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase('zh-CN')
  return props.reviews.filter((review) => {
    const matchesFilter =
      reviewFilter.value === 'all' ||
      (reviewFilter.value === 'window'
        ? review.reminder.level !== 'none'
        : review.verdict === reviewFilter.value)
    if (!matchesFilter) return false
    if (!query) return true
    return reviewMatchesQuery(review, query)
  })
})

const searchSuggestions = computed(() => filteredReviews.value.slice(0, 8))

const hasActiveReviewFilters = computed(
  () => Boolean(searchQuery.value.trim()) || reviewFilter.value !== 'all',
)

const topCandidateMap = computed<Record<string, HoldingReviewCandidate | null>>(() =>
  Object.fromEntries(
    props.reviews.map((review) => [
      review.lot_id,
      review.candidates.find((item) => item.code === review.top_candidate_code) ||
        review.candidates[0] ||
        null,
    ]),
  ),
)

watch(
  () => props.reviews.map((item) => `${item.lot_id}:${item.generated_at}`).join('|'),
  () => {
    for (const review of props.reviews) {
      if (!drafts[review.lot_id]) ensureDraft(review)
    }
  },
  { immediate: true },
)

watch(searchSuggestions, (items) => {
  if (activeSearchOption.value >= items.length) activeSearchOption.value = -1
})

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
})

function reviewMatchesQuery(review: HoldingReview, query: string): boolean {
  return [
    review.product_name,
    review.product_code,
    review.issuer,
    review.risk_level,
    formatTerm(review.term_days, review.bucket),
    review.lot_id,
    review.verdict_label,
    review.reminder.text,
  ].some((value) => String(value ?? '').toLocaleLowerCase('zh-CN').includes(query))
}

function handleDocumentPointerDown(event: PointerEvent): void {
  if (!searchRoot.value?.contains(event.target as Node)) {
    searchOpen.value = false
    activeSearchOption.value = -1
  }
}

function openSearchMenu(): void {
  const anchor = searchRoot.value?.getBoundingClientRect()
  if (anchor) {
    const availableBelow = window.innerHeight - anchor.bottom
    const availableAbove = anchor.top
    searchMenuOpensUp.value =
      availableBelow < Math.min(340, window.innerHeight * 0.52) &&
      availableAbove > availableBelow
  }
  searchOpen.value = true
}

function selectSearchSuggestion(review: HoldingReview): void {
  searchQuery.value = review.product_code
  searchOpen.value = false
  activeSearchOption.value = -1
}

function handleSearchKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    searchOpen.value = false
    activeSearchOption.value = -1
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') {
    return
  }
  if (!searchOpen.value) openSearchMenu()
  const options = searchSuggestions.value
  if (!options.length) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeSearchOption.value = (activeSearchOption.value + 1) % options.length
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeSearchOption.value =
      activeSearchOption.value <= 0
        ? options.length - 1
        : activeSearchOption.value - 1
    return
  }
  if (event.key === 'Enter' && activeSearchOption.value >= 0) {
    event.preventDefault()
    const option = options[activeSearchOption.value]
    if (option) selectSearchSuggestion(option)
  }
}

function ensureDraft(review: HoldingReview): void {
  const setting = review.review_setting
  drafts[review.lot_id] = {
    redemption_days: setting.redemption_days ?? '',
    arrival_days: setting.arrival_days ?? '',
    redemption_fee_bps: setting.redemption_fee_bps,
    purchase_fee_bps: setting.purchase_fee_bps,
    next_redeem_open_date: setting.next_redeem_open_date,
    notes: setting.notes,
    verified_at: setting.verified_at,
  }
}

function optionalNumber(value: string | number): number | null {
  if (value === '' || value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function draftFor(review: HoldingReview): SettingDraft {
  if (!drafts[review.lot_id]) ensureDraft(review)
  return drafts[review.lot_id]
}

function toggle(review: HoldingReview): void {
  ensureDraft(review)
  expanded.value = expanded.value === review.lot_id ? null : review.lot_id
  if (expanded.value !== review.lot_id) return
  decisionLot.value = null
  decisionCandidate.value = null
}

async function saveSetting(review: HoldingReview): Promise<void> {
  const draft = draftFor(review)
  const input: HoldingReviewSettingInput = {
    redemption_days: optionalNumber(draft.redemption_days),
    arrival_days: optionalNumber(draft.arrival_days),
    redemption_fee_bps: Number(draft.redemption_fee_bps) || 0,
    purchase_fee_bps: Number(draft.purchase_fee_bps) || 0,
    next_redeem_open_date: draft.next_redeem_open_date,
    notes: draft.notes,
    verified_at: draft.verified_at,
  }
  savingProduct.value = review.product_code
  try {
    await store.saveHoldingReviewSetting(review.product_code, input)
    show('复核口径已保存，候选与盈亏平衡已重算')
  } catch (error) {
    show(error instanceof Error ? error.message : '复核口径保存失败', { error: true })
  } finally {
    savingProduct.value = ''
  }
}

async function saveCandidatePurchaseConfirm(
  candidate: HoldingReviewCandidate,
  value: string | number,
): Promise<void> {
  savingProduct.value = candidate.code
  try {
    await store.saveHoldingReviewSetting(candidate.code, {
      purchase_confirm_days: Number(value),
      verified_at: props.today,
    })
    show(`${candidate.code} 申购确认 T+${Number(value)} 已核验，等待期已重算`)
  } catch (error) {
    show(error instanceof Error ? error.message : '候选申购确认规则保存失败', {
      error: true,
    })
  } finally {
    savingProduct.value = ''
  }
}

function candidatePurchaseConfirmValue(event: Event): string {
  return (event.target as HTMLSelectElement).value
}

function openDetail(product: Product): void {
  detailProduct.value = product
  detailOpen.value = true
}

function candidateScopeLabel(review: HoldingReview): string {
  if (review.term_days === 0 || review.bucket === 'short' || review.bucket === 'cash') {
    return '短期 1–30 天'
  }
  if (review.bucket === 'medium') return '中期 31–100 天'
  if (review.bucket === 'long') return '长期 101 天+'
  return '同桶'
}

function switchWaitLabel(candidate: HoldingReviewCandidate): string {
  if (candidate.switch_wait_days === null) return '待核'
  return `${candidate.switch_wait_days} 天（${
    candidate.switch_wait_status === 'verified' ? '已核验' : '估算'
  }）`
}

function yieldLabel(
  value: number | null,
  status: 'available' | 'unavailable',
  digits = 2,
): string {
  return status === 'available' ? formatPct(value, digits) : '不可计算'
}

function candidateReasonItems(candidate: HoldingReviewCandidate): string[] {
  return candidate.reasons.filter(
    (reason) =>
      !candidate.data_gaps.some(
        (gap) => reason.includes(gap) || gap.includes(reason),
      ),
  )
}

function startDecision(review: HoldingReview, candidate: HoldingReviewCandidate): void {
  detailOpen.value = false
  decisionLot.value = review.lot_id
  decisionCandidate.value = candidate
  const currentYield = review.current.yield_pct
  const switchResult = candidate.switch
  const actionableNow = review.redemption.redeemable_now
  decisionForm.reason =
    `${actionableNow ? '持仓复核' : '到期后计划（锁定期内不可赎回）'} ` +
    `${review.evidence_date || props.today}：${review.product_name}（${review.product_code}）` +
    `${candidateScopeLabel(review)}候选 ${candidate.name}（${candidate.code}）期限调整参考年化 ${yieldLabel(candidate.yield_pct, candidate.yield_status)}，` +
    `当前 ${yieldLabel(currentYield, review.current.yield_status)}；本桶统一比较 ${candidate.comparison_days} 天、切换等待 ${switchWaitLabel(candidate)}、有效计息 ${candidate.effective_days ?? '待核'} 天，` +
    `费用 ¥${formatMoney(switchResult?.fee_drag ?? 0, 2)}，切换后预计多赚 ` +
    `¥${formatMoney(switchResult?.difference ?? 0, 2)}，盈亏平衡 ${formatPct(
      switchResult?.break_even_yield_pct,
      2,
    )}。${actionableNow ? '' : `当前${review.redemption.reason}，到期前不执行替换。`}`
  decisionForm.expectation =
    actionableNow
      ? `按 ${candidate.comparison_days} 天统一比较期执行替换，切换等待 ${switchWaitLabel(candidate)}、有效计息 ${candidate.effective_days ?? '待核'} 天，后续到期自动续作；先确认新产品额度与交易规则，` +
        `到验证日核对实际起息和收益是否达到测算。`
      : `锁定期内不操作；最早 ${review.redemption.available_date || '到期日'} 处理。到期前重新核验候选、额度、赎回 T+N 与费用，确认仍达到门槛后再写实际替换交易。`
  decisionForm.verify_date = review.verify_date
}

function cancelDecision(): void {
  decisionLot.value = null
  decisionCandidate.value = null
}

function reviewMeta(review: HoldingReview, candidate: HoldingReviewCandidate): Record<string, unknown> {
  const result = candidate.switch
  const currentYield = {
    product_code: review.product_code,
    product_name: review.product_name,
    found: review.current.found,
    yield_policy_version: review.current.yield_policy_version,
    reference_yield_pct: review.current.yield_pct,
    status: review.current.yield_status,
    reason: review.current.yield_reason,
    available_horizons: review.current.yield_available_horizons,
    normalized_weights: review.current.yield_normalized_weights,
    data_date: review.current.data_date || null,
    snapshot_date: review.evidence_date,
  }
  const candidateYield = {
    product_code: candidate.code,
    product_name: candidate.name,
    yield_policy_version: candidate.yield_policy_version,
    reference_yield_pct: candidate.yield_pct,
    status: candidate.yield_status,
    reason: candidate.yield_reason,
    available_horizons: candidate.yield_available_horizons,
    normalized_weights: candidate.yield_normalized_weights,
    data_date: candidate.data_date || null,
    snapshot_date: review.evidence_date,
  }
  return {
    review_version: review.review_version,
    yield_policy_version: review.yield_policy_version,
    yield_policy: {
      version: review.yield_policy_version,
      snapshot_date: review.evidence_date,
      current: currentYield,
      candidate: candidateYield,
    },
    holding_lot_id: review.lot_id,
    holding_code: review.product_code,
    holding_name: review.product_name,
    candidate_code: candidate.code,
    candidate_name: candidate.name,
    snapshot_date: review.evidence_date,
    evidence_date: review.evidence_date,
    verify_date: decisionForm.verify_date,
    horizon_days: candidate.comparison_days,
    holding_horizon_days: review.horizon_days,
    switch_wait_days: candidate.switch_wait_days,
    switch_wait_status: candidate.switch_wait_status,
    switch_wait_source: candidate.switch_wait_source,
    effective_days: candidate.effective_days,
    rollover_gap_days: candidate.rollover_gap_days,
    min_yield_edge_pp: review.thresholds.min_yield_edge_pp,
    min_gain_amount: candidate.min_gain_amount,
    min_gain_rule_pct: candidate.min_gain_rule_pct,
    min_gain_base_days: candidate.min_gain_base_days,
    min_gain_floor: candidate.min_gain_floor,
    current_yield_pct: review.current.yield_pct,
    current_yield_status: review.current.yield_status,
    current_yield_reason: review.current.yield_reason,
    current_yield_available_horizons: review.current.yield_available_horizons,
    current_yield_normalized_weights: review.current.yield_normalized_weights,
    candidate_yield_pct: candidate.yield_pct,
    candidate_yield_status: candidate.yield_status,
    candidate_yield_reason: candidate.yield_reason,
    candidate_yield_available_horizons: candidate.yield_available_horizons,
    candidate_yield_normalized_weights: candidate.yield_normalized_weights,
    candidate_yield_policy_version: candidate.yield_policy_version,
    yield_gap_pp: candidate.yield_gap_pp,
    break_even_yield_pct: result?.break_even_yield_pct ?? null,
    difference: result?.difference ?? 0,
    fee_drag: result?.fee_drag ?? 0,
    verdict: candidate.verdict,
    redeemable_now: review.redemption.redeemable_now,
    planned_action: review.redemption.redeemable_now
      ? 'replace_now'
      : 'replace_at_maturity',
  }
}

async function saveDecision(review: HoldingReview): Promise<void> {
  const candidate = decisionCandidate.value
  if (!candidate) return
  if (!decisionForm.reason.trim()) {
    show('请填写替换理由', { error: true })
    return
  }
  decisionSaving.value = true
  try {
    const actionableNow = review.redemption.redeemable_now
    const decision = await store.createDecision({
      date: props.today,
      product_name: actionableNow
        ? `${review.product_name} → ${candidate.name}`
        : `${review.product_name}（到期后计划） → ${candidate.name}`,
      action: actionableNow ? '切换' : '观察',
      reason: decisionForm.reason,
      expectation: decisionForm.expectation,
      invalidation_condition:
        '到验证日若实际起息、到账、费用或比较期收益未达到本次测算，或当前产品已不再锁定时，重新评估；若候选额度、风险、期限或赎回规则恶化，则取消替换。',
      actual_result: '',
      strategy_version: review.review_version,
      target_annualized: 3,
      bucket_plan: { short: 30, medium: 35, long: 35, max_single: 30 },
      evaluation_at: ['holding', 'maturity'],
      evidence_date: review.evidence_date || props.today,
      verify_date: decisionForm.verify_date,
      review_meta: reviewMeta(review, candidate),
      rating: '待评估',
    })
    show(
      `${actionableNow ? '替换决策' : '到期后计划'}已写入决策日志 #${decision.decision.id}，验证日 ${
        decisionForm.verify_date || '待定'
      }`,
    )
    cancelDecision()
  } catch (error) {
    show(error instanceof Error ? error.message : '替换决策保存失败', { error: true })
  } finally {
    decisionSaving.value = false
  }
}

function verdictClass(review: HoldingReview): string {
  return `is-${review.verdict}`
}

function candidateClass(candidate: HoldingReviewCandidate): string {
  return `is-${candidate.verdict}`
}

function topCandidate(review: HoldingReview): HoldingReviewCandidate | null {
  return (
    review.candidates.find((item) => item.code === review.top_candidate_code) ||
    review.candidates[0] ||
    null
  )
}

function orderedCandidates(review: HoldingReview): HoldingReviewCandidate[] {
  const top = topCandidate(review)
  if (!top) return review.candidates
  return [top, ...review.candidates.filter((item) => item.code !== top.code)]
}

function visibleCandidates(review: HoldingReview): HoldingReviewCandidate[] {
  const list = orderedCandidates(review)
  return expandedCandidates[review.lot_id] ? list : list.slice(0, 3)
}

function toggleCandidates(review: HoldingReview): void {
  expandedCandidates[review.lot_id] = !expandedCandidates[review.lot_id]
}

function yieldBarWidth(value: number | null | undefined): string {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return '0%'
  return `${Math.min(100, (number / 6) * 100)}%`
}

function compareTitle(review: HoldingReview): string {
  if (review.redemption.redeemable_now) return '当前可执行对比';
  if (review.redemption.state === 'window') return '到期窗口对比 · 当前仍不可赎回';
  return '到期后对比 · 当前不可赎回';
}

function compareTagClass(
  review: HoldingReview,
  candidate: HoldingReviewCandidate,
): string {
  return review.redemption.redeemable_now ? candidateClass(candidate) : 'is-locked';
}

function quotaLabel(candidate: HoldingReviewCandidate): string {
  if (candidate.quota_available === null) return '未核验'
  if (candidate.quota_available <= 0) return '额度 0'
  return `¥${formatMoney(candidate.quota_available, 0)}`
}

function reminderClass(review: HoldingReview): string {
  return `is-${review.reminder.level}`
}

function decisionSummary(item: DecisionEntry | null): string {
  if (!item) return ''
  return `#${item.id} ${item.date} ${item.action} · 验证日 ${item.verify_date || '未填'}`
}

function clearReviewFilters(): void {
  searchQuery.value = ''
  reviewFilter.value = 'all'
  searchOpen.value = false
  activeSearchOption.value = -1
}
</script>

<template>
  <div class="rw-panel-body holding-review-body">
    <div class="rw-toolbar">
      <div class="rw-card-heading">
        <p class="kicker">HOLDING REVIEW</p>
        <strong class="rw-panel-title">当前持仓 vs 同桶候选</strong>
        <p class="rw-panel-sub">
          用最新产品快照逐只复核。短、中、长期限桶统一按 30、100、360 天比较；本次切换等待的赎回、到账和申购确认时间不计收益，到期后的自动续作不再重复扣空档。日开持仓改看短期限候选。
        </p>
      </div>
      <div class="rw-toolbar-actions">
        <span class="r2-head-chip">快照 {{ snapshotDate || '待核' }}</span>
      </div>
    </div>

    <div class="rw-stat-row rw-stat-row-spaced hr-filter-row" role="group" aria-label="按复核结论筛选">
      <button
        v-for="filter in reviewFilters"
        :key="filter.key"
        type="button"
        class="rw-stat-chip hr-filter-chip"
        :class="{ 'is-active': reviewFilter === filter.key }"
        :data-filter="filter.key"
        :aria-pressed="reviewFilter === filter.key"
        @click="reviewFilter = filter.key"
      >
        {{ filter.label }} <strong>{{ filter.count }}</strong>
      </button>
    </div>

    <div v-if="reviews.length === 0" class="rw-empty">
      还没有已确认持仓。先在「交易与持仓」中登记买入并确认，这里才会生成逐只复核。
    </div>

    <template v-else>
      <section class="hr-review-controls" aria-label="持仓复核筛选">
        <div ref="searchRoot" class="hr-search-shell">
          <label class="hr-search">
            <span class="hr-search-icon" aria-hidden="true">⌕</span>
            <input
              v-model="searchQuery"
              type="search"
              autocomplete="off"
              role="combobox"
              aria-label="搜索持仓"
              aria-autocomplete="list"
              aria-controls="holding-review-search-options"
              :aria-expanded="searchOpen"
              placeholder="搜索持仓名称、代码、发行方或批次"
              @click="openSearchMenu"
              @focus="openSearchMenu"
              @input="openSearchMenu"
              @keydown="handleSearchKeydown"
            />
            <span class="hr-search-caret" aria-hidden="true">⌄</span>
          </label>

          <div
            v-if="searchOpen"
            id="holding-review-search-options"
            class="hr-search-menu"
            :class="{ 'opens-up': searchMenuOpensUp }"
            role="listbox"
            aria-label="持仓搜索建议"
          >
            <div class="hr-search-menu-head">
              <span>{{ searchQuery.trim() ? '匹配持仓' : '当前持仓' }}</span>
              <span>{{ searchSuggestions.length }} 只</span>
            </div>
            <button
              v-for="(review, index) in searchSuggestions"
              :key="review.lot_id"
              type="button"
              class="hr-search-option"
              :class="{ 'is-active': activeSearchOption === index }"
              role="option"
              :aria-selected="activeSearchOption === index"
              :data-review-code="review.product_code"
              @mouseenter="activeSearchOption = index"
              @focus="activeSearchOption = index"
              @click="selectSearchSuggestion(review)"
            >
              <span class="hr-search-option-copy">
                <strong>{{ review.product_name }}</strong>
                <small>
                  {{ review.product_code }} · {{ formatTerm(review.term_days, review.bucket) }}
                  · 批次 {{ review.lot_id }}
                </small>
              </span>
              <span class="hr-search-option-meta">
                <span class="hr-verdict" :class="verdictClass(review)">
                  {{ review.verdict_label }}
                </span>
                <small v-if="review.reminder.level !== 'none'">
                  {{ review.reminder.text }}
                </small>
              </span>
            </button>
            <div v-if="searchSuggestions.length === 0" class="hr-search-menu-empty">
              没有匹配的持仓，试试产品代码或发行方名称。
            </div>
          </div>
        </div>

        <div class="hr-filter-meta" aria-live="polite">
          <span>显示 {{ filteredReviews.length }} / {{ reviews.length }} 只</span>
          <button
            v-if="hasActiveReviewFilters"
            type="button"
            class="hr-filter-clear"
            @click="clearReviewFilters"
          >
            清除筛选
          </button>
        </div>
      </section>

      <div v-if="filteredReviews.length === 0" class="rw-empty hr-filter-empty">
        <p>没有符合当前搜索与筛选条件的持仓。</p>
        <button type="button" class="rw-button is-secondary" @click="clearReviewFilters">
          清除筛选
        </button>
      </div>

      <div v-else class="hr-list">
      <article
        v-for="review in filteredReviews"
        :key="review.lot_id"
        class="hr-card"
        :data-verdict="review.verdict"
        :data-reminder="review.reminder.level"
      >
        <header class="hr-card-head">
          <div class="hr-card-title">
            <strong>{{ review.product_name }}</strong>
            <small>
              {{ review.product_code }} · {{ review.risk_level }} ·
              {{ formatTerm(review.term_days, review.bucket) }} · 批次
              {{ review.lot_id }}
            </small>
          </div>
          <div class="hr-card-badges">
            <span class="hr-verdict" :class="verdictClass(review)">
              {{ review.verdict_label }}
            </span>
            <span
              v-if="review.reminder.level !== 'none'"
              class="hr-reminder"
              :class="reminderClass(review)"
            >
              {{ review.reminder.text }}
            </span>
          </div>
        </header>

        <div class="hr-metrics">
          <span>未赎回成本本金 <strong>¥{{ formatMoney(review.amount, 0) }}</strong></span>
          <span>
            到期日
            <strong>{{ review.maturity_date ? formatDateShort(review.maturity_date) : '日开/无' }}</strong>
          </span>
          <span>
            下一赎回开放日
            <strong>
              {{
                review.next_redeem_open_date
                  ? formatDateShort(review.next_redeem_open_date)
                  : '待填'
              }}
            </strong>
          </span>
          <span>
            比较期限 <strong>{{ review.horizon_days }} 天</strong>
          </span>
          <span>
            当前期限调整参考年化
            <strong>{{ yieldLabel(review.current.yield_pct, review.current.yield_status) }}</strong>
          </span>
          <span>
            1M / 3M / 6M / 1Y
            <strong>
              {{ formatPct(review.current.return_1m, 2) }} /
              {{ formatPct(review.current.return_3m, 2) }} /
              {{ formatPct(review.current.return_6m, 2) }} /
              {{ formatPct(review.current.return_1y, 2) }}
            </strong>
          </span>
          <span>
            赎回口径
            <strong>
              {{
                review.review_setting.complete
                  ? `T+${review.review_setting.redemption_days} / 到账 T+${review.review_setting.arrival_days}`
                  : '估算 T+1 / T+0'
              }}
            </strong>
          </span>
          <span>数据日 <strong>{{ review.current.data_date || '未获取到' }}</strong></span>
        </div>

        <div
          class="hr-redemption"
          :class="{
            'is-open': review.redemption.redeemable_now,
            'is-locked': !review.redemption.redeemable_now,
          }"
        >
          <strong>{{ review.redemption.redeemable_now ? '当前可赎回' : '当前不可赎回' }}</strong>
          <span>{{ review.redemption.reason }}</span>
        </div>

        <p class="hr-summary">{{ review.summary }}</p>
        <div v-if="review.data_gaps.length" class="hr-gaps">
          <span v-for="gap in review.data_gaps" :key="gap">{{ gap }}</span>
        </div>

        <template v-for="top in [topCandidateMap[review.lot_id]]" :key="`top-${review.lot_id}`">
          <section v-if="top" class="hr-compare" aria-label="首选候选对比">
            <div class="hr-compare-head">
              <div>
                <p class="kicker">BEST MATCH</p>
                <strong class="rw-panel-title">
                  首选{{ candidateScopeLabel(review) }}候选
                </strong>
              </div>
              <span class="hr-compare-tag" :class="compareTagClass(review, top)">
                {{ compareTitle(review) }}
              </span>
            </div>

            <div class="hr-compare-grid">
              <div class="hr-compare-col is-current">
                <span class="hr-compare-label">当前持仓</span>
                <strong class="hr-compare-name">{{ review.product_name }}</strong>
                <div class="hr-compare-yield">
                  <span>期限调整参考年化</span>
                  <strong>{{ yieldLabel(review.current.yield_pct, review.current.yield_status) }}</strong>
                </div>
                <div class="hr-compare-bar">
                  <span :style="{ width: yieldBarWidth(review.current.yield_pct) }"></span>
                </div>
                <small>
                  {{ formatTerm(review.term_days, review.bucket) }} ·
                  {{ formatPct(review.current.return_1m, 2) }} /
                  {{ formatPct(review.current.return_3m, 2) }} /
                  {{ formatPct(review.current.return_6m, 2) }} /
                  {{ formatPct(review.current.return_1y, 2) }}
                </small>
              </div>

              <div class="hr-compare-arrow" aria-hidden="true">→</div>

              <div class="hr-compare-col is-candidate">
                <span class="hr-compare-label">首选候选</span>
                <button
                  type="button"
                  class="hr-compare-name hr-product-link"
                  @click="openDetail(top.product)"
                >
                  {{ top.name }}
                </button>
                <div class="hr-compare-yield">
                  <span>期限调整参考年化</span>
                  <strong>{{ yieldLabel(top.yield_pct, top.yield_status) }}</strong>
                  <em :class="{ 'is-positive': (top.yield_gap_pp ?? 0) > 0 }">
                    {{ formatPp(top.yield_gap_pp, 2, true) }}
                  </em>
                </div>
                <div class="hr-compare-bar is-candidate">
                  <span :style="{ width: yieldBarWidth(top.yield_pct) }"></span>
                </div>
                <small>
                  {{ formatTerm(top.term_days, top.bucket) }} · 比较
                  {{ top.comparison_days }} 天 · 切换等待
                  {{ switchWaitLabel(top) }} · 有效
                  {{ top.effective_days ?? '待核' }} 天 ·
                  {{ formatPct(top.return_1m, 2) }} /
                  {{ formatPct(top.return_3m, 2) }} /
                  {{ formatPct(top.return_6m, 2) }} /
                  {{ formatPct(top.return_1y, 2) }}
                </small>
              </div>
            </div>

            <div class="hr-compare-result">
              <div>
                <span>预计多赚</span>
                <strong :class="{ 'is-positive': (top.switch?.difference ?? 0) > 0 }">
                  {{ top.switch ? `¥${formatMoney(top.switch.difference, 2)}` : '—' }}
                </strong>
              </div>
              <div>
                <span>切换等待</span>
                <strong>{{ switchWaitLabel(top) }}</strong>
              </div>
              <div>
                <span>有效计息</span>
                <strong>{{ top.effective_days ?? '待核' }} 天</strong>
              </div>
              <div>
                <span>盈亏平衡</span>
                <strong>{{ formatPct(top.switch?.break_even_yield_pct, 2) }}</strong>
              </div>
            </div>
          </section>
        </template>

        <div class="hr-actions">
          <button type="button" class="rw-button is-secondary" @click="toggle(review)">
            {{ expanded === review.lot_id ? '收起候选' : `展开候选（${review.candidates.length}）` }}
          </button>
          <span class="rw-muted">
            门槛：年化差 ≥ {{ review.thresholds.min_yield_edge_pp }}pp；净多赚按本金和候选比较期计算
            （90 天基准 {{ review.thresholds.min_gain_rule_pct }}%，最低 ¥{{ review.thresholds.min_gain_floor }}）
          </span>
        </div>

        <section v-if="expanded === review.lot_id" class="hr-expanded">
          <form class="hr-settings" @submit.prevent="saveSetting(review)">
            <div class="hr-settings-head">
              <div class="hr-settings-heading">
                <strong>赎回与费用口径</strong>
                <small>只保存能从 App 或产品说明书确认的事实；估算值执行前仍需逐项核验。</small>
              </div>
              <span
                class="hr-settings-state"
                :class="review.review_setting.complete ? 'is-verified' : 'is-estimated'"
              >
                {{ review.review_setting.complete ? 'T+N 已核验' : 'T+N 为估算' }}
              </span>
            </div>
            <div class="hr-settings-grid">
              <label class="rw-field">
                <span>赎回确认 T+N</span>
                <input v-model="draftFor(review).redemption_days" type="number" min="0" max="30" step="1" placeholder="待核" />
              </label>
              <label class="rw-field">
                <span>赎回到账 T+N</span>
                <input v-model="draftFor(review).arrival_days" type="number" min="0" max="30" step="1" placeholder="待核" />
              </label>
              <label class="rw-field">
                <span>赎回费（bp）</span>
                <input v-model="draftFor(review).redemption_fee_bps" type="number" min="0" max="500" step="1" />
              </label>
              <label class="rw-field">
                <span>申购费（bp）</span>
                <input v-model="draftFor(review).purchase_fee_bps" type="number" min="0" max="500" step="1" />
              </label>
              <label class="rw-field">
                <span>口径核验日期</span>
                <input v-model="draftFor(review).verified_at" type="date" />
              </label>
              <label class="rw-field">
                <span>下一赎回开放日</span>
                <input v-model="draftFor(review).next_redeem_open_date" type="date" />
              </label>
              <div class="hr-dynamic-threshold is-threshold">
                <div>
                  <span>动态最低多赚门槛</span>
                  <strong>¥{{ formatMoney(review.thresholds.min_gain_amount, 2) }}</strong>
                </div>
                <small>
                  本金 ¥{{ formatMoney(review.amount, 0) }} ×
                  {{ review.thresholds.min_gain_rule_pct }}% ×
                  {{ review.horizon_days }}/{{ review.thresholds.min_gain_base_days }} 天，最低 ¥{{ review.thresholds.min_gain_floor }}
                </small>
              </div>
              <label class="rw-field is-wide">
                <span>赎回规则备注</span>
                <textarea v-model="draftFor(review).notes" rows="3" maxlength="1000" placeholder="例：最短持有 14 天，赎回 T+1 确认、T+1 到账，赎回费 0"></textarea>
              </label>
            </div>
            <div class="hr-settings-foot">
              <div class="hr-settings-summary">
                <span><small>统一比较</small><strong>{{ review.horizon_days }} 天</strong></span>
                <span>
                  <small>当前 T+N</small>
                  <strong>{{ review.review_setting.complete ? '已核验' : '估算' }}</strong>
                </span>
                <span><small>续作空档</small><strong>{{ review.review_setting.rollover_gap_days }} 天</strong></span>
              </div>
              <button type="submit" class="rw-button" :disabled="savingProduct === review.product_code">
                {{ savingProduct === review.product_code ? '保存中…' : '保存并重算' }}
              </button>
            </div>
          </form>

          <div v-if="review.candidates.length === 0" class="rw-empty is-compact">
            {{ candidateScopeLabel(review) }}、同风险档暂无满足起购金额的候选；继续持有并等待下一期快照。
          </div>
          <div v-else class="hr-candidate-list">
            <div class="hr-candidate-list-head">
              <strong>{{ candidateScopeLabel(review) }}候选</strong>
              <span>同桶统一比较期限；首选置顶，其余按结论和期限调整参考年化排序；默认显示前 3 个</span>
            </div>
            <article
              v-for="candidate in visibleCandidates(review)"
              :key="candidate.code"
              class="hr-candidate"
              :class="{ 'is-top': candidate.code === topCandidateMap[review.lot_id]?.code }"
            >
              <div class="hr-candidate-head">
                <div class="hr-candidate-title">
                  <div class="hr-candidate-title-line">
                    <span
                      v-if="candidate.code === topCandidateMap[review.lot_id]?.code"
                      class="hr-top-tag"
                    >
                      首选
                    </span>
                    <button
                      type="button"
                      class="hr-product-link"
                      @click="openDetail(candidate.product)"
                    >
                      {{ candidate.name }}
                    </button>
                  </div>
                  <small>
                    <span>{{ candidate.code }}</span>
                    <span>{{ candidate.issuer }}</span>
                    <span>{{ candidate.evidence_label }}</span>
                    <span>数据 {{ candidate.data_date || '未获取到' }}</span>
                  </small>
                </div>
                <span
                  class="hr-candidate-verdict"
                  :class="review.redemption.redeemable_now ? candidateClass(candidate) : 'is-locked'"
                >
                  {{ candidate.verdict_label }}
                </span>
              </div>

              <div class="hr-candidate-scoreboard">
                <div class="hr-candidate-kpi is-yield">
                  <span>期限调整参考年化</span>
                  <div>
                    <strong>{{ yieldLabel(candidate.yield_pct, candidate.yield_status) }}</strong>
                    <em :class="{ 'is-positive': (candidate.yield_gap_pp ?? 0) > 0 }">
                      {{ formatPp(candidate.yield_gap_pp, 2, true) }}
                    </em>
                  </div>
                </div>
                <div class="hr-candidate-kpi is-gain">
                  <span>切换后预计多赚</span>
                  <div>
                    <strong>
                      {{ candidate.switch ? `¥${formatMoney(candidate.switch.difference, 2)}` : '—' }}
                    </strong>
                    <small>门槛 ¥{{ formatMoney(candidate.min_gain_amount, 2) }}</small>
                  </div>
                </div>
                <div class="hr-candidate-kpi is-break-even">
                  <span>盈亏平衡</span>
                  <strong>{{ formatPct(candidate.switch?.break_even_yield_pct, 2) }}</strong>
                </div>
                <div class="hr-candidate-kpi is-effective">
                  <span>有效计息</span>
                  <div>
                    <strong>{{ candidate.effective_days ?? '待核' }} 天</strong>
                    <small>统一比较 {{ candidate.comparison_days }} 天</small>
                  </div>
                </div>
              </div>

              <label
                class="hr-candidate-rule"
                :class="{
                  'is-estimated': candidate.switch_wait_status === 'estimated',
                  'is-verified': candidate.switch_wait_status === 'verified',
                }"
              >
                <span class="hr-candidate-rule-label">申购确认 T+N</span>
                <div class="hr-candidate-rule-controls">
                  <select
                    :value="candidate.purchase_confirm_days ?? 1"
                    :disabled="savingProduct === candidate.code"
                    aria-label="申购确认 T+N"
                    @change="saveCandidatePurchaseConfirm(candidate, candidatePurchaseConfirmValue($event))"
                  >
                    <option value="0">T+0</option>
                    <option value="1">T+1</option>
                    <option value="2">T+2</option>
                    <option value="3">T+3</option>
                  </select>
                  <span
                    class="hr-wait-badge"
                    :class="`is-${candidate.switch_wait_status}`"
                    :title="candidate.switch_wait_source"
                  >
                    {{ switchWaitLabel(candidate) }}
                  </span>
                  <button
                    type="button"
                    class="rw-link-button hr-rule-verify"
                    :disabled="savingProduct === candidate.code"
                    @click="saveCandidatePurchaseConfirm(candidate, candidate.purchase_confirm_days ?? 1)"
                  >
                    核验 T+{{ candidate.purchase_confirm_days ?? 1 }}
                  </button>
                </div>
                <small :title="candidate.switch_wait_source">
                  {{ candidate.switch_wait_source }}
                </small>
              </label>

              <div class="hr-candidate-facts">
                <span>
                  <small>期限</small>
                  <strong>{{ formatTerm(candidate.term_days, candidate.bucket) }}</strong>
                </span>
                <span>
                  <small>1M / 3M / 6M / 1Y</small>
                  <strong>
                    {{ formatPct(candidate.return_1m, 2) }} /
                    {{ formatPct(candidate.return_3m, 2) }} /
                    {{ formatPct(candidate.return_6m, 2) }} /
                    {{ formatPct(candidate.return_1y, 2) }}
                  </strong>
                </span>
                <span>
                  <small>综合年费</small>
                  <strong>{{ candidate.fee_bps === null ? '—' : `${candidate.fee_bps}bp` }}</strong>
                </span>
                <span>
                  <small>额度</small>
                  <strong :class="{ 'is-warning': candidate.quota_available === null || candidate.quota_available <= 0 }">
                    {{ quotaLabel(candidate) }}
                  </strong>
                </span>
              </div>

              <div class="hr-mini-compare">
                <div class="hr-mini-label is-current">
                  <span>当前期限调整参考年化</span>
                  <strong>{{ yieldLabel(review.current.yield_pct, review.current.yield_status) }}</strong>
                </div>
                <div class="hr-mini-track">
                  <span
                    class="hr-mini-current"
                    :style="{ width: yieldBarWidth(review.current.yield_pct) }"
                  ></span>
                  <span
                    class="hr-mini-candidate"
                    :class="{ 'is-better': (candidate.yield_gap_pp ?? 0) > 0 }"
                    :style="{ width: yieldBarWidth(candidate.yield_pct) }"
                  ></span>
                </div>
                <div class="hr-mini-label is-candidate">
                  <span>候选期限调整参考年化</span>
                  <strong>{{ yieldLabel(candidate.yield_pct, candidate.yield_status) }}</strong>
                </div>
              </div>

              <div class="hr-candidate-insights">
                <span class="hr-candidate-insights-title">判断依据</span>
                <ul>
                  <li v-for="reason in candidateReasonItems(candidate)" :key="reason">{{ reason }}</li>
                </ul>
              </div>

              <div v-if="candidate.data_gaps.length" class="hr-candidate-gaps">
                <span class="hr-candidate-insights-title">待核项</span>
                <div class="hr-gaps">
                  <span v-for="gap in candidate.data_gaps" :key="gap">{{ gap }}</span>
                </div>
              </div>

              <div class="hr-row-actions">
                <button type="button" class="rw-link-button" @click="openDetail(candidate.product)">
                  查看产品详情
                </button>
                <button
                  v-if="candidate.verdict === 'replace'"
                  type="button"
                  class="rw-button is-secondary hr-plan-action"
                  @click="startDecision(review, candidate)"
                >
                  {{ review.redemption.redeemable_now ? '记录替换决策' : '记录到期计划' }}
                </button>
              </div>
            </article>
            <button
              v-if="review.candidates.length > 3"
              type="button"
              class="rw-link-button hr-show-all"
              @click="toggleCandidates(review)"
            >
              {{
                expandedCandidates[review.lot_id]
                  ? '收起候选'
                  : `查看其余 ${review.candidates.length - 3} 个候选`
              }}
            </button>
          </div>

          <div v-if="review.decision" class="hr-decision">
            <span class="rw-type-badge">最近决策</span>
            <strong>{{ review.decision.product_name }}</strong>
            <span>{{ decisionSummary(review.decision) }}</span>
            <span v-if="review.decision.verify_date">
              到 {{ review.decision.verify_date }} 核对实际到账与实际收益
            </span>
          </div>
          <div v-else class="hr-decision is-empty">
            尚无替换决策记录。候选达到“建议替换”后，可在这里写入理由、证据日和验证日。
          </div>

          <form
            v-if="decisionLot === review.lot_id && decisionCandidate"
            class="hr-decision-form"
            @submit.prevent="saveDecision(review)"
          >
            <div class="hr-settings-head">
              <strong>记录替换决策：{{ decisionCandidate.name }}</strong>
              <button type="button" class="rw-link-button" @click="cancelDecision">取消</button>
            </div>
            <label class="rw-field is-wide">
              <span>替换理由（含证据日与量化门槛）</span>
              <textarea v-model="decisionForm.reason" rows="3" maxlength="1000" required></textarea>
            </label>
            <label class="rw-field is-wide">
              <span>预期与执行条件</span>
              <textarea v-model="decisionForm.expectation" rows="2" maxlength="1000"></textarea>
            </label>
            <label class="rw-field">
              <span>事后验证日期</span>
              <input v-model="decisionForm.verify_date" type="date" />
            </label>
            <div class="hr-settings-foot">
              <span>写入后可在「决策与评估」查看和事后打分。</span>
              <button type="submit" class="rw-button" :disabled="decisionSaving">
                {{ decisionSaving ? '保存中…' : '写入决策日志' }}
              </button>
            </div>
          </form>
        </section>
      </article>
      </div>
    </template>

    <ProductDetailDialog
      v-model:open="detailOpen"
      :product="detailProduct"
      :snapshot-date="snapshotDate"
      :history-date="historyDate"
    />
  </div>
</template>
