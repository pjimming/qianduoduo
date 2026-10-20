<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
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
  idle_days: string | number
  compare_horizon_days: string | number
  min_gain_amount: string | number
  next_redeem_open_date: string
  notes: string
  verified_at: string
}

const expanded = ref<string | null>(null)
const expandedCandidates = reactive<Record<string, boolean>>({})
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

function ensureDraft(review: HoldingReview): void {
  const setting = review.review_setting
  drafts[review.lot_id] = {
    redemption_days: setting.redemption_days ?? '',
    arrival_days: setting.arrival_days ?? '',
    redemption_fee_bps: setting.redemption_fee_bps,
    purchase_fee_bps: setting.purchase_fee_bps,
    idle_days: setting.idle_days ?? '',
    compare_horizon_days: setting.compare_horizon_days,
    min_gain_amount: setting.min_gain_amount,
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
    idle_days: optionalNumber(draft.idle_days),
    compare_horizon_days: Number(draft.compare_horizon_days) || 30,
    min_gain_amount: Number(draft.min_gain_amount) || 10,
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

function openDetail(product: Product): void {
  detailProduct.value = product
  detailOpen.value = true
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
    `同期限候选 ${candidate.name}（${candidate.code}）参考年化 ${formatPct(candidate.yield_pct, 2)}，` +
    `当前 ${formatPct(currentYield, 2)}；比较 ${review.horizon_days} 天、空档 ${review.thresholds.idle_days} 天，` +
    `费用 ¥${formatMoney(switchResult?.fee_drag ?? 0, 2)}，切换后预计多赚 ` +
    `¥${formatMoney(switchResult?.difference ?? 0, 2)}，盈亏平衡 ${formatPct(
      switchResult?.break_even_yield_pct,
      2,
    )}。${actionableNow ? '' : `当前${review.redemption.reason}，到期前不执行替换。`}`
  decisionForm.expectation =
    actionableNow
      ? `按 ${review.horizon_days} 天比较期执行替换，先确认赎回 T+${review.review_setting.redemption_days ?? 'N'}、` +
        `到账 T+${review.review_setting.arrival_days ?? 'N'} 与新产品额度；到验证日核对实际到账、起息和收益是否达到测算。`
      : `锁定期内不操作；最早 ${review.redemption.available_date || '到期日'} 处理。到期前重新核验候选、额度、赎回 T+N 与费用，确认仍达到门槛后再写实际替换交易。`
  decisionForm.verify_date = review.verify_date
}

function cancelDecision(): void {
  decisionLot.value = null
  decisionCandidate.value = null
}

function reviewMeta(review: HoldingReview, candidate: HoldingReviewCandidate): Record<string, unknown> {
  const result = candidate.switch
  return {
    review_version: 'r2-holding-review-v1',
    holding_lot_id: review.lot_id,
    holding_code: review.product_code,
    holding_name: review.product_name,
    candidate_code: candidate.code,
    candidate_name: candidate.name,
    snapshot_date: review.evidence_date,
    evidence_date: review.evidence_date,
    verify_date: decisionForm.verify_date,
    horizon_days: review.horizon_days,
    idle_days: review.thresholds.idle_days,
    min_yield_edge_pp: review.thresholds.min_yield_edge_pp,
    min_gain_amount: review.thresholds.min_gain_amount,
    current_yield_pct: review.current.yield_pct,
    candidate_yield_pct: candidate.yield_pct,
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
      actual_result: '',
      strategy_version: 'r2-holding-review-v1',
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
</script>

<template>
  <div class="rw-panel-body holding-review-body">
    <div class="rw-toolbar">
      <div class="rw-card-heading">
        <p class="kicker">HOLDING REVIEW</p>
        <strong class="rw-panel-title">当前持仓 vs 同期限候选</strong>
        <p class="rw-panel-sub">
          用最新产品快照逐只复核，先算赎回、空档和费用后的盈亏平衡，再给出继续持有、观察或建议替换。研究排序不等于买入指令。
        </p>
      </div>
      <div class="rw-toolbar-actions">
        <span class="r2-head-chip">快照 {{ snapshotDate || '待核' }}</span>
      </div>
    </div>

    <div class="rw-stat-row rw-stat-row-spaced">
      <span class="rw-stat-chip">在持 <strong>{{ summary.total }}</strong></span>
      <span class="rw-stat-chip" :class="{ 'is-warn': summary.replace > 0 }">
        建议替换 <strong>{{ summary.replace }}</strong>
      </span>
      <span class="rw-stat-chip" :class="{ 'is-warn': summary.watch > 0 }">
        观察 <strong>{{ summary.watch }}</strong>
      </span>
      <span class="rw-stat-chip">继续持有 <strong>{{ summary.hold }}</strong></span>
      <span class="rw-stat-chip" :class="{ 'is-warn': summary.window > 0 }">
        到期/开放窗口 <strong>{{ summary.window }}</strong>
      </span>
    </div>

    <div v-if="reviews.length === 0" class="rw-empty">
      还没有已确认持仓。先在「交易与持仓」中登记买入并确认，这里才会生成逐只复核。
    </div>

    <div v-else class="hr-list">
      <article v-for="review in reviews" :key="review.lot_id" class="hr-card">
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
          <span>剩余本金 <strong>¥{{ formatMoney(review.amount, 0) }}</strong></span>
          <span>
            到期
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
            当前参考年化 <strong>{{ formatPct(review.current.yield_pct, 2) }}</strong>
          </span>
          <span>
            3M / 6M / 1Y
            <strong>
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
                  : '待核对'
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
                <strong class="rw-panel-title">首选同期限候选</strong>
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
                  <span>参考年化</span>
                  <strong>{{ formatPct(review.current.yield_pct, 2) }}</strong>
                </div>
                <div class="hr-compare-bar">
                  <span :style="{ width: yieldBarWidth(review.current.yield_pct) }"></span>
                </div>
                <small>
                  {{ formatTerm(review.term_days, review.bucket) }} ·
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
                  <span>参考年化</span>
                  <strong>{{ formatPct(top.yield_pct, 2) }}</strong>
                  <em :class="{ 'is-positive': (top.yield_gap_pp ?? 0) > 0 }">
                    {{ formatPp(top.yield_gap_pp, 2, true) }}
                  </em>
                </div>
                <div class="hr-compare-bar is-candidate">
                  <span :style="{ width: yieldBarWidth(top.yield_pct) }"></span>
                </div>
                <small>
                  {{ formatTerm(top.term_days, top.bucket) }} · 比较
                  {{ top.comparison_days }} 天 ·
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
                  ¥{{ formatMoney(top.switch?.difference ?? 0, 2) }}
                </strong>
              </div>
              <div>
                <span>盈亏平衡</span>
                <strong>{{ formatPct(top.switch?.break_even_yield_pct, 2) }}</strong>
              </div>
              <div>
                <span>门槛</span>
                <strong>¥{{ formatMoney(review.thresholds.min_gain_amount, 2) }}</strong>
              </div>
              <div>
                <span>空档</span>
                <strong>{{ review.thresholds.idle_days }} 天</strong>
              </div>
            </div>
          </section>
        </template>

        <div class="hr-actions">
          <button type="button" class="rw-button is-secondary" @click="toggle(review)">
            {{ expanded === review.lot_id ? '收起候选' : `展开候选（${review.candidates.length}）` }}
          </button>
          <span class="rw-muted">
            门槛：年化差 ≥ {{ review.thresholds.min_yield_edge_pp }}pp，切换后至少多赚
            ¥{{ formatMoney(review.thresholds.min_gain_amount, 2) }}
          </span>
        </div>

        <section v-if="expanded === review.lot_id" class="hr-expanded">
          <form class="hr-settings" @submit.prevent="saveSetting(review)">
            <div class="hr-settings-head">
              <strong>赎回与空档口径</strong>
              <span>只填说明书或 App 能确认的数字；留空按估算处理</span>
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
                <span>空档天数（留空自动）</span>
                <input v-model="draftFor(review).idle_days" type="number" min="0" max="60" step="1" :placeholder="`${review.review_setting.idle_effective_days}`" />
              </label>
              <label class="rw-field">
                <span>日开比较期限（天）</span>
                <input v-model="draftFor(review).compare_horizon_days" type="number" min="1" max="365" step="1" />
              </label>
              <label class="rw-field">
                <span>最低多赚门槛（元）</span>
                <input v-model="draftFor(review).min_gain_amount" type="number" min="0" max="100000" step="1" />
              </label>
              <label class="rw-field">
                <span>口径核验日期</span>
                <input v-model="draftFor(review).verified_at" type="date" />
              </label>
              <label class="rw-field">
                <span>下一赎回开放日</span>
                <input v-model="draftFor(review).next_redeem_open_date" type="date" />
              </label>
              <label class="rw-field is-wide">
                <span>赎回规则备注</span>
                <input v-model="draftFor(review).notes" type="text" maxlength="1000" placeholder="例：最短持有 14 天，赎回 T+1 确认、T+1 到账，赎回费 0" />
              </label>
            </div>
            <div class="hr-settings-foot">
              <span>
                当前空档：{{ review.review_setting.idle_effective_days }} 天（{{ review.review_setting.idle_source }}）
              </span>
              <button type="submit" class="rw-button" :disabled="savingProduct === review.product_code">
                {{ savingProduct === review.product_code ? '保存中…' : '保存并重算' }}
              </button>
            </div>
          </form>

          <div v-if="review.candidates.length === 0" class="rw-empty is-compact">
            同期限、同风险档暂无满足起购金额的候选；继续持有并等待下一期快照。
          </div>
          <div v-else class="hr-candidate-list">
            <div class="hr-candidate-list-head">
              <strong>同期限候选</strong>
              <span>首选置顶，其余按预计差额排序；默认显示前 3 个</span>
            </div>
            <article
              v-for="candidate in visibleCandidates(review)"
              :key="candidate.code"
              class="hr-candidate"
              :class="{ 'is-top': candidate.code === topCandidateMap[review.lot_id]?.code }"
            >
              <div class="hr-candidate-head">
                <div class="hr-candidate-title">
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
                  <small>
                    {{ candidate.code }} · {{ candidate.issuer }} · 数据日
                    {{ candidate.data_date || '未获取到' }}
                  </small>
                </div>
                <span class="hr-candidate-verdict" :class="candidateClass(candidate)">
                  {{ candidate.verdict_label }}
                </span>
              </div>

              <div class="hr-candidate-grid">
                <span>
                  期限
                  <strong>
                    {{ formatTerm(candidate.term_days, candidate.bucket) }} · 比较
                    {{ candidate.comparison_days }} 天
                  </strong>
                </span>
                <span>参考年化 <strong>{{ formatPct(candidate.yield_pct, 2) }}</strong></span>
                <span>
                  3M / 6M / 1Y
                  <strong>
                    {{ formatPct(candidate.return_3m, 2) }} /
                    {{ formatPct(candidate.return_6m, 2) }} /
                    {{ formatPct(candidate.return_1y, 2) }}
                  </strong>
                </span>
                <span>
                  年化差
                  <strong :class="{ 'rw-gain-text': (candidate.yield_gap_pp ?? 0) > 0 }">
                    {{ formatPp(candidate.yield_gap_pp, 2, true) }}
                  </strong>
                </span>
                <span>
                  综合年费
                  <strong>{{ candidate.fee_bps === null ? '—' : `${candidate.fee_bps}bp` }}</strong>
                </span>
                <span>额度 <strong>{{ quotaLabel(candidate) }}</strong></span>
                <span>
                  切换差额
                  <strong :class="{ 'rw-gain-text': (candidate.switch?.difference ?? 0) > 0 }">
                    ¥{{ formatMoney(candidate.switch?.difference ?? 0, 2) }}
                  </strong>
                </span>
                <span>
                  盈亏平衡
                  <strong>{{ formatPct(candidate.switch?.break_even_yield_pct, 2) }}</strong>
                </span>
              </div>

              <div class="hr-mini-compare">
                <span>当前 {{ formatPct(review.current.yield_pct, 2) }}</span>
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
                <span>候选 {{ formatPct(candidate.yield_pct, 2) }}</span>
              </div>

              <p class="hr-candidate-reasons">{{ candidate.reasons.join('；') }}</p>
              <div v-if="candidate.data_gaps.length" class="hr-gaps">
                <span v-for="gap in candidate.data_gaps" :key="gap">{{ gap }}</span>
              </div>
              <div class="hr-row-actions">
                <button type="button" class="rw-link-button" @click="openDetail(candidate.product)">
                  查看详情
                </button>
                <button
                  v-if="candidate.verdict === 'replace'"
                  type="button"
                  class="rw-link-button"
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

    <ProductDetailDialog
      v-model:open="detailOpen"
      :product="detailProduct"
      :snapshot-date="snapshotDate"
      :history-date="historyDate"
    />
  </div>
</template>
