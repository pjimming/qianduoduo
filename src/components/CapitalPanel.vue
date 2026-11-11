<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import { formatMoney } from '@/composables/useFormatters'
import type { CapitalEventType, DashboardPayload } from '@/types/dashboard'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const props = defineProps<{
  dashboard: DashboardPayload
}>()

const emit = defineEmits<{
  openInit: []
}>()

const dashboardStore = useDashboardStore()
const { show } = useToast()

const capitalEventType = ref<CapitalEventType>('deposit')
const eventDate = ref(props.dashboard.meta.today)
const eventAmount = ref<number | null>(null)
const eventNote = ref('')
const saving = ref(false)
const pendingEventId = ref<number | null>(null)

const capital = computed(() => props.dashboard.capital)
const initialized = computed(() => capital.value.initialized)
const funding = computed(() => capital.value.funding)
const fundingMoney = (value: number) => `¥${formatMoney(value / 100)}`
const orderedEvents = computed(() => [...capital.value.events].reverse())
const minEventDate = computed(() => capital.value.initial_date ?? '')
const maxEventDate = computed(() => props.dashboard.meta.today)

watch(
  () => [capital.value.initialized, capital.value.initial_date, props.dashboard.meta.today],
  () => {
    if (initialized.value && (!eventDate.value || eventDate.value < minEventDate.value)) {
      eventDate.value = props.dashboard.meta.today
    }
  },
  { immediate: true },
)

function setCapitalEventType(type: CapitalEventType): void {
  if (!initialized.value) return
  capitalEventType.value = type
}

async function submitEvent(): Promise<void> {
  if (!initialized.value) {
    emit('openInit')
    return
  }
  if (!eventDate.value) {
    show('请选择资金变动日期', { error: true })
    return
  }
  const amount = Number(eventAmount.value)
  if (!Number.isFinite(amount) || amount <= 0) {
    show('转入/转出金额需要大于 0', { error: true })
    return
  }
  saving.value = true
  try {
    await dashboardStore.createCapitalEvent({
      event_date: eventDate.value,
      event_type: capitalEventType.value,
      amount,
      note: eventNote.value.trim(),
    })
    eventAmount.value = null
    eventNote.value = ''
    show(
      `${capitalEventType.value === 'deposit' ? '转入' : '转出'} ¥${formatMoney(
        amount,
      )} 已记录，相关本金快照已更新`,
      { duration: 4200 },
    )
  } catch (error) {
    show(error instanceof Error ? error.message : '本金变动保存失败', {
      error: true,
      duration: 5000,
    })
  } finally {
    saving.value = false
  }
}

function deleteEvent(id: number): void {
  pendingEventId.value = id
}

async function confirmDeleteEvent(): Promise<void> {
  const id = pendingEventId.value
  pendingEventId.value = null
  if (id === null) return
  try {
    await dashboardStore.deleteCapitalEvent(id)
    show('本金变动已删除，本金快照已重算')
  } catch (error) {
    show(error instanceof Error ? error.message : '删除本金变动失败', {
      error: true,
      duration: 5000,
    })
  }
}
</script>

<template>
  <section class="panel capital-panel" id="capitalPanel" aria-labelledby="capitalTitle">
    <div class="panel-head">
      <div>
        <h2 id="capitalTitle">本金管理</h2>
      </div>
      <div class="capital-head-actions">
        <span
          v-if="dashboard.meta.latest_backup"
          class="capital-backup-badge"
          :title="`每日自动备份 · 最近一次 ${dashboard.meta.latest_backup.date}`"
        >
          备份 {{ dashboard.meta.latest_backup.date.slice(5) }}
        </span>
        <button
          id="editCapitalInit"
          class="button button-ghost button-small"
          type="button"
          @click="emit('openInit')"
        >
          {{ initialized ? '调整起始' : '初始化本金' }}
        </button>
      </div>
    </div>

    <div class="capital-layout">
      <div class="capital-overview">
        <span class="capital-label">自己投入的钱</span>
        <strong id="capitalCurrent" class="capital-current">
          {{ initialized ? `¥${formatMoney(capital.current_principal)}` : '—' }}
        </strong>
        <p id="capitalBreakdown" class="capital-breakdown">
          {{
            initialized
              ? `最初投入 + 后来转入 − 已经转出 · 自 ${capital.initial_date} 起算 · 截至 ${
                  capital.as_of || dashboard.meta.today
                }`
              : '等待初始化本金账户'
          }}
        </p>
        <div class="capital-metrics">
          <div>
            <span>最初投入的钱</span>
            <strong id="capitalInitial">
              {{ initialized ? `¥${formatMoney(capital.initial_principal)}` : '—' }}
            </strong>
          </div>
          <div>
            <span>后来转进的钱</span>
            <strong id="capitalDeposits">
              {{ initialized ? `+¥${formatMoney(capital.total_deposits)}` : '—' }}
            </strong>
          </div>
          <div>
            <span>已经转出的钱</span>
            <strong id="capitalWithdrawals">
              {{ initialized ? `−¥${formatMoney(capital.total_withdrawals)}` : '—' }}
            </strong>
          </div>
        </div>
        <section v-if="initialized" id="capitalFunding" class="capital-funding" aria-label="钱现在放在哪里">
          <h3>钱现在放在哪里</h3>
          <template v-if="funding">
            <dl class="capital-funding-list">
              <div title="赎回到账金额减去原买入成本；亏损显示负数，不是全部理财收益"><dt>赎回收益（已到账）</dt><dd id="capitalRealized">{{ fundingMoney(funding.settled_realized_pnl_cents) }}</dd></div>
              <div title="自己投入的钱加上已到账的赎回收益，用来核对资金，不是当前总资产"><dt>本金＋已到账收益</dt><dd id="capitalFundingBase">{{ fundingMoney(funding.funding_capacity_cents) }}</dd></div>
              <div title="目前仍持有的理财买入时花的钱，不含持有期间的收益"><dt>持有理财的买入金额</dt><dd id="capitalHoldingCost">{{ fundingMoney(funding.holding_cost_cents) }}</dd></div>
              <div title="买入金额超过自己投入的钱、且有已到账收益支持的部分，已包含在上面的买入金额中"><dt>用收益再买的部分</dt><dd id="capitalReinvested">{{ fundingMoney(funding.reinvested_pnl_cents) }}</dd></div>
              <div><dt>暂未计入持仓的钱</dt><dd id="capitalOutsideHoldings">{{ fundingMoney(funding.outside_holdings_cents) }}</dd></div>
            </dl>
            <p>本金＋已到账收益＝持有理财的买入金额＋暂未计入持仓的钱。这里只统计赎回后已到账的收益，不包含持有中的理财收益。</p>
            <p>暂未计入持仓的钱不代表银行可用余额，可能还在到账途中，或已预留用于买入。</p>
            <p v-if="funding.unverified_settlement_count" class="capital-funding-status">
              {{ funding.unverified_settlement_count }} 笔赎回的到账或金额待核，其盈亏暂未计入。
            </p>
            <router-link to="/ledger/trades">核对交易与持仓</router-link>
          </template>
          <p v-else>交易资金联动数据待更新，请刷新页面。</p>
        </section>
        <div v-if="!initialized" id="capitalUninitialized" class="capital-uninitialized">
          <p>本金账户尚未初始化，初始化后才能记录收益。</p>
          <button
            id="capitalInitButton"
            class="button button-primary button-small"
            type="button"
            @click="emit('openInit')"
          >
            设定起始本金
          </button>
        </div>
      </div>

      <form id="capitalEventForm" class="capital-event-form" novalidate @submit.prevent="submitEvent">
        <div class="capital-type-switch" role="group" aria-label="资金变动类型">
          <button
            type="button"
            :class="{ 'is-active': capitalEventType === 'deposit' }"
            :disabled="!initialized"
            @click="setCapitalEventType('deposit')"
          >
            转入
          </button>
          <button
            type="button"
            :class="{ 'is-active': capitalEventType === 'withdraw' }"
            :disabled="!initialized"
            @click="setCapitalEventType('withdraw')"
          >
            转出
          </button>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="capitalEventDate">日期</label>
            <input
              id="capitalEventDate"
              v-model="eventDate"
              type="date"
              :min="minEventDate"
              :max="maxEventDate"
              :disabled="!initialized"
              required
            />
          </div>
          <div class="field">
            <label for="capitalEventAmount">金额</label>
            <div class="input-affix">
              <span>¥</span>
              <input
                id="capitalEventAmount"
                v-model.number="eventAmount"
                type="number"
                min="0.01"
                step="0.01"
                inputmode="decimal"
                placeholder="0.00"
                :disabled="!initialized"
                required
              />
            </div>
          </div>
        </div>
        <div class="field">
          <label for="capitalEventNote">备注 <span class="field-help">可选</span></label>
          <input
            id="capitalEventNote"
            v-model="eventNote"
            type="text"
            maxlength="200"
            placeholder="例如：工资转入、赎回后转出"
            :disabled="!initialized"
          />
        </div>
        <button
          id="capitalEventSubmit"
          class="button button-primary capital-event-submit"
          type="submit"
          :disabled="!initialized || saving"
        >
          {{ saving ? '保存中…' : capitalEventType === 'deposit' ? '记录转入' : '记录转出' }}
        </button>
        <p class="form-note">转入和转出只改变本金，不计入当日收益。历史记录的本金快照会自动重算。</p>
      </form>

      <div class="capital-history">
        <div class="capital-history-head">
          <span>最近变动</span>
          <span id="capitalEventCount">{{ capital.events.length }} 笔</span>
        </div>
        <ul id="capitalEventList" class="capital-event-list">
          <li v-for="event in orderedEvents" :key="event.id" class="capital-event-item">
            <span class="capital-event-icon" :class="{ 'is-withdraw': event.type === 'withdraw' }">
              {{ event.type === 'deposit' ? '↗' : '↙' }}
            </span>
            <div class="capital-event-main">
              <strong>
                {{ event.type === 'deposit' ? '转入' : '转出' }} ¥{{ formatMoney(event.amount) }}
              </strong>
              <span :title="event.note">
                {{ event.date }}{{ event.note ? ` · ${event.note}` : '' }}
              </span>
            </div>
            <span class="capital-event-after" title="变动后本金">
              余 ¥{{ formatMoney(event.principal_after ?? 0) }}
            </span>
            <button
              class="icon-button is-danger"
              type="button"
              :aria-label="`删除 ${event.date} 的${event.type === 'deposit' ? '转入' : '转出'}记录`"
              @click="deleteEvent(event.id)"
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M4 6h12M8 3.5h4M6 6l.7 10h6.6L14 6M8.2 9v4.2M11.8 9v4.2" />
              </svg>
            </button>
          </li>
        </ul>
        <p v-if="!capital.events.length" id="capitalHistoryEmpty" class="capital-history-empty">
          还没有转入或转出记录。
        </p>
      </div>
    </div>

    <ConfirmDialog
      :open="pendingEventId !== null"
      title="删除这笔本金变动？"
      message="删除后，历史记录的本金快照会按剩余变动重新计算。"
      confirm-label="删除变动"
      danger
      @confirm="confirmDeleteEvent"
      @update:open="pendingEventId = null"
    />
  </section>
</template>

<style scoped>
.capital-event-form {
  min-width: 0;
}

.capital-event-list {
  margin: 0;
}

.capital-funding {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
  color: var(--ink-soft);
  font-size: 12.5px;
  line-height: 1.6;
}

.capital-funding h3 {
  margin: 0 0 10px;
  color: var(--ink);
  font-size: 14px;
}

.capital-funding-list {
  margin: 0 0 12px;
}

.capital-funding-list > div {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 5px 0;
}

.capital-funding-list dd {
  margin: 0;
  color: var(--ink);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.capital-funding p {
  margin: 10px 0;
}

.capital-funding a {
  color: var(--green);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.capital-overview .capital-label,
.capital-overview .capital-breakdown,
.capital-overview .capital-metrics span {
  color: var(--ink-soft);
}

.capital-overview .capital-metrics {
  grid-template-columns: 1fr;
}

.capital-overview .capital-metrics > div {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 12px;
  grid-column: auto;
}
</style>
