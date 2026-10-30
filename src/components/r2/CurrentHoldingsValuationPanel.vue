<script setup lang="ts">
import { computed } from 'vue'
import {
  formatDateShort,
  formatMoney,
  formatSignedMoney,
} from '@/composables/useFormatters'
import type { CurrentHoldingsValuation } from '@/types/dashboard'

const props = defineProps<{
  valuation: CurrentHoldingsValuation
}>()

const statusLabel = computed(() => {
  if (!props.valuation.available) return '暂无确认持仓'
  if (props.valuation.missing_income_product_codes.length) {
    return '部分产品收益待补'
  }
  return '按产品收益推算'
})

const statusTone = computed(() => {
  if (props.valuation.missing_income_product_codes.length) {
    return 'is-warn'
  }
  return 'is-ok'
})

const coverageNote = computed(() => {
  if (!props.valuation.missing_income_product_codes.length) {
    return `${props.valuation.income_product_count} 只产品均有收益档案，收益记录截至 ${
      props.valuation.income_as_of_date
        ? formatDateShort(props.valuation.income_as_of_date)
        : '—'
    }。`
  }
  return `${props.valuation.missing_income_product_codes.join(
    '、',
  )} 尚无产品收益记录，当前按 0 元收益计入；新确认产品不视为缺失。`
})
</script>

<template>
  <div class="rw-panel-body current-nav-panel">
    <div class="rw-toolbar">
      <div class="rw-card-heading">
        <p class="kicker">DERIVED CONFIRMED HOLDINGS VALUE</p>
        <strong class="rw-panel-title">当前已确认持仓净值</strong>
        <p class="rw-panel-sub">
          由当前已确认持仓本金加逐产品累计收益实时推算。待确认买入、临时桥接本金和已赎回产品不进入净值。
        </p>
      </div>
      <span class="nav-status" :class="statusTone">{{ statusLabel }}</span>
    </div>

    <div class="nav-hero">
      <div>
        <span class="nav-label">推算净值</span>
        <strong class="nav-value">
          {{
            valuation.available && valuation.current_value !== null
              ? `¥${formatMoney(valuation.current_value)}`
              : '—'
          }}
        </strong>
        <p>
          {{
            valuation.as_of_date
              ? `推算日 ${formatDateShort(valuation.as_of_date)}`
              : '尚无已确认持仓'
          }}
          <span v-if="valuation.income_as_of_date">
            · 收益档案截至 {{ formatDateShort(valuation.income_as_of_date) }}
          </span>
        </p>
      </div>
      <div class="nav-facts">
        <div>
          <span>已确认持仓</span>
          <strong>
            {{ valuation.active_holding_count }} 批 ·
            {{ valuation.active_product_count }} 只
          </strong>
        </div>
        <div>
          <span>未赎回本金</span>
          <strong>¥{{ formatMoney(valuation.active_cost) }}</strong>
        </div>
        <div>
          <span>累计产品收益</span>
          <strong
            :class="{
              'rw-gain-text': valuation.product_income > 0,
              'rw-danger-text': valuation.product_income < 0,
            }"
          >
            {{ formatSignedMoney(valuation.product_income) }}
          </strong>
        </div>
        <div>
          <span>待确认买入（未计入）</span>
          <strong>
            {{ valuation.pending_buy_count }} 笔 ·
            ¥{{ formatMoney(valuation.pending_buy_amount, 0) }}
          </strong>
        </div>
      </div>
    </div>

    <div class="nav-formula">
      <span>计算公式</span>
      <strong>
        ¥{{ formatMoney(valuation.active_cost) }}
        {{ valuation.product_income < 0 ? '−' : '+' }}
        ¥{{ formatMoney(Math.abs(valuation.product_income)) }}
        =
        ¥{{ formatMoney(valuation.current_value ?? 0) }}
      </strong>
      <small>金额按分记录，并按逐产品收益档案汇总。</small>
    </div>

    <p class="nav-note">{{ coverageNote }}</p>

    <div class="nav-components">
      <div class="nav-components-head">
        <strong>净值的逐产品组成</strong>
        <span>本金 + 累计收益 = 产品推算金额</span>
      </div>
      <div class="nav-table-wrap">
        <table>
          <thead>
            <tr>
              <th>产品</th>
              <th>未赎回本金</th>
              <th>累计产品收益</th>
              <th>产品推算金额</th>
              <th>收益截至</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in valuation.components" :key="item.product_code">
              <td>
                <strong>{{ item.product_name || item.product_code }}</strong>
                <small>{{ item.product_code }}</small>
              </td>
              <td>¥{{ formatMoney(item.principal) }}</td>
              <td
                :class="{
                  'rw-gain-text': item.product_income > 0,
                  'rw-danger-text': item.product_income < 0,
                }"
              >
                {{ formatSignedMoney(item.product_income) }}
              </td>
              <td>¥{{ formatMoney(item.current_value) }}</td>
              <td>
                {{
                  item.last_yield_date
                    ? formatDateShort(item.last_yield_date)
                    : '暂无收益记录'
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.current-nav-panel {
  display: grid;
  gap: 18px;
}

.nav-status {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
}

.nav-status.is-ok {
  background: #eef4f1;
  color: #2d6758;
}

.nav-status.is-warn {
  background: #fff0eb;
  color: #a33d23;
}

.nav-hero {
  display: grid;
  grid-template-columns: minmax(250px, 0.8fr) minmax(0, 1.5fr);
  gap: 20px;
  align-items: stretch;
  padding: 22px;
  border: 1px solid #dfe9e4;
  border-radius: 18px;
  background:
    radial-gradient(circle at 5% 0%, rgba(54, 132, 104, 0.12), transparent 45%),
    #f8fbf9;
}

.nav-label,
.nav-facts span,
.nav-formula span,
.nav-formula small,
.nav-components-head span,
.nav-components td small {
  color: #65746e;
  font-size: 12px;
}

.nav-value {
  display: block;
  margin: 7px 0;
  color: #173f35;
  font-size: clamp(32px, 4vw, 50px);
  line-height: 1.05;
  letter-spacing: -0.035em;
}

.nav-hero p,
.nav-note {
  margin: 0;
  color: #65746e;
  font-size: 12.5px;
}

.nav-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.nav-facts > div {
  display: grid;
  align-content: center;
  gap: 4px;
  min-height: 70px;
  padding: 12px 14px;
  border: 1px solid #e3ebe7;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.86);
}

.nav-facts strong {
  color: #263b34;
  font-size: 14px;
}

.nav-formula {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 12px;
  padding: 12px 14px;
  border: 1px solid #e1ebe6;
  border-radius: 12px;
  background: #fbfdfc;
}

.nav-formula strong {
  color: #214c40;
  font-size: 14px;
}

.nav-formula small {
  flex-basis: 100%;
}

.nav-note {
  padding: 9px 12px;
  border-radius: 9px;
  background: #f5f8f6;
}

.nav-components {
  display: grid;
  gap: 10px;
}

.nav-components-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}

.nav-components-head strong {
  color: #263b34;
  font-size: 14px;
}

.nav-table-wrap {
  overflow-x: auto;
  border: 1px solid #e3ebe7;
  border-radius: 12px;
}

.nav-components table {
  width: 100%;
  min-width: 720px;
  border-collapse: collapse;
}

.nav-components th,
.nav-components td {
  padding: 10px 12px;
  border-bottom: 1px solid #edf2ef;
  text-align: left;
  font-size: 12.5px;
  white-space: nowrap;
}

.nav-components th {
  color: #65746e;
  font-size: 12px;
  font-weight: 700;
  background: #f8fbf9;
}

.nav-components tr:last-child td {
  border-bottom: 0;
}

.nav-components td:first-child {
  display: grid;
  gap: 2px;
}

.nav-components td strong {
  color: #2d3c37;
}

@media (max-width: 760px) {
  .nav-hero {
    grid-template-columns: 1fr;
  }

  .nav-facts {
    grid-template-columns: 1fr 1fr;
  }

  .nav-components-head {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
