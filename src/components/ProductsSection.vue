<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import {
  bucketLabel,
  formatMoney,
  formatPct,
  formatTerm,
} from '@/composables/useFormatters'
import type { DashboardPayload, Product, ProductAllocationSettings } from '@/types/dashboard'
import ProductDialog from './ProductDialog.vue'
import ProductDetailDialog from './ProductDetailDialog.vue'

const props = defineProps<{
  dashboard: DashboardPayload
}>()

const dashboardStore = useDashboardStore()
const { show } = useToast()
const dialogOpen = ref(false)
const detailOpen = ref(false)
const detailCloseVersion = ref(0)
const detailProduct = ref<Product | null>(null)
const refreshing = ref(false)
const settingsOpen = ref(false)
const savingSettings = ref(false)
const savingQuota = ref(false)

const products = computed(() => props.dashboard.products)
const stats = computed(() => props.dashboard.products.stats)
const allocation = computed(() => props.dashboard.products.allocation)
const settings = computed<ProductAllocationSettings>(() => allocation.value.settings)

const settingsForm = reactive({
  principal_override: '' as string | number,
  liquidity_floor_pct: 30,
  max_single_pct: 30,
  cashflow_0_3: 0,
  cashflow_3_6: 0,
  cashflow_6_12: 0,
  short: 30,
  medium: 35,
  long: 35,
})

const quotaDrafts = reactive<
  Record<
    string,
    { available: string | number; max_order: string | number; window: string }
  >
>({})

watch(
  settings,
  (value) => {
    settingsForm.principal_override = value.principal_override ?? ''
    settingsForm.liquidity_floor_pct = value.liquidity_floor_pct
    settingsForm.max_single_pct = value.max_single_pct
    settingsForm.cashflow_0_3 = value.cashflow_0_3
    settingsForm.cashflow_3_6 = value.cashflow_3_6
    settingsForm.cashflow_6_12 = value.cashflow_6_12
    settingsForm.short = value.bucket_targets.short
    settingsForm.medium = value.bucket_targets.medium
    settingsForm.long = value.bucket_targets.long
  },
  { immediate: true },
)

watch(
  () => products.value.watchlist.map((item) => item.code),
  (codes) => {
    for (const code of codes) {
      if (quotaDrafts[code]) continue
      const item = products.value.watchlist.find((product) => product.code === code)
      quotaDrafts[code] = {
        available: item?.quota_available ?? '',
        max_order: item?.quota_max_order ?? '',
        window: item?.quota_window || '',
      }
    }
  },
  { immediate: true },
)

const statusLabel = computed(() => {
  const status = allocation.value.status
  if (status === 'ready') return '已按目标配满'
  if (status === 'quota_unverified') return '金额已分配 · 额度待核'
  if (status === 'partial') return '部分分配'
  if (status === 'no_cash') return '暂无新增资金'
  if (status === 'no_allocation') return '无法完成分配'
  return '等待本金'
})

const goalTitle = computed(() => {
  if (allocation.value.principal <= 0) return '先初始化本金，再生成配置'
  if (allocation.value.available_cash <= 0) return '当前资金已被持仓和待确认买入占用'
  return `新增可分配 ¥${formatMoney(allocation.value.available_cash, 0)} · 已分配 ${formatPct(
    (allocation.value.allocated_amount / Math.max(allocation.value.available_cash, 1)) * 100,
    0,
  )}`
})

const goalText = computed(() => {
  const value = allocation.value
  const counts = stats.value.scored_bucket_counts
  return `本金 ¥${formatMoney(value.principal, 0)} · 已确认持仓 ¥${formatMoney(
    value.holdings.amount,
    0,
  )} · 待确认买入 ¥${formatMoney(value.pending.amount, 0)} · 新增分配 ¥${formatMoney(
    value.allocated_amount,
    0,
  )}（补仓 ¥${formatMoney(value.top_up_amount, 0)} / 新开 ¥${formatMoney(
    value.new_position_amount,
    0,
  )} · 未分配 ¥${formatMoney(value.unallocated_amount, 0)} · 可研究 ${
    stats.value.total
  } 只 / 可评分 ${stats.value.observation_ready} 只（短 1–30 ${counts.short} / 中 31–100 ${
    counts.medium
  } / 长 101+ ${counts.long}）`
})

const progressStyle = computed(() => ({
  width: `${
    allocation.value.available_cash <= 0
      ? 0
      : Math.max(
          0,
          Math.min(
            100,
            (allocation.value.allocated_amount / allocation.value.available_cash) * 100,
          ),
        )
  }%`,
}))

const observationCandidates = computed(() => {
  const selected = new Set(products.value.watchlist.map((item) => item.code))
  return products.value.observation_list.filter((item) => !selected.has(item.code))
})

function openProductDetail(product: Product): void {
  detailProduct.value = product
  detailOpen.value = true
}

async function refreshSnapshot(): Promise<void> {
  refreshing.value = true
  try {
    const response = await dashboardStore.refreshProducts()
    show(
      `已重新读取 ${response.refreshed} 只产品 · 快照 ${
        response.dashboard.meta.product_snapshot_date || '待核'
      } · 历史业绩 ${response.dashboard.meta.product_history_date || '待核'}`,
      { duration: 4600 },
    )
  } catch (error) {
    show(error instanceof Error ? error.message : '产品快照刷新失败', {
      error: true,
      duration: 5000,
    })
  } finally {
    refreshing.value = false
  }
}

async function saveSettings(): Promise<void> {
  savingSettings.value = true
  try {
    await dashboardStore.updateAllocationSettings({
      principal_override:
        settingsForm.principal_override === '' ? null : Number(settingsForm.principal_override),
      liquidity_floor_pct: Number(settingsForm.liquidity_floor_pct),
      max_single_pct: Number(settingsForm.max_single_pct),
      cashflow_0_3: Number(settingsForm.cashflow_0_3),
      cashflow_3_6: Number(settingsForm.cashflow_3_6),
      cashflow_6_12: Number(settingsForm.cashflow_6_12),
      bucket_targets: {
        short: Number(settingsForm.short),
        medium: Number(settingsForm.medium),
        long: Number(settingsForm.long),
      },
    })
    show('分配假设已保存，目标金额已重算')
  } catch (error) {
    show(error instanceof Error ? error.message : '分配设置保存失败', { error: true })
  } finally {
    savingSettings.value = false
  }
}

async function useLedgerPrincipal(): Promise<void> {
  settingsForm.principal_override = ''
  await saveSettings()
}

async function saveQuotas(): Promise<void> {
  savingQuota.value = true
  try {
    const quotaByCode = Object.fromEntries(
      Object.entries(quotaDrafts).map(([code, value]) => [
        code,
        {
          available: value.available === '' ? null : Number(value.available),
          max_order: value.max_order === '' ? null : Number(value.max_order),
          window: value.window || settings.value.quota_by_code[code]?.window || '',
          verified_at:
            value.available === ''
              ? ''
              : new Date().toISOString().slice(0, 10),
        },
      ]),
    )
    await dashboardStore.updateAllocationSettings({ quota_by_code: quotaByCode })
    show('产品额度已保存，金额已按额度重算')
  } catch (error) {
    show(error instanceof Error ? error.message : '额度保存失败', { error: true })
  } finally {
    savingQuota.value = false
  }
}
</script>

<template>
  <section class="products-section" aria-label="R2 产品配置与候选池">
    <section class="product-module-card" aria-labelledby="allocationCardTitle">
      <header class="product-module-head">
        <div class="rw-card-heading">
          <p class="kicker">ALLOCATION</p>
          <h3 id="allocationCardTitle" class="rw-panel-title">配置目标与期限桶</h3>
          <p class="rw-panel-sub">
            按本金、已确认持仓、待确认买入、现金流和额度计算目标金额；未分配金额不会为了凑数强行买入。
          </p>
        </div>
        <div class="rw-toolbar-actions">
          <button
            class="button button-ghost button-small"
            type="button"
            @click="settingsOpen = !settingsOpen"
          >
            {{ settingsOpen ? '收起假设' : '调整假设' }}
          </button>
          <button
            class="button button-ghost button-small"
            type="button"
            :disabled="refreshing"
            @click="refreshSnapshot"
          >
            {{ refreshing ? '读取中…' : '刷新快照' }}
          </button>
          <button
            class="button button-ghost button-small"
            type="button"
            @click="dialogOpen = true"
          >
            查看全部产品
          </button>
        </div>
      </header>
      <div class="product-module-body">
        <div class="product-goal-strip">
          <div class="product-goal-copy">
            <span class="goal-dot"></span>
            <div>
              <strong>{{ goalTitle }}</strong>
              <p data-testid="product-goal-text">{{ goalText }}</p>
            </div>
          </div>
          <div class="pool-progress" aria-hidden="true">
            <span :style="progressStyle"></span>
          </div>
          <span class="pool-gap" :class="{ positive: allocation.status === 'ready' }">
            {{ statusLabel }}
          </span>
        </div>

        <div class="daily-open-policy" :class="{ 'is-migration': allocation.daily_open.migration_required }">
          <strong>日开新增额度 {{ allocation.daily_open.target_pct }}%</strong>
          <span>固定为 0%；短桶承担流动性。target3 固定为短期 30% / 中期 35% / 长期 35%。</span>
          <span v-if="allocation.daily_open.migration_required">
            现有日开 ¥{{ formatMoney(allocation.daily_open.existing_amount, 0) }} 保留为真实持仓，
            按同桶统一收益和短期限候选迁移；本次切换等待期不计收益，到期自动续作不重复扣空档。
          </span>
        </div>

        <div class="allocation-buckets">
          <article
            v-for="bucket in allocation.buckets"
            :key="bucket.key"
            class="allocation-bucket"
            :class="[`bucket-${bucket.key}`, `is-${bucket.status}`]"
          >
            <div class="allocation-bucket-head">
              <strong>{{ bucket.label }}</strong>
              <span>{{ bucket.final_pct.toFixed(1) }}% / 目标 {{ bucket.target_pct }}%</span>
            </div>
            <div class="allocation-bucket-amount">
              <strong>¥{{ formatMoney(bucket.final_amount, 0) }}</strong>
              <span>新增 ¥{{ formatMoney(bucket.new_amount, 0) }}</span>
            </div>
            <div class="allocation-bucket-meta">
              <span>已有 ¥{{ formatMoney(bucket.existing_amount, 0) }}</span>
              <span>待配 ¥{{ formatMoney(bucket.budget_amount, 0) }}</span>
              <span v-if="bucket.top_up_amount > 0">
                补仓 ¥{{ formatMoney(bucket.top_up_amount, 0) }}
              </span>
              <span v-if="bucket.new_position_amount > 0">
                新开 ¥{{ formatMoney(bucket.new_position_amount, 0) }}
              </span>
            </div>
            <p v-if="bucket.reasons.length">{{ bucket.reasons.join('；') }}</p>
          </article>
        </div>

        <div v-if="allocation.reasons.length" class="allocation-reasons">
          <span v-for="reason in allocation.reasons" :key="reason">{{ reason }}</span>
        </div>
      </div>
    </section>

    <section
      v-if="observationCandidates.length"
      class="product-module-card"
      aria-labelledby="observationCardTitle"
    >
      <header class="product-module-head">
        <div class="rw-card-heading">
          <p class="kicker">OBSERVATION</p>
          <h3 id="observationCardTitle" class="rw-panel-title">观察名单</h3>
          <p class="rw-panel-sub">
            研究排序，不代表已分配金额；点击产品查看收益、期限、额度与配置详情。
          </p>
        </div>
      </header>
      <div class="observation-grid">
        <button
          v-for="product in observationCandidates"
          :key="product.code"
          type="button"
          class="observation-card"
          :data-evidence-tier="product.evidence_tier"
          :aria-label="`查看 ${product.name} 详情`"
          @click="openProductDetail(product)"
        >
          <span class="observation-term">
            {{ bucketLabel(product.bucket) }} · {{ formatTerm(product.term_days, product.bucket) }}
          </span>
          <strong class="observation-name">{{ product.name }}</strong>
          <span class="observation-code">{{ product.code }} · {{ product.issuer }}</span>
          <span class="observation-code">历史证据 · {{ product.evidence_label }}</span>
          <small class="observation-meta">
            期限调整参考年化 {{ formatPct(product.reference_yield_pct, 2) }} · 评分
            {{ product.selection_score === null ? '—' : product.selection_score.toFixed(2) }}
          </small>
          <span class="observation-detail-hint">查看详情 →</span>
        </button>
      </div>
    </section>

    <div class="product-section-slot">
      <slot name="after-allocation" />
    </div>

    <section
      v-if="settingsOpen"
      class="product-module-card"
      aria-labelledby="assumptionsCardTitle"
    >
      <header class="product-module-head">
        <div class="rw-card-heading">
          <p class="kicker">ASSUMPTIONS</p>
          <h3 id="assumptionsCardTitle" class="rw-panel-title">分配假设</h3>
          <p class="rw-panel-sub">
            调整本金、期限桶、短期下限和现金流；单只上限固定约束，日开新增额度固定为 0%。
          </p>
        </div>
        <div class="rw-toolbar-actions">
          <button
            class="button button-ghost button-small"
            type="button"
            @click="settingsOpen = false"
          >
            收起
          </button>
        </div>
      </header>
      <form class="allocation-settings" @submit.prevent="saveSettings">
        <label>
          <span>可投资本金</span>
          <input
            v-model="settingsForm.principal_override"
            type="number"
            min="0"
            step="100"
            placeholder="留空使用本金账户"
          />
        </label>
        <label>
          <span>短期目标 %</span>
          <input v-model.number="settingsForm.short" type="number" min="0" max="100" step="1" />
        </label>
        <label>
          <span>中期目标 %</span>
          <input v-model.number="settingsForm.medium" type="number" min="0" max="100" step="1" />
        </label>
        <label>
          <span>长期目标 %</span>
          <input v-model.number="settingsForm.long" type="number" min="0" max="100" step="1" />
        </label>
        <label>
          <span>短期桶下限 %（日开另固定 0%）</span>
          <input
            v-model.number="settingsForm.liquidity_floor_pct"
            type="number"
            min="0"
            max="100"
            step="1"
          />
        </label>
        <label>
          <span>单只上限 %</span>
          <input
            v-model.number="settingsForm.max_single_pct"
            type="number"
            min="25"
            max="30"
            step="1"
          />
        </label>
        <label>
          <span>0–3 月支出</span>
          <input v-model.number="settingsForm.cashflow_0_3" type="number" min="0" step="100" />
        </label>
        <label>
          <span>3–6 月支出</span>
          <input v-model.number="settingsForm.cashflow_3_6" type="number" min="0" step="100" />
        </label>
        <label>
          <span>6–12 月支出</span>
          <input v-model.number="settingsForm.cashflow_6_12" type="number" min="0" step="100" />
        </label>
        <div class="allocation-settings-actions">
          <button class="button button-primary button-small" type="submit" :disabled="savingSettings">
            {{ savingSettings ? '保存中…' : '保存并重算' }}
          </button>
          <button
            class="button button-ghost button-small"
            type="button"
            :disabled="savingSettings"
            @click="useLedgerPrincipal"
          >
            用本金账户
          </button>
        </div>
      </form>
    </section>

    <section
      v-if="products.watchlist.length"
      class="product-module-card"
      aria-labelledby="quotaCardTitle"
    >
      <header class="product-module-head">
        <div class="rw-card-heading">
          <p class="kicker">QUOTA CHECK</p>
          <h3 id="quotaCardTitle" class="rw-panel-title">买入前额度核验</h3>
          <p class="rw-panel-sub">
            公开 CSV 没有实时额度。填了额度就按额度截断；留空则保留计算金额并标记“额度未核验”。
          </p>
        </div>
        <div class="rw-toolbar-actions">
          <button
            class="button button-primary button-small"
            type="button"
            :disabled="savingQuota"
            @click="saveQuotas"
          >
            {{ savingQuota ? '保存中…' : '保存额度并重算' }}
          </button>
        </div>
      </header>
      <div class="product-module-body">
        <div class="quota-editor-grid">
          <label v-for="product in products.watchlist" :key="product.code">
            <span>{{ product.code }} · 可用额度</span>
            <input
              v-model="quotaDrafts[product.code].available"
              type="number"
              min="0"
              step="100"
              placeholder="未核验"
            />
            <span>单笔上限</span>
            <input
              v-model="quotaDrafts[product.code].max_order"
              type="number"
              min="0"
              step="100"
              placeholder="不限"
            />
            <span>额度窗口</span>
            <input
              v-model="quotaDrafts[product.code].window"
              type="text"
              maxlength="80"
              placeholder="如 10/20 09:00"
            />
          </label>
        </div>
      </div>
    </section>

    <section class="product-module-card product-risk-card" aria-labelledby="riskCardTitle">
      <header class="product-module-head">
        <div class="rw-card-heading">
          <p class="kicker">RISK NOTES</p>
          <h3 id="riskCardTitle" class="rw-panel-title">风险边界</h3>
        </div>
      </header>
      <p class="product-disclaimer">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 2 3.5 4.5v5.2c0 3.8 2.5 6.6 6.5 8.3 4-1.7 6.5-4.5 6.5-8.3V4.5L10 2Z" />
          <path d="M7.5 10.2 9.2 12l3.5-4" />
        </svg>
        <span>
          目标金额由本金、已确认持仓、待确认买入、期限桶目标、短期桶下限、未来现金流、单只与底层策略上限共同计算。
          缺 1Y 的 6M 档和仅有 3M（单一窗口、低置信）的新发档可参与评分，单只与同类合计上限均为 10%/20%；仅有 1M
          的产品只作人工新品观察，不自动分配。
          发行方名称和当前持仓占比只作展示，不参与产品筛选、金额分配、买入门槛、提案或自动评估。
          同桶残余资金优先补足仍可加仓的已确认持仓；首次建仓须同时达到起购金额和目标单只金额的一半，避免制造小额新仓。
          本项目日开新增额度固定为 0%，现有日开持仓只作为真实持仓保留并提示迁移；短桶承担流动性。
          公开额度缺失时只给分配上限，不假装可买；买入前必须在招行 App 核对额度、起购金额、赎回规则和产品说明书。
          未分配金额不会为了凑数强行买入，不构成推荐或买入建议。
        </span>
      </p>
    </section>

    <ProductDialog
      v-model:open="dialogOpen"
      :detail-open="detailOpen"
      :detail-close-version="detailCloseVersion"
      :products="products"
      :snapshot-date="dashboard.meta.product_snapshot_date"
      :history-date="dashboard.meta.product_history_date"
      @detail="openProductDetail"
    />

    <ProductDetailDialog
      v-model:open="detailOpen"
      :product="detailProduct"
      :snapshot-date="dashboard.meta.product_snapshot_date"
      :history-date="dashboard.meta.product_history_date"
      @closed="detailCloseVersion += 1"
    />
  </section>
</template>

<style scoped>
.product-goal-strip {
  position: relative;
}

.product-module-card {
  padding: 20px 22px 22px;
  border: 1px solid rgba(205, 213, 202, 0.8);
  border-radius: 20px;
  background: rgba(255, 254, 250, 0.9);
  box-shadow: var(--shadow-soft);
  backdrop-filter: blur(10px);
}

.product-module-card + .product-module-card,
.product-module-card + .product-section-slot,
.product-section-slot + .product-module-card {
  margin-top: 28px;
}

.product-module-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.product-module-body {
  min-width: 0;
}

.product-module-body .product-goal-strip {
  margin-top: 0;
}

.daily-open-policy {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid rgba(var(--green-rgb), 0.18);
  border-radius: 10px;
  background: var(--green-wash);
  color: var(--ink-soft);
  font-size: 12px;
  line-height: 1.6;
}

.daily-open-policy strong {
  color: var(--green);
  font-size: 12.5px;
}

.daily-open-policy span {
  color: var(--muted);
}

.daily-open-policy.is-migration {
  border-color: rgba(185, 137, 58, 0.35);
  background: #fbf7ed;
}

.product-module-body .allocation-reasons {
  margin-bottom: 0;
}

.product-module-body .product-disclaimer {
  margin-top: 0;
}

.allocation-settings {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
}

.allocation-settings label,
.quota-editor-grid label {
  display: grid;
  gap: 5px;
  color: var(--muted);
  font-size: 12px;
}

.allocation-settings input,
.quota-editor-grid input {
  width: 100%;
  height: 32px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--card);
  color: var(--ink-soft);
  font-family: var(--mono);
  font-size: 12px;
}

.allocation-settings-actions {
  display: flex;
  align-items: end;
  gap: 8px;
  grid-column: 1 / -1;
}

.allocation-settings-actions .button-primary {
  flex: 0 0 auto;
  min-width: 140px;
}

.allocation-buckets {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 14px 0;
}

.allocation-bucket {
  padding: 13px 14px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: var(--card);
}

.allocation-bucket.is-filled {
  border-color: rgba(var(--green-rgb), 0.24);
  background: var(--green-wash);
}

.allocation-bucket-head,
.allocation-bucket-meta,
.allocation-bucket-amount {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.allocation-bucket-head strong {
  color: var(--ink-soft);
  font-size: 12px;
}

.allocation-bucket-head span,
.allocation-bucket-meta {
  color: var(--muted-light);
  font-family: var(--mono);
  font-size: 12px;
}

.allocation-bucket-amount {
  margin-top: 10px;
}

.allocation-bucket-amount strong {
  font-family: var(--serif);
  font-size: 25px;
  font-weight: 400;
}

.allocation-bucket-amount span {
  color: var(--muted);
  font-size: 12px;
}

.allocation-bucket-meta {
  justify-content: flex-start;
  gap: 14px;
  margin-top: 6px;
}

.allocation-bucket p {
  margin: 8px 0 0;
  color: #a14d40;
  font-size: 12px;
  line-height: 1.55;
}

.allocation-reasons {
  display: grid;
  gap: 5px;
  margin: 10px 0 16px;
  padding: 10px 12px;
  border-left: 3px solid #b9893a;
  border-radius: 4px 8px 8px 4px;
  background: #fbf7ed;
  color: #7b6129;
  font-size: 12px;
  line-height: 1.6;
}

.quota-editor-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.quota-editor-grid label {
  padding: 9px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--card);
}

.observation-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.observation-card {
  display: grid;
  gap: 4px;
  width: 100%;
  min-width: 0;
  padding: 12px 13px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--card);
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition:
    transform 150ms ease,
    border-color 150ms ease,
    box-shadow 150ms ease;
}

.observation-card:hover {
  border-color: rgba(var(--green-rgb), 0.3);
  box-shadow: 0 10px 24px rgba(33, 53, 43, 0.08);
  transform: translateY(-1px);
}

.observation-card:focus-visible {
  outline: 2px solid rgba(var(--green-rgb), 0.45);
  outline-offset: 2px;
}

.observation-term,
.observation-code,
.observation-meta {
  color: var(--muted-light);
  font-size: 12px;
}

.observation-name {
  color: var(--ink-soft);
  font-size: 13px;
  font-weight: 700;
  line-height: 1.45;
}

.observation-detail-hint {
  margin-top: 4px;
  color: var(--green);
  font-size: 12px;
  font-weight: 650;
}

@media (max-width: 1100px) {
  .allocation-settings {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .allocation-buckets,
  .quota-editor-grid,
  .observation-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 620px) {
  .product-module-card {
    padding: 17px 16px 18px;
    border-radius: 16px;
  }

  .allocation-settings {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 460px) {
  .allocation-settings {
    grid-template-columns: 1fr;
  }
}
</style>
