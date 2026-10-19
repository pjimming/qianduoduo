<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import { formatDateShort, formatPct } from '@/composables/useFormatters'
import type { DashboardPayload, LedgerAction, LedgerRecord } from '@/types/dashboard'

const props = defineProps<{
  dashboard: DashboardPayload
}>()

const emit = defineEmits<{
  saved: [date: string]
}>()

const dashboardStore = useDashboardStore()
const { show } = useToast()

const formMode = ref<'create' | 'edit'>('create')
const editingDate = ref<string | null>(null)
const recordDate = ref(props.dashboard.meta.today)
const dailyPnl = ref<number | ''>('')
const action = ref<LedgerAction>('无操作')
const notes = ref('')
const saving = ref(false)
const panel = ref<HTMLElement | null>(null)
const dailyPnlInput = ref<HTMLInputElement | null>(null)
let focusTimer: number | undefined

const isEditing = computed(() => formMode.value === 'edit')
const principal = computed(() => dashboardStore.principalForDate(recordDate.value))
const accountStartDate = computed(() => props.dashboard.capital.initial_date ?? null)
const isBeforeAccountStart = computed(
  () =>
    Boolean(accountStartDate.value && recordDate.value) &&
    recordDate.value < (accountStartDate.value as string),
)
const showTodayNotice = computed(
  () =>
    props.dashboard.meta.has_today_record &&
    editingDate.value !== props.dashboard.meta.today,
)
const entryDateChip = computed(() =>
  recordDate.value === props.dashboard.meta.today
    ? '今天'
    : formatDateShort(recordDate.value),
)

const preview = computed(() => {
  const currentPrincipal = principal.value
  const pnl = Number(dailyPnl.value)
  if (
    currentPrincipal === null ||
    currentPrincipal <= 0 ||
    dailyPnl.value === '' ||
    !Number.isFinite(pnl)
  ) {
    return { text: '—', tone: '' }
  }
  const rate = (pnl / currentPrincipal) * 100
  return {
    text: formatPct(rate, 4, true),
    tone: rate > 0 ? 'positive' : rate < 0 ? 'negative' : '',
  }
})

watch(
  () => [accountStartDate.value, props.dashboard.meta.today] as const,
  () => {
    if (!isEditing.value && isBeforeAccountStart.value) {
      recordDate.value = props.dashboard.meta.today
    }
  },
)

function applyRecord(record: LedgerRecord): void {
  editingDate.value = record.date
  formMode.value = 'edit'
  recordDate.value = record.date
  dailyPnl.value = record.daily_pnl
  action.value = record.action
  notes.value = record.notes
}

function resetForm(): void {
  editingDate.value = null
  formMode.value = 'create'
  recordDate.value = props.dashboard.meta.today
  dailyPnl.value = ''
  action.value = '无操作'
  notes.value = ''
}

function loadRecordForEdit(date: string, focus = true): void {
  const record = dashboardStore.recordByDate(date)
  if (!record) {
    show('没有找到这条记录', { error: true })
    return
  }
  applyRecord(record)
  if (!focus) return
  panel.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  window.clearTimeout(focusTimer)
  focusTimer = window.setTimeout(() => dailyPnlInput.value?.focus(), 380)
}

function loadToday(): void {
  loadRecordForEdit(props.dashboard.meta.today)
}

function startRecord(date: string): void {
  if (!date) return
  if (accountStartDate.value && date < accountStartDate.value) {
    show(`该日期早于本金起始日 ${accountStartDate.value}，不纳入收益账本`, {
      error: true,
    })
    return
  }
  editingDate.value = null
  formMode.value = 'create'
  recordDate.value = date
  dailyPnl.value = ''
  action.value = '无操作'
  notes.value = ''
  panel.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  window.clearTimeout(focusTimer)
  focusTimer = window.setTimeout(() => dailyPnlInput.value?.focus(), 380)
}

async function handleSubmit(): Promise<void> {
  if (!recordDate.value) {
    show('请选择日期', { error: true })
    return
  }
  if (recordDate.value > props.dashboard.meta.today) {
    show('不能记录未来日期', { error: true })
    return
  }
  if (!props.dashboard.capital.initialized) {
    show('请先初始化本金账户，再记录收益', { error: true })
    return
  }
  if (accountStartDate.value && recordDate.value < accountStartDate.value) {
    show(`本金账户自 ${accountStartDate.value} 起算，不能记录更早日期`, {
      error: true,
    })
    return
  }
  if (principal.value === null) {
    show('该日期没有可用本金，请检查本金账户设置', { error: true })
    return
  }
  if (principal.value <= 0) {
    show('该日期本金为 0，无法记录收益', { error: true })
    return
  }
  if (dailyPnl.value === '') {
    show('请填写当日收益，亏损填负数', { error: true })
    return
  }
  const pnl = Number(dailyPnl.value)
  if (!Number.isFinite(pnl)) {
    show('请填写当日收益，亏损填负数', { error: true })
    return
  }
  saving.value = true
  try {
    const input = {
      date: recordDate.value,
      daily_pnl: pnl,
      action: action.value,
      notes: notes.value.trim(),
    }
    const isEdit = Boolean(editingDate.value)
    const response = isEdit
      ? await dashboardStore.updateRecord(editingDate.value as string, input)
      : await dashboardStore.createRecord(input)
    applyRecord(response.record)
    emit('saved', response.record.date)
    show(isEdit ? '记录已更新' : '收益已记入账本')
  } catch (error) {
    show(error instanceof Error ? error.message : '保存失败', {
      error: true,
      duration: 5000,
    })
  } finally {
    saving.value = false
  }
}

onUnmounted(() => {
  window.clearTimeout(focusTimer)
})

defineExpose({
  loadRecordForEdit,
  startRecord,
  resetForm,
  isEditingDate: (date: string): boolean => editingDate.value === date,
})
</script>

<template>
  <aside ref="panel" class="panel entry-panel">
    <div class="panel-head entry-head">
      <div>
        <p class="kicker">每日一分钟</p>
        <h2 id="formTitle">{{ isEditing ? '修改这笔记录' : '记一笔收益' }}</h2>
      </div>
      <span id="entryDateChip" class="entry-date-chip">{{ entryDateChip }}</span>
    </div>

    <div v-if="showTodayNotice" id="todayNotice" class="today-notice">
      <span>今天已有记录</span>
      <button id="loadTodayButton" type="button" @click="loadToday">载入修改</button>
    </div>

    <form id="recordForm" novalidate @submit.prevent="handleSubmit">
      <div class="field">
        <label for="recordDate">日期</label>
        <input
          id="recordDate"
          v-model="recordDate"
          name="date"
          type="date"
          :min="accountStartDate || ''"
          :max="dashboard.meta.today"
          :readonly="isEditing"
          required
        />
        <p v-if="isBeforeAccountStart" class="date-window-note">
          该日期早于本金起始日 {{ accountStartDate }}，起始日前没有收益属于正常状态，无需补记。
        </p>
      </div>

      <div class="field">
        <label for="dailyPnl">
          当日收益
          <span class="field-help">亏损填负数</span>
        </label>
        <div class="input-affix">
          <span>¥</span>
          <input
            id="dailyPnl"
            ref="dailyPnlInput"
            v-model.number="dailyPnl"
            name="daily_pnl"
            type="number"
            step="0.01"
            inputmode="decimal"
            placeholder="0.00"
            required
          />
        </div>
      </div>

      <div class="rate-preview">
        <span>当日收益率</span>
        <strong id="previewRate" :class="preview.tone">{{ preview.text }}</strong>
      </div>

      <div class="field">
        <label for="action">操作</label>
        <select id="action" v-model="action" name="action">
          <option value="无操作">无操作</option>
          <option value="买入">买入</option>
          <option value="赎回">赎回</option>
          <option value="切换">切换</option>
        </select>
      </div>

      <div class="field">
        <label for="notes">备注</label>
        <textarea
          id="notes"
          v-model="notes"
          name="notes"
          rows="2"
          maxlength="500"
          placeholder="额度、到账、异常或当日判断…"
        ></textarea>
      </div>

      <div class="form-actions">
        <button id="submitButton" class="button button-primary" type="submit" :disabled="saving">
          <span>{{ saving ? '保存中…' : isEditing ? '保存修改' : '保存记录' }}</span>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M4 10h12m0 0-4-4m4 4-4 4" />
          </svg>
        </button>
        <button
          v-if="isEditing"
          id="cancelEdit"
          class="button button-ghost"
          type="button"
          @click="resetForm"
        >
          取消修改
        </button>
      </div>
    </form>
    <p class="form-note">
      本金在“本金管理”中统一维护，收益记录会自动读取该日适用的本金。日收益率 = 当日收益 ÷ 当日本金。
    </p>
  </aside>
</template>

<style scoped>
#recordDate[readonly] {
  opacity: 1;
}

.date-window-note {
  margin: 7px 0 0;
  color: #8f4638;
  font-size: 12px;
  line-height: 1.55;
}

.today-notice {
  margin-bottom: 0;
}
</style>
