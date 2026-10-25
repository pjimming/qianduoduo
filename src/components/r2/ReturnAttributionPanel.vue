<script setup lang="ts">
import { computed } from 'vue'
import type {
  ReturnAttribution,
  ReturnAttributionComponent,
  ReturnAttributionQuality,
} from '@/types/dashboard'
import {
  formatDateShort,
  formatMoney,
  formatPct,
  formatPp,
  formatSignedMoney,
} from '@/composables/useFormatters'

const props = defineProps<{
  attribution: ReturnAttribution
}>()

const bridgeComponents = computed(() =>
  props.attribution.components.filter((item) => item.included_in_bridge),
)
const feeComponent = computed(() =>
  props.attribution.components.find((item) => item.key === 'fee_estimate'),
)
const maxBarAmount = computed(() =>
  Math.max(
    1,
    ...bridgeComponents.value.map((item) => Math.abs(item.amount ?? 0)),
  ),
)
const gapTone = computed(() => {
  const gap = props.attribution.gap.annualized_pct
  if (gap === null || Math.abs(gap) < 0.000001) return 'is-neutral'
  return gap > 0 ? 'is-positive' : 'is-negative'
})
const statusLabel = computed(() => {
  if (props.attribution.status === 'available') return '核对完整'
  if (props.attribution.status === 'partial') return '部分证据'
  return '样本不足'
})
const productCoverageTone = computed(() => {
  const difference = Math.abs(props.attribution.product_evidence.difference)
  return difference <= 0.01 ? 'is-positive' : 'is-negative'
})
const deploymentPct = computed(() => {
  const principal = props.attribution.actual.average_principal
  if (!(principal > 0)) return null
  return (
    (props.attribution.actual.average_holding_amount / principal) *
    100
  )
})
const accountIsBehind = computed(
  () => (props.attribution.gap.observed_period_pnl ?? 0) < -0.005,
)
const simpleHeadline = computed(() => {
  const prefix =
    props.attribution.quality === 'insufficient'
      ? '当前记录还少，以下只作试算。'
      : ''
  const actual = props.attribution.actual.observed_period_pnl
  const target = props.attribution.target.observed_period_pnl
  const gap = props.attribution.gap.observed_period_pnl
  if (accountIsBehind.value) {
    return `${prefix}把全部本金算上，3% 目标应赚 ${money(
      target,
    )}，实际到账 ${signedMoney(actual)}，少 ${money(
      Math.abs(gap ?? 0),
    )}。`
  }
  return `${prefix}把全部本金算上，3% 目标应赚 ${money(
    target,
  )}，实际到账 ${signedMoney(actual)}。`
})

function qualityLabel(quality: ReturnAttributionQuality): string {
  if (quality === 'fact') return '已核验'
  if (quality === 'mixed') return '事实 + 估算'
  if (quality === 'estimate') return '估算'
  if (quality === 'verified_estimate') return '按已核验费率估算'
  if (quality === 'unverified_estimate') return '按待核费率估算'
  return '未获取到'
}

function amountTone(amount: number | null): string {
  if (amount === null || Math.abs(amount) < 0.005) return 'is-neutral'
  return amount > 0 ? 'is-positive' : 'is-negative'
}

function componentLabel(
  component: Pick<ReturnAttributionComponent, 'key' | 'label' | 'amount'>,
): string {
  const amount = component.amount ?? 0
  if (component.key === 'product_selection') {
    return amount < 0
      ? '所选产品参考收益低于 3%'
      : '所选产品参考收益高于 3%'
  }
  if (component.key === 'product_realization') {
    return amount < 0
      ? '实际到账低于参考收益'
      : '实际到账高于参考收益'
  }
  if (component.key === 'purchase_wait') return '买入确认前等待'
  if (component.key === 'redemption_wait') return '赎回后再配置前等待'
  if (component.key === 'cash_unclassified') return '其他现金或未归类资金'
  return component.label
}

function signedMoney(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined
    ? '—'
    : formatSignedMoney(value, digits)
}

function money(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined
    ? '—'
    : `¥${formatMoney(value, digits)}`
}

function referenceYieldLabel(
  product: ReturnAttribution['product_evidence']['products'][number],
): string {
  return product.reference_yield_status === 'available'
    ? formatPct(product.reference_yield_pct, 2)
    : '不可计算'
}

function referenceYieldHint(
  product: ReturnAttribution['product_evidence']['products'][number],
): string {
  const policy = product.reference_yield_policy_version || '策略版本待核'
  if (product.reference_yield_reason === 'no_product_snapshot') {
    return `当前快照缺失 · ${policy}`
  }
  if (product.reference_yield_reason === 'unknown_term') {
    return `期限无法分桶 · ${policy}`
  }
  if (product.reference_yield_reason === 'no_available_horizons') {
    return `指定窗口均缺失 · ${policy}`
  }
  const windows = product.reference_available_horizons.join(' + ') || '—'
  const prefix =
    product.reference_yield_reason === 'partial_history' ? '部分历史 · ' : ''
  return `${prefix}可用窗口 ${windows} · ${policy}`
}

function barStyle(component: ReturnAttributionComponent): Record<string, string> {
  const amount = component.amount ?? 0
  const width = Math.max(
    amount === 0 ? 0 : 3,
    (Math.abs(amount) / maxBarAmount.value) * 50,
  )
  return {
    width: `${Math.min(50, width)}%`,
    ...(amount < 0 ? { right: '50%' } : { left: '50%' }),
  }
}
</script>

<template>
  <section
    class="return-attribution"
    aria-labelledby="return-attribution-title"
  >
    <header class="ra-head">
      <div class="ra-heading">
        <p class="ra-kicker">TARGET BRIDGE</p>
        <h2 id="return-attribution-title">3% 目标差距归因</h2>
        <p class="ra-headline">{{ simpleHeadline }}</p>
      </div>
      <div class="ra-badges">
        <span class="ra-badge" :class="`is-${attribution.status}`">
          {{ statusLabel }}
        </span>
        <span class="ra-badge">
          {{
            attribution.period.start_date && attribution.period.end_date
              ? `${formatDateShort(attribution.period.start_date)}–${formatDateShort(
                  attribution.period.end_date,
                )}`
              : '等待收益记录'
          }}
        </span>
      </div>
    </header>

    <div class="ra-reading-guide">
      <article class="ra-read-card is-invested">
        <div class="ra-read-head">
          <span>尺子一 · 只算已确认持仓</span>
          <em>看投出去的钱收益率</em>
        </div>
        <strong>
          实际年化
          <b :class="gapTone">{{
            formatPct(attribution.actual.annualized_pct, 2, true)
          }}</b>
        </strong>
        <p>
          3% 目标
          <b>{{ formatPct(attribution.target.annualized_pct, 2) }}</b>，
          当前
          <b :class="gapTone">{{
            formatPp(attribution.gap.annualized_pct, 2, true)
          }}</b>
        </p>
        <small>
          日收益率的分母只包括当日已确认持仓，不包括尚未买入或等待确认的资金。
        </small>
      </article>

      <article class="ra-read-card is-account">
        <div class="ra-read-head">
          <span>尺子二 · 把全部本金算上</span>
          <em>看全账户少了多少钱</em>
        </div>
        <strong>
          全账户目标差距
          <b :class="amountTone(attribution.gap.observed_period_pnl)">
            {{ signedMoney(attribution.gap.observed_period_pnl) }}
          </b>
        </strong>
        <p>
          实际到账
          <b :class="amountTone(attribution.actual.observed_period_pnl)">
            {{ signedMoney(attribution.actual.observed_period_pnl) }}
          </b>，
          3% 目标应赚
          <b>{{ money(attribution.target.observed_period_pnl) }}</b>
        </p>
        <small>
          平均本金 {{ money(attribution.actual.average_principal, 0) }}，
          平均持仓
          {{ money(attribution.actual.average_holding_amount, 0) }}；
          {{ formatPct(deploymentPct, 1) }} 的本金在工作。
        </small>
      </article>
    </div>

    <div class="ra-body">
      <section class="ra-bridge" aria-labelledby="ra-bridge-title">
        <div class="ra-section-head">
          <div>
            <p class="ra-kicker">AMOUNT BRIDGE</p>
            <h3 id="ra-bridge-title">
              {{ accountIsBehind ? '少掉的钱是怎么来的？' : '多出的钱是怎么来的？' }}
            </h3>
          </div>
          <span
            class="ra-reconciliation"
            :class="
              attribution.bridge.reconciled ? 'is-positive' : 'is-negative'
            "
          >
            {{
              attribution.bridge.reconciled
                ? '已闭合'
                : `核对差额 ${signedMoney(
                    attribution.bridge.reconciliation_difference,
                  )}`
            }}
          </span>
        </div>

        <div class="ra-bridge-rail">
          <div class="ra-bridge-start">
            <span>起点 · 全部本金按 3% 应赚</span>
            <strong>{{
              signedMoney(attribution.bridge.start_value)
            }}</strong>
            <small>按有收益记录的每日本金复利折算</small>
          </div>

          <div class="ra-bars" role="list" aria-label="目标差距归因项">
            <div
              v-for="component in bridgeComponents"
              :key="component.key"
              class="ra-bar-row"
              role="listitem"
            >
              <div class="ra-bar-copy">
                <strong>{{ componentLabel(component) }}</strong>
                <small>{{ qualityLabel(component.quality) }}</small>
              </div>
              <div class="ra-bar-track" aria-hidden="true">
                <span class="ra-bar-zero"></span>
                <span
                  class="ra-bar"
                  :class="amountTone(component.amount)"
                  :style="barStyle(component)"
                ></span>
              </div>
              <div class="ra-bar-value">
                <strong :class="amountTone(component.amount)">
                  {{ signedMoney(component.amount) }}
                </strong>
                <small>
                  {{
                    component.annualized_equivalent_pct === null
                      ? '折算不可用'
                      : `${formatPp(
                          component.annualized_equivalent_pct,
                          2,
                          true,
                        )} 年化当量`
                  }}
                </small>
              </div>
            </div>
          </div>

          <div class="ra-bridge-end">
            <span>终点 · 账户实际到账</span>
            <strong>{{
              signedMoney(attribution.actual.observed_period_pnl)
            }}</strong>
            <small>
              桥接后
              {{ signedMoney(attribution.bridge.end_value) }}
            </small>
          </div>
        </div>

        <p class="ra-method-note">
          从 3% 目标金额开始，逐项加上或减去原因，最后应回到账户实际收益。金额桥只在有 daily_records 的观察日闭合；缺少逐日记录
          {{ attribution.period.missing_record_days }} 天，因此年度化结论仍需结合样本完整度阅读。
        </p>

        <details class="ra-reading-help">
          <summary>每一项应该怎么读？</summary>
          <div>
            <p>
              <strong>所选产品参考收益：</strong>
              用产品快照里的期限调整参考年化和实际持仓天数估算。低于 3% 表示选中的产品本身没有提供足够的目标收益。
            </p>
            <p>
              <strong>实际到账与参考差异：</strong>
              把账本实际收益与上述估算相减。正值表示实际到账好于参考，负值表示低于参考；它不是额外的二次收益。
            </p>
            <p>
              <strong>买入或赎回等待：</strong>
              资金在确认或到账前没有完整参与计息，按 3% 机会收益估算少赚了多少。
            </p>
            <p>
              <strong>费用估算：</strong>
              只做费用拖累提示，不从账户收益中再次扣减，也不参与金额桥闭合。
            </p>
          </div>
        </details>
      </section>

      <aside class="ra-side">
        <section aria-labelledby="ra-drag-title">
          <div class="ra-section-head">
            <div>
              <p class="ra-kicker">PRIMARY DRAGS</p>
              <h3 id="ra-drag-title">最短结论 · 主要原因</h3>
            </div>
          </div>
          <div v-if="attribution.main_drags.length" class="ra-drags">
            <article
              v-for="item in attribution.main_drags"
              :key="item.key"
              class="ra-drag"
            >
              <span>{{ componentLabel(item) }}</span>
              <strong>{{ signedMoney(item.amount) }}</strong>
              <small>{{ qualityLabel(item.quality) }}</small>
            </article>
          </div>
          <p v-else class="ra-empty-copy">
            当前没有形成可识别金额拖累的计入项。
          </p>
        </section>

        <section class="ra-deployment" aria-labelledby="ra-deployment-title">
          <div class="ra-section-head">
            <div>
              <p class="ra-kicker">CAPITAL IN MARKET</p>
              <h3 id="ra-deployment-title">资金未在工作</h3>
            </div>
          </div>
          <div class="ra-deployment-grid">
            <span>
              <small>申购等待</small>
              <strong>{{
                signedMoney(attribution.deployment.purchase_wait_pnl)
              }}</strong>
            </span>
            <span>
              <small>赎回后再配置</small>
              <strong>{{
                signedMoney(attribution.deployment.redemption_wait_pnl)
              }}</strong>
            </span>
            <span>
              <small>现金或未归类</small>
              <strong>{{
                signedMoney(attribution.deployment.cash_unclassified_pnl)
              }}</strong>
            </span>
          </div>
          <p>
            平均本金 {{ money(attribution.actual.average_principal, 0) }}，
            平均已确认持仓
            {{ money(attribution.actual.average_holding_amount, 0) }}。
          </p>
          <p class="ra-tplus">
            <template v-if="attribution.tplus_evidence.available">
              赎回 / 到账 / 申购 T+N 已配置
              {{ attribution.tplus_evidence.product_count }} 只，其中已核验
              {{ attribution.tplus_evidence.verified_product_count }} 只。
              <template
                v-if="attribution.tplus_evidence.unverified_product_codes.length"
              >
                待核验：
                {{
                  attribution.tplus_evidence.unverified_product_codes.join('、')
                }}。
              </template>
            </template>
            <template v-else>
              未配置可用的赎回 / 到账 / 申购 T+N；到账时点按已确认交易事实判断，不推算到账日。
            </template>
          </p>
        </section>

        <section class="ra-fee" aria-labelledby="ra-fee-title">
          <div>
            <p class="ra-kicker">FEE DIAGNOSTIC</p>
            <h3 id="ra-fee-title">费用估算</h3>
          </div>
          <strong :class="amountTone(feeComponent?.amount ?? null)">
            {{ signedMoney(feeComponent?.amount ?? null) }}
          </strong>
          <span>{{ qualityLabel(feeComponent?.quality ?? 'unavailable') }}</span>
          <p>{{ feeComponent?.note || attribution.fee_estimate.note }}</p>
        </section>
      </aside>
    </div>

    <details class="ra-products">
      <summary>
        <span>
          <span class="ra-kicker">PRODUCT EVIDENCE</span>
          <strong>逐产品证据与选择贡献</strong>
          <small>
            {{ attribution.product_evidence.products.length }} 只产品 ·
            期限调整参考年化覆盖
            {{ formatPct(attribution.product_evidence.reference_yield_coverage_pct, 2) }}
          </small>
        </span>
        <em aria-hidden="true"></em>
      </summary>
      <div class="ra-product-body">
        <div class="ra-product-summary">
          <span>
            <small>账户收益事实</small>
            <strong>{{
              signedMoney(attribution.product_evidence.account_pnl)
            }}</strong>
          </span>
          <span>
            <small>产品入账合计</small>
            <strong>{{
              signedMoney(
                attribution.product_evidence.recorded_product_pnl,
              )
            }}</strong>
          </span>
          <span>
            <small>证据差异</small>
            <strong :class="productCoverageTone">
              {{
                signedMoney(attribution.product_evidence.difference)
              }}
            </strong>
          </span>
        </div>
        <p class="ra-evidence-note">
          产品入账只用于核对覆盖度和解释来源，不再次计入账户总收益。
          差异不自动补零或覆盖，需回到收益截图、产品收益档案和账户记录核查。
        </p>

        <div
          v-if="attribution.product_evidence.products.length"
          class="ra-product-table"
        >
          <div class="ra-product-row is-head" aria-hidden="true">
            <span>产品</span>
            <span>期限调整参考年化</span>
            <span>选择贡献估算</span>
            <span>产品入账收益</span>
          </div>
          <div
            v-for="product in attribution.product_evidence.products"
            :key="product.product_code"
            class="ra-product-row"
          >
            <span data-label="产品">
              <strong>{{ product.product_name }}</strong>
              <small>
                {{ product.product_code }}
                <template v-if="product.reference_data_date">
                  · 快照 {{ formatDateShort(product.reference_data_date) }}
                </template>
              </small>
            </span>
            <span
              data-label="期限调整参考年化"
              :data-reference-status="product.reference_yield_status"
              :data-reference-reason="product.reference_yield_reason || ''"
              :data-reference-policy-version="product.reference_yield_policy_version || ''"
            >
              <strong>{{ referenceYieldLabel(product) }}</strong>
              <small>{{ referenceYieldHint(product) }}</small>
            </span>
            <span data-label="选择贡献估算">
              <strong :class="amountTone(product.selection_estimate_pnl)">
                {{ signedMoney(product.selection_estimate_pnl) }}
              </strong>
              <small>
                参考收益
                {{ signedMoney(product.reference_pnl) }}
              </small>
            </span>
            <span data-label="产品入账收益">
              <strong :class="amountTone(product.recorded_product_pnl)">
                {{ signedMoney(product.recorded_product_pnl) }}
              </strong>
              <small>{{ product.recorded_days }} 个产品收益日</small>
            </span>
          </div>
        </div>
        <p v-else class="ra-empty-copy">
          观察期内没有可用的逐产品收益记录；账户收益仍按账本事实保留。
        </p>
      </div>
    </details>

    <footer class="ra-disclosures">
      <p v-for="text in attribution.disclosures" :key="text">{{ text }}</p>
    </footer>
  </section>
</template>

<style scoped>
.return-attribution {
  display: grid;
  gap: 16px;
  padding: 22px;
  border: 1px solid var(--line);
  border-radius: var(--radius-xl);
  background: var(--card);
  box-shadow: var(--shadow-soft);
}

.ra-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.ra-heading {
  min-width: 0;
}

.ra-kicker {
  margin: 0;
  color: var(--green);
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.13em;
}

.ra-head h2,
.ra-section-head h3,
.ra-fee h3 {
  margin: 4px 0 0;
  color: var(--ink);
  font-family: var(--serif);
  font-weight: 500;
  letter-spacing: -0.02em;
}

.ra-head h2 {
  font-size: 24px;
}

.ra-section-head h3,
.ra-fee h3 {
  font-size: 18px;
}

.ra-headline {
  max-width: 880px;
  margin: 8px 0 0;
  color: var(--ink-soft);
  font-size: 13px;
  line-height: 1.7;
}

.ra-badges {
  display: flex;
  flex: none;
  gap: 7px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.ra-badge,
.ra-reconciliation {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--card-soft);
  color: var(--muted);
  font-size: 12px;
  font-weight: 650;
}

.ra-badge.is-available {
  border-color: rgba(35, 139, 99, 0.28);
  background: var(--gain-soft);
  color: var(--gain);
}

.ra-badge.is-partial {
  border-color: rgba(183, 124, 45, 0.28);
  background: var(--amber-soft);
  color: var(--amber);
}

.ra-badge.is-insufficient {
  border-color: var(--line);
  color: var(--muted);
}

.ra-reading-guide {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.ra-read-card {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 15px 16px;
  border: 1px solid var(--line);
  border-radius: 15px;
  background: var(--card-soft);
}

.ra-read-card.is-invested {
  border-color: rgba(var(--green-rgb), 0.24);
  background:
    linear-gradient(135deg, var(--green-wash), transparent 75%),
    var(--card-soft);
}

.ra-read-card.is-account {
  border-color: rgba(183, 124, 45, 0.24);
  background:
    linear-gradient(135deg, var(--amber-soft), transparent 75%),
    var(--card-soft);
}

.ra-read-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ra-read-head span {
  color: var(--ink-soft);
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 700;
}

.ra-read-head em {
  color: var(--muted);
  font-size: 12px;
  font-style: normal;
}

.ra-read-card > strong {
  color: var(--ink-soft);
  font-size: 13px;
  font-weight: 650;
}

.ra-read-card > strong b {
  margin-left: 5px;
  font-family: var(--mono);
  font-size: 21px;
  font-weight: 700;
}

.ra-read-card > p {
  margin: 0;
  color: var(--ink-soft);
  font-size: 12.5px;
  line-height: 1.65;
}

.ra-read-card > p b {
  font-family: var(--mono);
  font-weight: 700;
}

.ra-read-card > small,
.ra-bridge-start span,
.ra-bridge-start small,
.ra-bridge-end span,
.ra-bridge-end small,
.ra-bar-copy small,
.ra-bar-value small,
.ra-deployment small,
.ra-drag small,
.ra-fee span,
.ra-products summary small,
.ra-product-row small,
.ra-product-summary small,
.ra-empty-copy {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.55;
}

.ra-reading-help {
  padding-top: 12px;
  border-top: 1px dashed var(--line);
}

.ra-reading-help summary {
  color: var(--green);
  cursor: pointer;
  font-size: 12px;
  font-weight: 650;
}

.ra-reading-help > div {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 14px;
  margin-top: 10px;
}

.ra-reading-help p {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}

.ra-reading-help p strong {
  color: var(--ink-soft);
}

.ra-body {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(280px, 0.85fr);
  gap: 14px;
}

.ra-bridge,
.ra-side,
.ra-products {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--card-soft);
}

.ra-bridge {
  display: grid;
  gap: 16px;
  padding: 16px;
}

.ra-section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.ra-reconciliation.is-positive,
.is-positive {
  color: var(--gain) !important;
}

.ra-reconciliation.is-negative,
.is-negative {
  color: var(--loss) !important;
}

.is-neutral {
  color: var(--muted) !important;
}

.ra-bridge-rail {
  display: grid;
  gap: 12px;
}

.ra-bridge-start,
.ra-bridge-end {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 3px 16px;
  padding: 11px 13px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--card);
}

.ra-bridge-start strong,
.ra-bridge-end strong {
  color: var(--ink);
  font-family: var(--mono);
  font-size: 14px;
  text-align: right;
}

.ra-bridge-start small,
.ra-bridge-end small {
  grid-column: 1 / -1;
}

.ra-bridges,
.ra-bars {
  display: grid;
  gap: 9px;
}

.ra-bar-row {
  display: grid;
  grid-template-columns: minmax(116px, 0.9fr) minmax(120px, 1.2fr) minmax(112px, 0.8fr);
  align-items: center;
  gap: 11px;
}

.ra-bar-copy,
.ra-bar-value {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.ra-bar-copy strong,
.ra-bar-value strong {
  color: var(--ink-soft);
  font-size: 12.5px;
}

.ra-bar-value {
  justify-items: end;
  text-align: right;
}

.ra-bar-value strong {
  font-family: var(--mono);
}

.ra-bar-track {
  position: relative;
  height: 18px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--line) 50%, transparent);
}

.ra-bar-zero {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 50%;
  width: 1px;
  background: var(--line-strong);
}

.ra-bar {
  position: absolute;
  top: 4px;
  bottom: 4px;
  min-width: 0;
  border-radius: 999px;
  opacity: 0.88;
}

.ra-bar.is-positive {
  background: var(--gain);
}

.ra-bar.is-negative {
  background: var(--loss);
}

.ra-bar.is-neutral {
  background: var(--muted-light);
}

.ra-method-note,
.ra-deployment p,
.ra-fee p,
.ra-evidence-note,
.ra-disclosures p {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}

.ra-side {
  display: grid;
  gap: 12px;
  padding: 16px;
}

.ra-side > section {
  display: grid;
  gap: 10px;
}

.ra-side > section + section {
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.ra-drags {
  display: grid;
  gap: 7px;
}

.ra-drag {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 10px;
  padding: 9px 10px;
  border-radius: 10px;
  background: var(--loss-soft);
}

.ra-drag span {
  color: var(--ink-soft);
  font-size: 12.5px;
  font-weight: 650;
}

.ra-drag strong {
  color: var(--loss);
  font-family: var(--mono);
  font-size: 12.5px;
}

.ra-drag small {
  grid-column: 1 / -1;
}

.ra-deployment-grid {
  display: grid;
  gap: 7px;
}

.ra-deployment-grid span {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--line);
}

.ra-deployment-grid strong {
  color: var(--ink-soft);
  font-family: var(--mono);
  font-size: 12.5px;
}

.ra-fee {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 3px 12px;
}

.ra-fee > div {
  min-width: 0;
}

.ra-fee > strong {
  align-self: center;
  font-family: var(--mono);
  font-size: 14px;
}

.ra-fee > span {
  justify-self: end;
}

.ra-fee > p {
  grid-column: 1 / -1;
}

.ra-products > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  cursor: pointer;
  list-style: none;
}

.ra-products > summary::-webkit-details-marker {
  display: none;
}

.ra-products > summary > span {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.ra-products > summary strong {
  color: var(--ink-soft);
  font-size: 13px;
}

.ra-products > summary em {
  color: var(--green);
  font-size: 12px;
  font-style: normal;
  font-weight: 650;
}

.ra-products > summary em::after {
  content: "展开";
}

.ra-products[open] > summary {
  border-bottom: 1px solid var(--line);
}

.ra-products[open] > summary em::after {
  content: "收起";
}

.ra-product-body {
  display: grid;
  gap: 12px;
  padding: 14px 16px 16px;
}

.ra-product-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.ra-product-summary span {
  display: grid;
  gap: 3px;
  padding: 10px 11px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card);
}

.ra-product-summary strong {
  color: var(--ink-soft);
  font-family: var(--mono);
  font-size: 12.5px;
}

.ra-product-table {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--card);
}

.ra-product-row {
  display: grid;
  grid-template-columns: minmax(180px, 1.35fr) repeat(3, minmax(120px, 1fr));
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}

.ra-product-row:last-child {
  border-bottom: 0;
}

.ra-product-row.is-head {
  background: var(--card-soft);
  color: var(--muted);
  font-size: 12px;
  font-weight: 650;
}

.ra-product-row > span {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.ra-product-row strong {
  overflow-wrap: anywhere;
  color: var(--ink-soft);
  font-size: 12.5px;
}

.ra-disclosures {
  display: grid;
  gap: 3px;
  padding-top: 2px;
}

@media (max-width: 1120px) {
  .ra-body {
    grid-template-columns: 1fr;
  }

  .ra-side {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    align-items: start;
  }

  .ra-side > section + section {
    padding-top: 0;
    padding-left: 12px;
    border-top: 0;
    border-left: 1px solid var(--line);
  }
}

@media (max-width: 820px) {
  .return-attribution {
    padding: 17px;
  }

  .ra-head {
    flex-direction: column;
  }

  .ra-badges {
    justify-content: flex-start;
  }

  .ra-reading-guide {
    grid-template-columns: 1fr;
  }

  .ra-side {
    grid-template-columns: 1fr;
  }

  .ra-side > section + section {
    padding-top: 12px;
    padding-left: 0;
    border-top: 1px solid var(--line);
    border-left: 0;
  }

  .ra-product-row {
    grid-template-columns: minmax(150px, 1.2fr) repeat(3, minmax(100px, 1fr));
  }
}

@media (max-width: 620px) {
  .return-attribution {
    gap: 14px;
    padding: 14px;
    border-radius: 18px;
  }

  .ra-head h2 {
    font-size: 21px;
  }

  .ra-bar-row {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px 10px;
  }

  .ra-bar-track {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .ra-bar-value {
    grid-column: 2;
    grid-row: 1;
  }

  .ra-product-summary {
    grid-template-columns: 1fr;
  }

  .ra-product-row,
  .ra-product-row.is-head {
    grid-template-columns: 1fr;
    gap: 9px;
  }

  .ra-product-row.is-head {
    display: none;
  }

  .ra-product-row > span::before {
    content: attr(data-label);
    color: var(--muted);
    font-size: 12px;
    font-weight: 650;
  }

  .ra-product-row > span:first-child::before {
    display: none;
  }

  .ra-read-head {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
  }

  .ra-reading-help > div {
    grid-template-columns: 1fr;
  }
}
</style>
