<script setup lang="ts">
import { computed, ref } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import {
  bucketLabel,
  formatPct,
  formatPp,
  formatTerm,
} from '@/composables/useFormatters'
import type { DashboardPayload, Product } from '@/types/dashboard'
import ProductDialog from './ProductDialog.vue'

const props = defineProps<{
  dashboard: DashboardPayload
}>()

const dashboardStore = useDashboardStore()
const { show } = useToast()
const dialogOpen = ref(false)
const refreshing = ref(false)

const products = computed(() => props.dashboard.products)
const stats = computed(() => props.dashboard.products.stats)

const goalTitle = computed(() => {
  if (!products.value.watchlist.length) return '精选池目标可行性'
  if (stats.value.median_1y === null) return '产品池数据不足'
  return `精选池近 1 年中位 ${formatPct(stats.value.median_1y, 2)}`
})

const goalText = computed(() => {
  if (!products.value.watchlist.length) return '没有可读取的普通可买产品池。'
  if (stats.value.median_1y === null) return '没有足够的近 1 年历史数据。'
  const counts = stats.value.bucket_counts
  return `普通可买 ${stats.value.total} 只（日开 ${counts.cash} / 短 ${counts.short} / 中 ${
    counts.medium
  } / 长 ${counts.long}）· 精选 ${stats.value.selected_count} 只 · 全池 1Y 中位 ${formatPct(
    stats.value.universe_median_1y,
    2,
  )} · 目标覆盖 ${formatPct(stats.value.target_coverage_pct, 1)}`
})

const goalGap = computed(() => {
  if (!products.value.watchlist.length || stats.value.target_gap_pct === null) return '—'
  return `距 3% ${formatPp(stats.value.target_gap_pct, 2, true)}`
})

const progressStyle = computed(() => ({
  width: `${
    stats.value.median_1y === null
      ? 0
      : Math.max(0, Math.min(100, stats.value.target_coverage_pct || 0))
  }%`,
}))

function gapClass(product: Product): string {
  return product.target_gap_pct !== null && product.target_gap_pct >= 0 ? 'positive' : ''
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
</script>

<template>
  <section class="products-section" aria-labelledby="productsTitle">
    <div class="section-head">
      <div>
        <p class="kicker">R2 候选池 → 精选池</p>
        <h2 id="productsTitle">全量普通候选池，每个期限按规则精选 3 只</h2>
      </div>
      <div class="section-actions">
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
    </div>

    <div class="product-goal-strip">
      <div class="product-goal-copy">
        <span class="goal-dot"></span>
        <div>
          <strong>{{ goalTitle }}</strong>
          <p>{{ goalText }}</p>
        </div>
      </div>
      <div class="pool-progress" aria-hidden="true">
        <span :style="progressStyle"></span>
      </div>
      <span
        class="pool-gap"
        :class="{ positive: stats.target_gap_pct !== null && stats.target_gap_pct >= 0 }"
      >
        {{ goalGap }}
      </span>
    </div>

    <div v-if="products.watchlist.length" class="watchlist">
      <article
        v-for="product in products.watchlist"
        :key="product.code"
        class="product-card"
        :class="`bucket-${product.bucket}`"
      >
        <div class="product-top">
          <span class="term-badge">
            {{ bucketLabel(product.bucket) }} · {{ formatTerm(product.term_days, product.bucket) }}
          </span>
          <span class="product-code">{{ product.code }}</span>
        </div>
        <h3 class="product-name">{{ product.name }}</h3>
        <div class="product-yield">
          <strong>{{ formatPct(product.return_1y, 2) }}</strong>
          <span>近 1 年历史年化</span>
        </div>
        <div class="product-stats">
          <div class="product-stat">
            <span>近 3 月</span>
            <strong>{{ formatPct(product.return_3m, 2) }}</strong>
          </div>
          <div class="product-stat">
            <span>近 6 月</span>
            <strong>{{ formatPct(product.return_6m, 2) }}</strong>
          </div>
        </div>
        <p class="product-benchmark" :title="product.benchmark">
          {{ product.benchmark || '底层与业绩基准待核验' }}
        </p>
        <div class="product-foot">
          <span>{{ product.data_date || '日期待核' }} · 历史快照</span>
          <span class="product-gap" :class="gapClass(product)">
            距 3%
            {{
              product.target_gap_pct === null
                ? '—'
                : formatPp(product.target_gap_pct, 2, true)
            }}
          </span>
        </div>
      </article>
    </div>
    <div v-else class="watchlist">
      <div class="product-card">
        <div class="product-name">产品快照暂不可用</div>
        <p class="product-benchmark">
          请确认 data/ 下的产品快照 CSV 仍在原位（当前读取
          {{ dashboard.meta.product_csv || 'cmb_r2_universe*.csv' }}），或在
          R2_PRODUCT_CSV 中指定路径后重启服务。
        </p>
      </div>
    </div>

    <p class="product-disclaimer">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 2 3.5 4.5v5.2c0 3.8 2.5 6.6 6.5 8.3 4-1.7 6.5-4.5 6.5-8.3V4.5L10 2Z" />
        <path d="M7.5 10.2 9.2 12l3.5-4" />
      </svg>
      <span>
        候选池只保留人民币、公募、R2/PR2、开放中、成立满 12 个月且有完整 1M/3M/6M/1Y
        的普通可买产品，并剔除私行/私银/私享/尊享/企享/专属/私募产品。精选规则以近
        3M/6M 为主，对 1Y 明显高于 6M 的前视偏差扣分，并对单一发行方做分散；未核验实时额度、赎回规则和产品说明书，不构成推荐或买入建议。
      </span>
    </p>

    <ProductDialog
      v-model:open="dialogOpen"
      :products="products"
      :snapshot-date="dashboard.meta.product_snapshot_date"
      :history-date="dashboard.meta.product_history_date"
    />
  </section>
</template>

<style scoped>
.product-goal-strip {
  position: relative;
}

.watchlist {
  align-items: stretch;
}
</style>
