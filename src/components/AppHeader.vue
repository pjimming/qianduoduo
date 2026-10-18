<script setup lang="ts">
import { RouterLink } from 'vue-router'

defineProps<{
  storage: string
}>()
</script>

<template>
  <header class="topbar">
    <RouterLink class="brand" to="/" aria-label="R2 收益账本首页">
      <span class="brand-mark">R2</span>
      <span class="brand-copy">
        <strong>收益账本</strong>
        <small>DAILY WEALTH LEDGER</small>
      </span>
    </RouterLink>
    <div class="topbar-actions">
      <span class="local-pill"><span class="status-dot"></span>{{ storage }}</span>
      <a class="button button-ghost button-small" href="/api/export.csv">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 2v10m0 0 4-4m-4 4L6 8M4 14v3h12v-3" />
        </svg>
        导出 CSV
      </a>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  position: relative;
}
</style>
