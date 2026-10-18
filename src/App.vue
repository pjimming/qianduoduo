<script setup lang="ts">
import { storeToRefs } from 'pinia'
import AppHeader from '@/components/AppHeader.vue'
import ToastBanner from '@/components/ToastBanner.vue'
import { useDashboardStore } from '@/stores/dashboard'

const dashboardStore = useDashboardStore()
const { dashboard } = storeToRefs(dashboardStore)
</script>

<template>
  <div class="paper-glow" aria-hidden="true"></div>
  <div class="app-shell">
    <AppHeader :storage="dashboard?.meta.storage ?? 'SQLite · 本地'" />
    <main>
      <router-view />
    </main>
    <footer class="footer">
      <p>R2 理财不保本，过往收益不代表未来表现。本页只做个人记录与计算，不提供代下单或资金操作。</p>
      <p class="footer-meta">数据保存在本机 <code>data/r2_ledger.sqlite</code> · 可随时导出 CSV</p>
    </footer>
  </div>
  <ToastBanner />
</template>

<style scoped>
.footer {
  position: relative;
}
</style>
