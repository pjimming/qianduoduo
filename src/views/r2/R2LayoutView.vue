<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'

const dashboardStore = useDashboardStore()
const { dashboard } = storeToRefs(dashboardStore)
const { show } = useToast()

const initialLoadDone = ref(false)
const loadError = ref('')

async function loadDashboard(): Promise<void> {
  loadError.value = ''
  try {
    await dashboardStore.load()
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '读取数据失败'
    show(loadError.value, {
      error: true,
      duration: 6000,
    })
  } finally {
    initialLoadDone.value = true
  }
}

onMounted(loadDashboard)
</script>

<template>
  <div v-if="dashboard" class="r2-shell">
    <RouterView v-slot="{ Component }">
      <component :is="Component" :dashboard="dashboard" />
    </RouterView>
  </div>
  <section
    v-else-if="!initialLoadDone || dashboardStore.loading"
    class="dashboard-skeleton"
    aria-live="polite"
    aria-busy="true"
  >
    <div class="skeleton-hero">
      <span class="skeleton-line is-short"></span>
      <span class="skeleton-line is-title"></span>
      <span class="skeleton-line"></span>
    </div>
    <div class="skeleton-grid">
      <span v-for="index in 5" :key="index" class="skeleton-card"></span>
    </div>
    <span class="skeleton-panel"></span>
    <p class="skeleton-caption">正在读取本地账本…</p>
  </section>
  <section v-else class="dashboard-error-state" role="alert">
    <p class="kicker">LOCAL LEDGER</p>
    <h1>账本暂时读不到</h1>
    <p>{{ loadError || '本地服务没有返回数据。' }}</p>
    <p class="dashboard-error-hint">
      请确认服务仍在运行（<code>npm run prod:status</code>），或检查
      <code>data/r2_ledger.sqlite</code> 是否可读。
    </p>
    <button class="button button-primary button-small" type="button" @click="loadDashboard">
      重新加载
    </button>
  </section>
</template>
