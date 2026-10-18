<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    message: string
    confirmLabel?: string
    cancelLabel?: string
    danger?: boolean
  }>(),
  {
    confirmLabel: '确认',
    cancelLabel: '取消',
    danger: false,
  },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: []
  cancel: []
}>()

const titleId = useId()
const descriptionId = useId()
const dialogRef = ref<HTMLElement | null>(null)
const confirmButton = ref<HTMLButtonElement | null>(null)

function close(): void {
  emit('update:open', false)
  emit('cancel')
}

function confirm(): void {
  emit('confirm')
  emit('update:open', false)
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    close()
    return
  }
  if (event.key !== 'Tab' || !dialogRef.value) return
  const focusable = [
    ...dialogRef.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ]
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      window.addEventListener('keydown', handleKeydown)
      await nextTick()
      confirmButton.value?.focus()
    } else {
      window.removeEventListener('keydown', handleKeydown)
    }
  },
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="confirm-backdrop" @click.self="close">
      <div
        ref="dialogRef"
        class="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="descriptionId"
      >
        <h2 :id="titleId">{{ title }}</h2>
        <p :id="descriptionId">{{ message }}</p>
        <div class="confirm-actions">
          <button class="button button-ghost button-small" type="button" @click="close">
            {{ cancelLabel }}
          </button>
          <button
            ref="confirmButton"
            class="button button-small"
            :class="danger ? 'button-danger' : 'button-primary'"
            type="button"
            @click="confirm"
          >
            {{ confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
