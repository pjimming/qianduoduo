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
    { label: '短 1–30 天', pct: props.summary.bucket_pct.short, amount: props.summary.buckets.short },
    { label: '中 31–100 天', pct: props.summary.bucket_pct.medium, amount: props.summary.buckets.medium },
    { label: '长 101 天+', pct: props.summary.bucket_pct.long, amount: props.summary.buckets.long },
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
      <div class="rw-card-heading">
        <p class="kicker">HOLDINGS</p>
        <strong class="rw-panel-title">持仓由交易流水自动推导</strong>
        <p class="rw-panel-sub">
          只统计已确认买入批次；待确认交易在「交易流水」中单独显示，不会提前进入单只占比和期限阶梯。
        </p>
      </div>
      <div class="rw-toolbar-actions">
        <button type="button" class="rw-button is-secondary" @click="emit('open-trades')">
          去记一笔交易
        </button>
      </div>
    </div>

    <div class="rw-stat-row rw-stat-row-spaced">
      <span class="rw-stat-chip">
        未赎回成本本金
        <strong>¥{{ formatMoney(summary.total_amount, 0) }}</strong>
      </span>
      <span class="rw-stat-chip">
        最大单只成本占比
        <strong>{{ formatPct(summary.max_product?.pct, 1) }}</strong>
      </span>
      <span class="rw-stat-chip">
        短期流动性（7–30 天）
        <strong>{{ formatPct(summary.short_liquidity_ratio_pct, 1) }}</strong>
      </span>
      <span class="rw-stat-chip" :class="{ 'is-warn': summary.daily_open_ratio_pct !== null }">
        现有日开
        <strong>{{ formatPct(summary.daily_open_ratio_pct, 1) }}</strong>
      </span>
      <span class="rw-stat-chip" :class="{ 'is-warn': summary.overdue_count > 0 }">
        到期未赎回 <strong>{{ summary.overdue_count }} 笔</strong>
      </span>
    </div>
    <p class="rw-form-hint cost-basis-note">
      未赎回成本本金 = 已确认买入金额 − 已匹配赎回本金；它不是账户余额，也不是产品当前市值。
    </p>

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
          <strong>单只成本占比</strong>
          <span>未赎回成本上限参考 30%</span>
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
          <strong>发行方成本占比</strong>
          <span>仅展示当前持仓状态</span>
        </div>
        <div v-if="summary.by_issuer.length" class="rw-bars">
          <div v-for="item in summary.by_issuer.slice(0, 5)" :key="item.name" class="rw-bar-row">
            <span class="rw-bar-label">{{ item.name }}</span>
            <div class="rw-bar-track">
              <span
                class="rw-bar-fill"
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
        <strong>未赎回成本的产品期限分布</strong>
        <span>评分桶短 1–30 天；流动性优先 7–30 天或 T+1；新增日开目标固定 0%</span>
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
        <span>按已确认批次的未赎回成本本金</span>
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
        到期日在 12 个月以上的未赎回成本：¥{{ formatMoney(summary.beyond_12m_amount, 0) }}
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
            <th class="is-number">未赎回成本本金</th>
            <th>确认起持日</th>
            <th>产品期限</th>
            <th>到期日</th>
            <th class="is-number">累计已赎回成本</th>
            <th class="is-number">已实现盈亏</th>
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
