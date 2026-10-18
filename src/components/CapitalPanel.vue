<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import { formatMoney } from '@/composables/useFormatters'
import type { CapitalEventType, DashboardPayload } from '@/types/dashboard'

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

const capital = computed(() => props.dashboard.capital)
const initialized = computed(() => capital.value.initialized)
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

async function deleteEvent(id: number): Promise<void> {
  const confirmed = window.confirm('确认删除这笔本金变动？历史记录的本金快照会重新计算。')
  if (!confirmed) return
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
        <p class="kicker">本金账户</p>
        <h2 id="capitalTitle">本金管理</h2>
      </div>
      <button
        id="editCapitalInit"
        class="button button-ghost button-small"
        type="button"
        @click="emit('openInit')"
      >
        {{ initialized ? '调整起始' : '初始化本金' }}
      </button>
    </div>

    <div class="capital-layout">
      <div class="capital-overview">
        <span class="capital-label">当前 R2 本金</span>
        <strong id="capitalCurrent" class="capital-current">
          {{ initialized ? `¥${formatMoney(capital.current_principal)}` : '—' }}
        </strong>
        <p id="capitalBreakdown" class="capital-breakdown">
          {{
            initialized
              ? `起始 + 转入 − 转出 · 截至 ${capital.as_of || dashboard.meta.today}`
              : '等待初始化本金账户'
          }}
        </p>
        <div class="capital-metrics">
          <div>
            <span>起始本金</span>
            <strong id="capitalInitial">
              {{ initialized ? `¥${formatMoney(capital.initial_principal)}` : '—' }}
            </strong>
          </div>
          <div>
            <span>累计转入</span>
            <strong id="capitalDeposits">
              {{ initialized ? `+¥${formatMoney(capital.total_deposits)}` : '—' }}
            </strong>
          </div>
          <div>
            <span>累计转出</span>
            <strong id="capitalWithdrawals">
              {{ initialized ? `−¥${formatMoney(capital.total_withdrawals)}` : '—' }}
            </strong>
          </div>
        </div>
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
  </section>
</template>

<style scoped>
.capital-event-form {
  min-width: 0;
}

.capital-event-list {
  margin: 0;
}
</style>
