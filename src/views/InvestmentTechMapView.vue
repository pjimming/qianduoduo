<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import TechMapCanvas from '@/components/techmap/TechMapCanvas.vue'
import TechMapTable from '@/components/techmap/TechMapTable.vue'
import TechMapTree from '@/components/techmap/TechMapTree.vue'
import { techMap, techMapStats } from '@/data/techmap'
import { reportCoveredCompanyCount } from '@/data/techMapReports'
import '@/styles/techmap.css'

type TechMapView = 'canvas' | 'tree' | 'table'

interface ViewOption {
  id: TechMapView
  label: string
  caption: string
}

interface TechMapViewApi {
  preparePrint?: () => void | Promise<void>
  restoreAfterPrint?: () => void
}

const views: ViewOption[] = [
  { id: 'canvas', label: '脑图', caption: '缩放与拖拽' },
  { id: 'tree', label: '树状', caption: '逐级展开' },
  { id: 'table', label: '表格', caption: '搜索与打印' },
]

const route = useRoute()
const router = useRouter()
const stageRef = ref<HTMLElement | null>(null)
const activeViewRef = ref<TechMapViewApi | null>(null)
const isFullscreen = ref(false)
const pseudoFullscreen = ref(false)
const activeView = computed<TechMapView>(() => {
  const value = Array.isArray(route.query.view) ? route.query.view[0] : route.query.view
  return views.some((item) => item.id === value) ? (value as TechMapView) : 'canvas'
})

const currentComponent = computed(() => {
  if (activeView.value === 'tree') return TechMapTree
  if (activeView.value === 'table') return TechMapTable
  return TechMapCanvas
})

const fullscreenActive = computed(() => isFullscreen.value || pseudoFullscreen.value)
const summaryText = computed(
  () =>
    `${techMapStats.groups} 门类 · ${techMapStats.subs} 子行业 · ` +
    `${techMapStats.leaves} 方向 · ${techMapStats.companies} 公司 · ` +
    `${techMap.date} 快照 · ${reportCoveredCompanyCount} 家有调研`,
)

function selectView(view: TechMapView): void {
  if (view === activeView.value) return
  void router.replace({
    name: 'investment-tech-map',
    query: { ...route.query, view },
  })
}

function setViewRef(instance: unknown): void {
  activeViewRef.value = (instance as TechMapViewApi | null) ?? null
}

async function printView(): Promise<void> {
  const view = activeViewRef.value
  await view?.preparePrint?.()
  await nextTick()
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))
  })
  window.print()
  view?.restoreAfterPrint?.()
}

async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen()
    return
  }
  if (pseudoFullscreen.value) {
    pseudoFullscreen.value = false
    return
  }
  const stage = stageRef.value
  if (!stage) return
  try {
    if (!stage.requestFullscreen) throw new Error('Fullscreen API unavailable')
    await stage.requestFullscreen()
  } catch {
    pseudoFullscreen.value = true
  }
}

function handleFullscreenChange(): void {
  isFullscreen.value = document.fullscreenElement === stageRef.value
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && pseudoFullscreen.value) pseudoFullscreen.value = false
}

watch(
  () => route.query.view,
  () => {
    activeViewRef.value = null
  },
)

onMounted(() => {
  document.title = '钱多多 · 投资 · A股科技全景图'
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  window.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
  window.removeEventListener('keydown', handleKeydown)
  if (document.fullscreenElement === stageRef.value) void document.exitFullscreen()
})
</script>

<template>
  <section class="research-page">
    <header class="research-head">
      <div class="research-heading">
        <p class="research-kicker">INVESTMENT LIBRARY · 非 R2 理财产品</p>
        <h1>A股科技<span>全景图</span></h1>
        <p class="research-lede">
          门类 → 子行业 → 细分方向 → 代表公司
          <span class="research-summary" :title="summaryText">
            {{ summaryText }}
          </span>
        </p>
      </div>

      <div class="research-toolbar">
        <div class="research-tabs" role="tablist" aria-label="科技图谱版本">
          <button
            v-for="option in views"
            :key="option.id"
            class="research-tab"
            :class="{ 'is-active': option.id === activeView }"
            type="button"
            role="tab"
            :aria-selected="option.id === activeView"
            @click="selectView(option.id)"
          >
            <strong>{{ option.label }}</strong>
            <small>{{ option.caption }}</small>
          </button>
        </div>
        <div class="research-actions">
          <RouterLink
            class="button button-ghost button-small"
            :to="{ name: 'investment-research' }"
          >
            调研报告库
          </RouterLink>
          <button class="button button-ghost button-small" type="button" @click="printView">
            打印当前视图
          </button>
          <button class="button button-ghost button-small" type="button" @click="toggleFullscreen">
            {{ fullscreenActive ? '退出全屏' : '全屏查看' }}
          </button>
        </div>
      </div>
    </header>

    <div ref="stageRef" class="research-stage" :class="{ 'is-fullscreen': fullscreenActive }">
      <component :is="currentComponent" :key="activeView" :ref="setViewRef" />
      <button
        v-if="fullscreenActive"
        class="research-fullscreen-exit"
        type="button"
        @click="toggleFullscreen"
      >
        退出全屏
      </button>
    </div>

    <p class="research-footnote">
      数据快照 {{ techMap.date }} · 原生 Vue 视图，无 iframe 与外部接口请求 · 涉及个股请以最新公告与定期报告为准
    </p>
  </section>
</template>
