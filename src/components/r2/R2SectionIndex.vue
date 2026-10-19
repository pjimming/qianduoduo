<script setup lang="ts">
defineProps<{
  items: Array<{
    id: string
    label: string
    meta?: string
  }>
}>()
</script>

<template>
  <nav class="r2-index" aria-label="页内导航">
    <a v-for="item in items" :key="item.id" class="r2-index-link" :href="`#${item.id}`">
      {{ item.label }}
      <span v-if="item.meta">{{ item.meta }}</span>
    </a>
  </nav>
</template>
