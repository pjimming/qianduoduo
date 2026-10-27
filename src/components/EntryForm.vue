<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import { formatDateShort, formatPct } from '@/composables/useFormatters'
import type {
  DashboardPayload,
  LedgerAction,
  LedgerRecord,
  ProductValuationReconciliationItem,
} from '@/types/dashboard'

const props = defineProps<{
  dashboard: DashboardPayload
  compact?: boolean
}>()

const emit = defineEmits<{
  saved: [date: string]
}>()

const dashboardStore = useDashboardStore()
const { show } = useToast()

const formMode = ref<'create' | 'edit'>('create')
const editingDate = ref<string | null>(null)
const reportingDate = computed(
  () => props.dashboard.meta.reporting_date || props.dashboard.meta.today,
)
const today = computed(() => props.dashboard.meta.today)
const recordDate = ref(reportingDate.value)
const action = ref<LedgerAction>('无操作')
const notes = ref('')
const saving = ref(false)
const panel = ref<HTMLElement | null>(null)
const actionInput = ref<HTMLSelectElement | null>(null)
let focusTimer: number | undefined

const isEditing = computed(() => formMode.value === 'edit')
const principal = computed(() => dashboardStore.principalForDate(recordDate.value))
const currentRecord = computed(() =>
  dashboardStore.recordByDate(recordDate.value),
)
const dailyReconciliation = computed<
  ProductValuationReconciliationItem | null
>(() =>
  props.dashboard.workspace.product_valuation_reconciliation.items.find(
    (item) => item.account_date === recordDate.value,
  ) ?? null,
)
const isLegacyManualRecord = computed(
  () =>
    Boolean(currentRecord.value) &&
    currentRecord.value?.source !== 'product-income-summary' &&
    !(dailyReconciliation.value?.product_count ?? 0),
)
const derivedDailyPnl = computed<number | null>(() => {
  if (isLegacyManualRecord.value) return null
  const amount =
    currentRecord.value?.daily_pnl ?? dailyReconciliation.value?.product_pnl
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : null
})
const derivedProductCount = computed(
  () => dailyReconciliation.value?.product_count ?? null,
)
const derivedCoverageText = computed(() => {
  if (isLegacyManualRecord.value) {
    return `历史手工口径 ¥${currentRecord.value?.daily_pnl.toFixed(
      2,
    )}；需补录对应产品明细后才会进入派生总账`
  }
  const item = dailyReconciliation.value
  if (!item) return '尚未发现该日产品收益事实'
  if (item.status === 'waiting') {
    return `已汇总 ${item.product_count} / ${item.expected_product_count} 只产品；其余产品到账后自动重算`
  }
  if (item.status === 'missing-product-details') {
    return `已汇总 ${item.product_count} / ${item.expected_product_count} 只产品；仍缺 ${item.missing_product_codes.join('、')}`
  }
  return `已汇总 ${item.product_count} 只产品`
})
const accountStartDate = computed(() => props.dashboard.capital.initial_date ?? null)
const hasReportableDay = computed(
  () =>
    !accountStartDate.value ||
    today.value >= (accountStartDate.value as string),
)
const isBeforeAccountStart = computed(
  () =>
    Boolean(accountStartDate.value && recordDate.value) &&
    recordDate.value < (accountStartDate.value as string),
)
const showTodayNotice = computed(
  () =>
    props.dashboard.meta.has_reporting_record &&
    editingDate.value !== reportingDate.value,
)
const reportingDayLabel = computed(() =>
  reportingDate.value === props.dashboard.meta.today
    ? '今日'
    : formatDateShort(reportingDate.value),
)
const entryDateChip = computed(() =>
  recordDate.value === reportingDate.value
    ? reportingDayLabel.value
    : formatDateShort(recordDate.value),
)

const preview = computed(() => {
  const currentPrincipal = principal.value
  const pnl = derivedDailyPnl.value
  if (
    currentPrincipal === null ||
    currentPrincipal <= 0 ||
    pnl === null ||
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
  () =>
    [
      accountStartDate.value,
      props.dashboard.meta.today,
      reportingDate.value,
    ] as const,
  () => {
    if (!isEditing.value && isBeforeAccountStart.value) {
      recordDate.value = reportingDate.value
    }
  },
)

function applyRecord(record: LedgerRecord): void {
  editingDate.value = record.date
  formMode.value = 'edit'
  recordDate.value = record.date
  action.value = record.action
  notes.value = record.notes
}

function resetForm(): void {
  editingDate.value = null
  formMode.value = 'create'
  recordDate.value = reportingDate.value
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
  focusTimer = window.setTimeout(() => actionInput.value?.focus(), 380)
}

function loadReportingRecord(): void {
  loadRecordForEdit(reportingDate.value)
}

function startRecord(date: string): void {
  if (!date) return
  if (date > today.value) {
    show('不能记录未来日期的收益', {
      error: true,
    })
    return
  }
  if (accountStartDate.value && date < accountStartDate.value) {
    show(`该日期早于本金起始日 ${accountStartDate.value}，不纳入收益账本`, {
      error: true,
    })
    return
  }
  editingDate.value = null
  formMode.value = 'create'
  recordDate.value = date
  action.value = '无操作'
  notes.value = ''
  panel.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  window.clearTimeout(focusTimer)
  focusTimer = window.setTimeout(() => actionInput.value?.focus(), 380)
}

async function handleSubmit(): Promise<void> {
  if (!recordDate.value) {
    show('请选择日期', { error: true })
    return
  }
  if (!hasReportableDay.value) {
    show(`收益尚未披露到本金起始日 ${accountStartDate.value}`, { error: true })
    return
  }
  if (recordDate.value > today.value) {
    show('不能记录未来日期的收益', {
      error: true,
    })
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
  if (derivedDailyPnl.value === null) {
    show('该日期尚无产品收益明细，请先上传收益截图或补录产品收益', {
      error: true,
    })
    return
  }
  saving.value = true
  try {
    const input = {
      date: recordDate.value,
      daily_pnl: derivedDailyPnl.value,
      action: action.value,
      notes: notes.value.trim(),
    }
    const isEdit = Boolean(editingDate.value)
    const response = isEdit
      ? await dashboardStore.updateRecord(editingDate.value as string, input)
      : await dashboardStore.createRecord(input)
    applyRecord(response.record)
    emit('saved', response.record.date)
    show(
      isEdit
        ? '操作与备注已更新；收益仍按产品明细汇总'
        : response.conflict
          ? `${response.conflict.date} 已有收益 ¥${response.conflict.existing_daily_pnl.toFixed(
              2,
            )}，本次 ¥${response.conflict.incoming_daily_pnl.toFixed(
              2,
            )}；未覆盖，已生成人工确认提醒`
          : response.duplicate
            ? '账户收益已按产品明细汇总，本次未重复记账'
            : '账户收益已按产品明细汇总',
      response.conflict ? { error: true, duration: 8000 } : undefined,
    )
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

onMounted(() => {
  const record = dashboardStore.recordByDate(reportingDate.value)
  if (record) applyRecord(record)
})

defineExpose({
  loadRecordForEdit,
  startRecord,
  resetForm,
  isEditingDate: (date: string): boolean => editingDate.value === date,
})
</script>

<template>
  <aside ref="panel" class="panel entry-panel" :class="{ 'is-compact': compact }">
    <div class="panel-head entry-head">
      <div>
        <p class="kicker">{{ compact ? '每日收益' : '每日一分钟' }}</p>
        <h2 id="formTitle">
          {{
            isEditing
              ? '修改这笔记录'
              : compact
                ? `${reportingDayLabel}赚了多少`
                : '记一笔收益'
          }}
        </h2>
      </div>
      <span id="entryDateChip" class="entry-date-chip">{{ entryDateChip }}</span>
    </div>

    <div v-if="showTodayNotice" id="todayNotice" class="today-notice">
      <span>{{ reportingDayLabel }}已有记录</span>
      <button id="loadTodayButton" type="button" @click="loadReportingRecord">
        载入修改
      </button>
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
          :max="today"
          :disabled="!hasReportableDay"
          :readonly="isEditing"
          required
        />
        <p class="date-window-note is-reporting">
          收益日期由产品明细提供；账户总收益按该日产品收益自动汇总，未来日期不能记录。
        </p>
        <p v-if="isBeforeAccountStart" class="date-window-note">
          该日期早于本金起始日 {{ accountStartDate }}，起始日前没有收益属于正常状态，无需补记。
        </p>
        <p v-if="!hasReportableDay" class="date-window-note">
          本金自 {{ accountStartDate }} 起算，收益将在下一个披露日纳入账本。
        </p>
      </div>

      <div class="field">
        <label for="dailyPnl">
          账户当日收益
          <span class="field-help">由产品明细自动汇总</span>
        </label>
        <div class="input-affix">
          <span>¥</span>
          <input
            id="dailyPnl"
            name="daily_pnl"
            type="text"
            :value="
              isLegacyManualRecord
                ? '待补产品明细'
                : derivedDailyPnl === null
                ? '等待产品收益'
                : derivedDailyPnl.toFixed(2)
            "
            readonly
            aria-readonly="true"
          />
        </div>
        <p class="date-window-note is-reporting">
          {{ derivedCoverageText }}
          <template v-if="derivedProductCount !== null && !isLegacyManualRecord">
            · 账户总账来源：逐产品收益
          </template>
        </p>
      </div>

      <div class="rate-preview">
        <span>当日收益率</span>
        <strong id="previewRate" :class="preview.tone">{{ preview.text }}</strong>
      </div>

      <div class="field">
        <label for="action">操作</label>
        <select id="action" ref="actionInput" v-model="action" name="action">
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
          :rows="compact ? 3 : 2"
          maxlength="500"
          placeholder="额度、到账、异常或当日判断…"
        ></textarea>
      </div>

      <div class="form-actions">
        <button
          id="submitButton"
          class="button button-primary"
          type="submit"
          :disabled="
            saving ||
            !hasReportableDay ||
            derivedDailyPnl === null ||
            isBeforeAccountStart
          "
        >
          <span>{{ saving ? '保存中…' : '保存操作与备注' }}</span>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M4 10h12m0 0-4-4m4 4-4 4" />
          </svg>
        </button>
        <button
          v-if="isEditing && !compact"
          id="cancelEdit"
          class="button button-ghost"
          type="button"
          @click="resetForm"
        >
          取消修改
        </button>
      </div>
    </form>
    <p v-if="!compact" class="form-note">
      本金在“本金管理”中统一维护；日收益率 = 当日收益 ÷ 当日已确认持仓金额。
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

.date-window-note.is-reporting {
  color: var(--muted);
}

.today-notice {
  margin-bottom: 0;
}
</style>
