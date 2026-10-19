<script setup lang="ts">
defineProps<{
  kicker: string
  title: string
  description: string
}>()
</script>

<template>
  <header class="r2-page-head">
    <div class="r2-page-head-copy">
      <p class="kicker">{{ kicker }}</p>
      <h1>{{ title }}</h1>
      <p class="r2-page-desc">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="r2-page-actions">
      <slot name="actions" />
    </div>
  </header>
</template>
