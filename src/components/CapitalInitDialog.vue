<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import type { CapitalState } from '@/types/dashboard'

const props = defineProps<{
  open: boolean
  mode: 'init' | 'edit'
  capital: CapitalState
  today: string
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  saved: []
}>()

const dashboardStore = useDashboardStore()
const { show } = useToast()
const dialogRef = ref<HTMLDialogElement | null>(null)
const amountInput = ref<HTMLInputElement | null>(null)
const initialDate = ref('')
const initialAmount = ref<number | ''>(540000)
const saving = ref(false)
let focusTimer: number | undefined

const editing = computed(() => props.mode === 'edit')
const title = computed(() => (editing.value ? '调整起始本金' : '设定起始本金'))
const hint = computed(() =>
  editing.value
    ? '修改起始本金或日期后，历史收益记录的本金快照会自动重算。'
    : '先确定进入本账本时的 R2 本金，之后资金变化用转入/转出记录。',
)
const note = computed(() =>
  editing.value
    ? '已有转入/转出记录会保留；如果新起始日期晚于已有记录或资金变动，系统会拒绝保存。'
    : '起始本金是进入本账本时的 R2 总本金，不包含累计收益，也不包含组合外应急金。',
)

watch(
  () => props.open,
  async (open) => {
    await nextTick()
    const dialog = dialogRef.value
    if (!dialog) return
    if (open && !dialog.open) {
      initialDate.value = editing.value ? props.capital.initial_date ?? props.today : props.today
      initialAmount.value = editing.value ? props.capital.initial_principal ?? 540000 : 540000
      dialog.showModal()
      window.clearTimeout(focusTimer)
      focusTimer = window.setTimeout(() => amountInput.value?.focus(), 100)
    } else if (!open && dialog.open) {
      dialog.close()
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  window.clearTimeout(focusTimer)
})

function close(): void {
  emit('update:open', false)
}

async function submit(): Promise<void> {
  if (!initialDate.value) {
    show('请选择起始日期', { error: true })
    return
  }
  const amount = Number(initialAmount.value)
  if (!Number.isFinite(amount) || amount <= 0) {
    show('起始本金需要大于 0', { error: true })
    return
  }
  saving.value = true
  try {
    const input = {
      initial_principal: amount,
      initial_date: initialDate.value,
    }
    if (editing.value) {
      await dashboardStore.updateCapital(input)
    } else {
      await dashboardStore.initializeCapital(input)
    }
    emit('saved')
    close()
    show(editing.value ? '起始本金已更新，历史本金快照已重算' : '本金账户已初始化')
  } catch (error) {
    show(error instanceof Error ? error.message : '本金初始化失败', {
      error: true,
      duration: 5000,
    })
  } finally {
    saving.value = false
  }
}

function onClick(event: MouseEvent): void {
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
</script>

<template>
  <dialog ref="dialogRef" class="capital-dialog" @click="onClick" @close="close">
    <form novalidate @submit.prevent="submit">
      <div class="dialog-head">
        <div>
          <p class="kicker">本金账户</p>
          <h2>{{ title }}</h2>
          <p>{{ hint }}</p>
        </div>
        <button class="icon-button" type="button" aria-label="关闭" @click="close">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 5l10 10M15 5 5 15" />
          </svg>
        </button>
      </div>
      <div class="capital-dialog-body">
        <div class="field-row">
          <div class="field">
            <label for="capitalInitDate">起始日期</label>
            <input
              id="capitalInitDate"
              v-model="initialDate"
              type="date"
              :max="today"
              required
            />
          </div>
          <div class="field">
            <label for="capitalInitAmount">起始本金</label>
            <div class="input-affix">
              <span>¥</span>
              <input
                id="capitalInitAmount"
                ref="amountInput"
                v-model.number="initialAmount"
                type="number"
                min="0.01"
                step="0.01"
                inputmode="decimal"
                required
              />
            </div>
          </div>
        </div>
        <p class="capital-dialog-note">{{ note }}</p>
        <div class="capital-dialog-actions">
          <button class="button button-primary" type="submit" :disabled="saving">
            {{ saving ? '保存中…' : editing ? '保存修改' : '完成初始化' }}
          </button>
        </div>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.capital-dialog {
  border: 0;
}

form {
  margin: 0;
}
</style>
