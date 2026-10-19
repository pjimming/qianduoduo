<script setup lang="ts">
import { computed } from 'vue'
import {
  formatCompactMoney,
  formatDateShort,
  formatMoney,
  formatPct,
} from '@/composables/useFormatters'
import type { Holding, HoldingsSummary } from '@/types/dashboard'

const props = defineProps<{
  holdings: Holding[]
  summary: HoldingsSummary
  today: string
}>()

const emit = defineEmits<{ (event: 'open-trades'): void }>()

const ladderMax = computed(() =>
  Math.max(1, ...props.summary.ladder.map((item) => item.amount)),
)

const bucketRows = computed(() => {
  const rows = [
    { label: '日开', pct: props.summary.bucket_pct.liquid, amount: props.summary.buckets.liquid },
    { label: '7–30 天', pct: props.summary.bucket_pct.short, amount: props.summary.buckets.short },
    { label: '31–100 天', pct: props.summary.bucket_pct.medium, amount: props.summary.buckets.medium },
    { label: '100 天以上', pct: props.summary.bucket_pct.long, amount: props.summary.buckets.long },
  ]
  if (props.summary.buckets.unknown > 0) {
    rows.push({
      label: '未填期限',
      pct: props.summary.bucket_pct.unknown,
      amount: props.summary.buckets.unknown,
    })
  }
  return rows
})

function ladderHeight(amount: number): string {
  if (amount <= 0) return '2px'
  return `${Math.max(6, (amount / ladderMax.value) * 100)}%`
}

function termLabel(value: number | null): string {
  if (value === 0) return '日开'
  if (value === null) return '未填'
  return `${value} 天`
}

function barWidth(value: number | null): string {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0%'
  return `${Math.max(0, Math.min(100, number))}%`
}
</script>

<template>
  <div class="rw-panel-body">
    <div class="rw-toolbar">
      <div>
        <strong class="rw-panel-title">持仓由交易流水自动推导</strong>
        <p class="rw-panel-sub">
          只统计已确认买入批次；待确认交易在「交易流水」中单独显示，不会提前进入集中度和期限阶梯。
        </p>
      </div>
      <button type="button" class="rw-button is-secondary" @click="emit('open-trades')">
        去记一笔交易
      </button>
    </div>

    <div class="rw-stat-row rw-stat-row-spaced">
      <span class="rw-stat-chip">剩余本金 <strong>¥{{ formatMoney(summary.total_amount, 0) }}</strong></span>
      <span class="rw-stat-chip">
        单只最高
        <strong>{{ formatPct(summary.max_product?.pct, 1) }}</strong>
      </span>
      <span class="rw-stat-chip">
        日开+30天
        <strong>{{ formatPct(summary.liquidity_ratio_pct, 1) }}</strong>
      </span>
      <span class="rw-stat-chip" :class="{ 'is-warn': summary.overdue_count > 0 }">
        已到期 <strong>{{ summary.overdue_count }} 笔</strong>
      </span>
    </div>

    <div v-if="summary.alerts.length" class="rw-alerts">
      <span
        v-for="alert in summary.alerts"
        :key="alert.code"
        class="rw-alert"
        :class="`is-${alert.level}`"
      >
        {{ alert.text }}
      </span>
    </div>

    <div class="rw-holdings-overview">
      <section class="rw-subpanel">
        <div class="rw-subhead">
          <strong>单只集中度</strong>
          <span>上限参考 30%</span>
        </div>
        <div v-if="summary.by_product.length" class="rw-bars">
          <div v-for="item in summary.by_product.slice(0, 6)" :key="item.code || item.name" class="rw-bar-row">
            <span class="rw-bar-label">{{ item.name }}</span>
            <div class="rw-bar-track">
              <span
                class="rw-bar-fill"
                :class="{ 'is-warn': (item.pct ?? 0) > 30 }"
                :style="{ width: barWidth(item.pct) }"
              ></span>
            </div>
            <strong>{{ formatPct(item.pct, 1) }}</strong>
          </div>
        </div>
        <div v-else class="rw-empty is-compact">还没有已确认持仓。</div>
      </section>

      <section class="rw-subpanel">
        <div class="rw-subhead">
          <strong>发行方集中度</strong>
          <span>多发行方时参考 50%</span>
        </div>
        <div v-if="summary.by_issuer.length" class="rw-bars">
          <div v-for="item in summary.by_issuer.slice(0, 5)" :key="item.name" class="rw-bar-row">
            <span class="rw-bar-label">{{ item.name }}</span>
            <div class="rw-bar-track">
              <span
                class="rw-bar-fill"
                :class="{ 'is-warn': (item.pct ?? 0) > 50 && summary.by_issuer.length > 1 }"
                :style="{ width: barWidth(item.pct) }"
              ></span>
            </div>
            <strong>{{ formatPct(item.pct, 1) }}</strong>
          </div>
        </div>
        <div v-else class="rw-empty is-compact">还没有已确认持仓。</div>
      </section>
    </div>

    <section class="rw-subpanel">
      <div class="rw-subhead">
        <strong>期限桶</strong>
        <span>日开 + 30 天内建议不低于 30%</span>
      </div>
      <div class="rw-bucket-grid">
        <div v-for="bucket in bucketRows" :key="bucket.label" class="rw-bucket">
          <span>{{ bucket.label }}</span>
          <strong>{{ formatPct(bucket.pct, 1) }}</strong>
          <small>¥{{ formatMoney(bucket.amount, 0) }}</small>
        </div>
      </div>
    </section>

    <section class="rw-subpanel">
      <div class="rw-subhead">
        <strong>未来 12 个月到期阶梯</strong>
        <span>按已确认批次的剩余本金</span>
      </div>
      <div class="rw-ladder">
        <div v-for="item in summary.ladder" :key="item.month" class="rw-ladder-col">
          <strong>{{ item.amount > 0 ? formatCompactMoney(item.amount) : '—' }}</strong>
          <div class="rw-ladder-track">
            <span class="rw-ladder-fill" :style="{ height: ladderHeight(item.amount) }"></span>
          </div>
          <small>{{ item.month.slice(5) }}月</small>
        </div>
      </div>
      <p v-if="summary.beyond_12m_amount > 0" class="rw-form-hint">
        12 个月以上到期：¥{{ formatMoney(summary.beyond_12m_amount, 0) }}
      </p>
    </section>

    <div v-if="holdings.length === 0" class="rw-empty">
      还没有已确认持仓。先在「交易流水」中登记买入并确认，系统会按批次自动生成持仓。
    </div>
    <div v-else class="rw-table-wrap">
      <table class="rw-table">
        <thead>
          <tr>
            <th>产品 / 批次</th>
            <th class="is-number">剩余本金</th>
            <th>买入</th>
            <th>期限</th>
            <th>到期</th>
            <th class="is-number">已赎回本金</th>
            <th class="is-number">已实现收益</th>
            <th>风险</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in holdings" :key="item.lot_id || item.id">
            <td>
              <strong>{{ item.product_name }}</strong>
              <small>
                {{ item.product_code || '无代码' }} · 批次 #{{ item.source_trade_id || item.id }}
              </small>
            </td>
            <td class="is-number">{{ formatMoney(item.amount, 0) }}</td>
            <td>{{ formatDateShort(item.purchase_date) }}</td>
            <td>{{ termLabel(item.term_days) }}</td>
            <td>
              <span :class="{ 'rw-danger-text': item.maturity_date && item.maturity_date < today }">
                {{ item.maturity_date ? formatDateShort(item.maturity_date) : '—' }}
              </span>
            </td>
            <td class="is-number">
              {{ formatMoney(item.allocated_principal ?? 0, 0) }}
            </td>
            <td class="is-number" :class="{ 'rw-gain-text': (item.realized_pnl ?? 0) > 0 }">
              {{ formatMoney(item.realized_pnl ?? 0, 2) }}
            </td>
            <td>{{ item.risk_level }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
