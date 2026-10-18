<script setup lang="ts">
import { useToast } from '@/composables/useToast'

const { toast } = useToast()
</script>

<template>
  <div
    class="toast"
    :class="{ 'is-visible': toast.visible, 'is-error': toast.error }"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    {{ toast.message }}
  </div>
</template>

<style scoped>
.toast {
  pointer-events: none;
}
</style>
