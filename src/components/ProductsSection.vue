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
  if (!products.value.watchlist.length) return '观察池目标可行性'
  if (stats.value.median_1y === null) return '产品池数据不足'
  return `观察池近 1 年中位 ${formatPct(stats.value.median_1y, 2)}`
})

const goalText = computed(() => {
  if (!products.value.watchlist.length) return '没有可读取的历史产品快照。'
  if (stats.value.median_1y === null) return '没有足够的近 1 年历史数据。'
  return `开放产品 ${stats.value.observation_ready}/${
    stats.value.total
  } 只入池 · 近 3 月中位 ${formatPct(stats.value.median_3m, 2)} · 目标覆盖 ${formatPct(
    stats.value.target_coverage_pct,
    1,
  )}`
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
        <p class="kicker">R2 观察池</p>
        <h2 id="productsTitle">短、中、长三个期限，各留一个复核对象</h2>
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
          请确认 data/cmb_r2_products_2026-10-18.csv 仍在原位，并重新启动服务。
        </p>
      </div>
    </div>

    <p class="product-disclaimer">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 2 3.5 4.5v5.2c0 3.8 2.5 6.6 6.5 8.3 4-1.7 6.5-4.5 6.5-8.3V4.5L10 2Z" />
        <path d="M7.5 10.2 9.2 12l3.5-4" />
      </svg>
      <span>
        这里只按近 3/6/12 月年化做“观察排序”，未核验费率、最大回撤、额度和赎回规则，不构成推荐或买入建议。产品池是静态历史快照，不会自动定时更新；替换 CSV 后可点“刷新快照”重新读取。购买前以招行 App、产品说明书和当日额度为准。
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
