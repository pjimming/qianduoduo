<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import AppSidebar from '@/components/AppSidebar.vue'
import ToastBanner from '@/components/ToastBanner.vue'

const route = useRoute()
const isInvestment = computed(() => route.name === 'investment-tech-map')
const sidebarOpen = ref(false)

watch(
  () => route.fullPath,
  () => {
    sidebarOpen.value = false
  },
)
</script>

<template>
  <div class="paper-glow" aria-hidden="true"></div>
  <div class="app-layout">
    <AppSidebar :open="sidebarOpen" @close="sidebarOpen = false" />
    <button
      v-if="sidebarOpen"
      class="sidebar-scrim"
      type="button"
      aria-label="关闭菜单"
      @click="sidebarOpen = false"
    ></button>

    <div class="app-main" :class="{ 'is-research-main': isInvestment }">
      <header class="mobile-topbar">
        <button
          class="mobile-menu-button"
          type="button"
          aria-label="打开左侧菜单"
          @click="sidebarOpen = true"
        >
          <span></span>
          <span></span>
          <span></span>
        </button>
        <RouterLink class="mobile-brand" to="/">
          <span class="mobile-brand-mark">钱</span>
          <strong>钱多多</strong>
        </RouterLink>
        <span class="mobile-module">{{ isInvestment ? '投资' : '理财' }}</span>
      </header>

      <main :class="{ 'research-main': isInvestment }">
        <router-view />
      </main>

      <footer v-if="!isInvestment" class="footer">
        <p>钱多多只做个人记录与计算，不提供代下单或资金操作。R2 理财不保本，过往收益不代表未来表现。</p>
        <p class="footer-meta">数据保存在本机 <code>data/r2_ledger.sqlite</code> · 可随时导出 CSV</p>
      </footer>
      <footer v-else class="footer research-footer">
        <p>投资资料不代表当前行情，不构成投资建议；该模块不进入 R2 收益账本、产品池排序或选品结论。</p>
        <p class="footer-meta">A股科技全景图 · 数据快照 2026-09-16</p>
      </footer>
    </div>
  </div>
  <ToastBanner />
</template>

<style scoped>
.footer {
  position: relative;
}
</style>
