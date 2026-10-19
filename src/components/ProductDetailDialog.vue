<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Product } from '@/types/dashboard'
import {
  bucketLabel,
  formatMoney,
  formatPct,
  formatPp,
  formatTerm,
} from '@/composables/useFormatters'

const props = defineProps<{
  open: boolean
  product: Product | null
  snapshotDate: string | null
  historyDate: string | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const dialogRef = ref<HTMLDialogElement | null>(null)
const inTarget = computed(() => (props.product?.target_amount ?? 0) > 0)

watch(
  () => props.open,
  async (open) => {
    await nextTick()
    if (open && dialogRef.value && !dialogRef.value.open) {
      dialogRef.value.showModal()
    } else if (!open && dialogRef.value?.open) {
      dialogRef.value.close()
    }
  },
  { immediate: true },
)

function close(): void {
  emit('update:open', false)
}

function onDialogClick(event: MouseEvent): void {
  const dialog = dialogRef.value
  if (!dialog) return
  const rect = dialog.getBoundingClientRect()
  const outside =
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  if (outside) close()
}

function money(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return '—'
  return `¥${formatMoney(value, digits)}`
}

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : formatPct(value, 2)
}

function text(value: string | null | undefined, fallback = '未获取到'): string {
  return value && value.trim() ? value : fallback
}

function quotaStatus(product: Product): string {
  if (product.quota_status === 'verified') return 'verified'
  if (product.quota_status === 'limited') return 'limited'
  return 'unverified'
}

function quotaLabel(product: Product): string {
  if (product.quota_status === 'verified') return '额度已核验'
  if (product.quota_status === 'limited') return '额度不足，已截断'
  return '额度未核验'
}
</script>

<template>
  <dialog
    ref="dialogRef"
    class="product-dialog product-detail-dialog"
    @click="onDialogClick"
    @close="close"
  >
    <template v-if="product">
      <div class="dialog-head">
        <div>
          <p class="kicker">PRODUCT DETAIL</p>
          <h2>{{ product.name }}</h2>
          <p>
            {{ product.code }} · {{ text(product.issuer) }} · {{ product.risk_level }} ·
            {{ text(product.product_type) }}
          </p>
        </div>
        <button class="icon-button" type="button" aria-label="关闭" @click="close">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 5l10 10M15 5 5 15" />
          </svg>
        </button>
      </div>

      <div class="product-detail-body">
        <div class="product-detail-badges">
          <span class="status-pill" :class="{ 'is-selected': product.selected }">
            {{ product.selected ? '当前精选' : '观察候选' }}
          </span>
          <span class="quota-badge" :class="`is-${quotaStatus(product)}`">
            {{ quotaLabel(product) }}
          </span>
          <span class="detail-chip">
            {{ bucketLabel(product.bucket) }} ·
            {{ formatTerm(product.term_days, product.bucket) }}
          </span>
          <span v-if="!inTarget" class="detail-chip is-muted">
            未进入当前目标配置
          </span>
        </div>

        <section class="detail-section">
          <h3>收益快照</h3>
          <div class="detail-grid">
            <div class="detail-item">
              <span>近 1 月</span><strong>{{ pct(product.return_1m) }}</strong>
            </div>
            <div class="detail-item">
              <span>近 3 月</span><strong>{{ pct(product.return_3m) }}</strong>
            </div>
            <div class="detail-item">
              <span>近 6 月</span><strong>{{ pct(product.return_6m) }}</strong>
            </div>
            <div class="detail-item">
              <span>近 1 年</span><strong>{{ pct(product.return_1y) }}</strong>
            </div>
            <div class="detail-item">
              <span>成立以来</span><strong>{{ pct(product.return_since_inception) }}</strong>
            </div>
            <div class="detail-item">
              <span>年化收益率</span><strong>{{ pct(product.annualized_yield) }}</strong>
            </div>
          </div>
        </section>

        <section class="detail-section">
          <h3>产品信息</h3>
          <div class="detail-grid">
            <div class="detail-item">
              <span>期限</span>
              <strong>{{ formatTerm(product.term_days, product.bucket) }}</strong>
            </div>
            <div class="detail-item">
              <span>起购金额</span><strong>{{ money(product.min_amount) }}</strong>
            </div>
            <div class="detail-item">
              <span>下一个开放日</span><strong>{{ text(product.next_open_date, '待核') }}</strong>
            </div>
            <div class="detail-item">
              <span>费率</span>
              <strong>{{ product.fee_bps === null ? '未获取到' : `${product.fee_bps} bp` }}</strong>
            </div>
            <div class="detail-item">
              <span>容量</span><strong>{{ money(product.capacity) }}</strong>
            </div>
            <div class="detail-item">
              <span>历史月数</span>
              <strong>{{ product.history_months === null ? '未获取到' : `${product.history_months} 个月` }}</strong>
            </div>
            <div class="detail-item">
              <span>业绩基准</span><strong>{{ text(product.benchmark, '未提供') }}</strong>
            </div>
            <div class="detail-item">
              <span>数据日期</span><strong>{{ text(product.data_date, '待核') }}</strong>
            </div>
          </div>
        </section>

        <section class="detail-section">
          <h3>研究评分</h3>
          <div class="detail-grid">
            <div class="detail-item">
              <span>选择评分</span><strong>{{ product.selection_score.toFixed(2) }}</strong>
            </div>
            <div class="detail-item">
              <span>观察评分</span><strong>{{ product.observation_score.toFixed(2) }}</strong>
            </div>
            <div class="detail-item">
              <span>原始评分</span>
              <strong>{{ product.score === null ? '—' : product.score.toFixed(2) }}</strong>
            </div>
            <div class="detail-item">
              <span>精选排名</span><strong>{{ product.selection_rank ?? '—' }}</strong>
            </div>
            <div class="detail-item">
              <span>观察就绪</span><strong>{{ product.observation_ready ? '是' : '否' }}</strong>
            </div>
            <div class="detail-item">
              <span>当前精选</span><strong>{{ product.selected ? '是' : '否' }}</strong>
            </div>
          </div>
        </section>

        <section class="detail-section">
          <h3>当前配置</h3>
          <div class="detail-grid">
            <div class="detail-item">
              <span>期限桶</span>
              <strong>{{ bucketLabel(product.bucket) }} · {{ formatTerm(product.term_days, product.bucket) }}</strong>
            </div>
            <div class="detail-item">
              <span>目标金额</span>
              <strong>{{ inTarget ? money(product.target_amount) : '未进入目标配置' }}</strong>
            </div>
            <div class="detail-item">
              <span>目标占比</span>
              <strong>{{ inTarget ? formatPct(product.target_pct, 1) : '—' }}</strong>
            </div>
            <div class="detail-item">
              <span>距 3% 目标</span>
              <strong>{{ formatPp(product.target_gap_pct, 2, true) }}</strong>
            </div>
            <div class="detail-item">
              <span>可用额度</span>
              <strong>{{ product.quota_available === null ? '未核验' : money(product.quota_available) }}</strong>
            </div>
            <div class="detail-item">
              <span>单笔上限</span>
              <strong>{{ product.quota_max_order === null ? '未设置' : money(product.quota_max_order) }}</strong>
            </div>
            <div class="detail-item">
              <span>额度窗口</span><strong>{{ text(product.quota_window, '未设置') }}</strong>
            </div>
            <div class="detail-item">
              <span>额度核验日</span><strong>{{ text(product.quota_verified_at, '未核验') }}</strong>
            </div>
          </div>
          <p class="detail-reason">
            {{
              product.allocation_reason ||
              (inTarget
                ? '暂无分配说明。'
                : '该产品目前只在观察名单，未进入本次金额分配。')
            }}
          </p>
        </section>

        <section v-if="product.notes" class="detail-section">
          <h3>备注</h3>
          <p class="detail-text">{{ product.notes }}</p>
        </section>

        <p class="detail-source">
          快照 {{ snapshotDate || '待核' }} · 历史业绩 {{ historyDate || '待核' }} · 来源
          {{ text(product.source) }}
        </p>
      </div>

      <p class="detail-note">
        历史业绩不代表未来收益；额度、费率、赎回规则和风险等级以招行 App 与产品说明书为准。
        本页只做研究与记录，不构成买入建议。
      </p>
    </template>
  </dialog>
</template>

<style scoped>
.product-detail-dialog {
  width: min(820px, calc(100vw - 32px));
  max-height: min(86vh, 900px);
}

.product-detail-body {
  display: grid;
  gap: 18px;
  padding: 20px 26px 0;
}

.product-detail-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.detail-chip {
  display: inline-flex;
  align-items: center;
  padding: 4px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--card-soft);
  color: var(--muted);
  font-size: 12px;
  font-weight: 650;
}

.detail-chip.is-muted {
  color: var(--muted-light);
}

.detail-section {
  display: grid;
  gap: 10px;
}

.detail-section h3 {
  margin: 0;
  color: var(--ink-soft);
  font-size: 14px;
  font-weight: 700;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.detail-item {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--card-soft);
}

.detail-item span {
  color: var(--muted);
  font-size: 12px;
}

.detail-item strong {
  overflow-wrap: anywhere;
  color: var(--ink-soft);
  font-family: var(--mono);
  font-size: 12.5px;
  font-weight: 650;
}

.detail-reason,
.detail-text {
  margin: 0;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--green-wash);
  color: var(--ink-soft);
  font-size: 12.5px;
  line-height: 1.7;
}

.detail-source {
  margin: 0;
  color: var(--muted-light);
  font-size: 12px;
  line-height: 1.6;
}

.detail-note {
  margin: 18px 26px 24px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--card-soft);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}

@media (max-width: 720px) {
  .product-detail-body {
    padding: 16px 16px 0;
  }

  .detail-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .detail-note {
    margin: 16px 16px 18px;
  }
}

@media (max-width: 460px) {
  .detail-grid {
    grid-template-columns: 1fr;
  }
}
</style>
