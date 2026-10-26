<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import ReportDocument from '@/components/report/ReportDocument.vue'
import ReportSwitcher from '@/components/report/ReportSwitcher.vue'
import {
  reportBySlug,
  stockReports,
} from '@/data/stockReports'
import type { ReportDoc } from '@/data/reportDocs'

const OUTLINE_KEY = 'qianduoduo:report-outline:v1'

const route = useRoute()
const router = useRouter()
const headings = ref<ReportDoc['headings']>([])
const outlineOpen = ref(window.innerWidth >= 1180)
const activeHeading = ref('')
const progress = ref(0)
let headingObserver: IntersectionObserver | null = null
let scrollFrame = 0

function routeSlug(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' ? raw : ''
}

const currentReport = computed(() => reportBySlug(routeSlug(route.params.slug)))
const currentIndex = computed(() =>
  currentReport.value
    ? stockReports.findIndex((report) => report.slug === currentReport.value?.slug)
    : -1,
)
const previousReport = computed(() => {
  const index = currentIndex.value
  return index > 0 ? stockReports[index - 1] : null
})
const nextReport = computed(() => {
  const index = currentIndex.value
  return index >= 0 && index < stockReports.length - 1 ? stockReports[index + 1] : null
})

watch(
  currentReport,
  (report) => {
    document.title = report
      ? `${report.title} · 钱多多 · 投资`
      : '钱多多 · 投资 · 股票调研报告库'
    if (!report) {
      void router.replace({ name: 'investment-research' })
    }
  },
  { immediate: true },
)

watch(
  () => currentReport.value?.slug,
  () => {
    headings.value = []
    activeHeading.value = ''
  },
)

watch(outlineOpen, (value) => {
  try {
    window.localStorage.setItem(OUTLINE_KEY, value ? '1' : '0')
  } catch {
    // 本地存储不可用时只保留当前会话状态。
  }
})

function setupHeadingObserver(): void {
  headingObserver?.disconnect()
  const elements = headings.value
    .map((item) => document.getElementById(item.id))
    .filter((element): element is HTMLElement => Boolean(element))
  if (!elements.length) return

  headingObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      if (visible[0]) activeHeading.value = visible[0].target.id
    },
    { rootMargin: '-80px 0px -65% 0px', threshold: 0 },
  )
  for (const element of elements) headingObserver.observe(element)
}

function handleReady(doc: ReportDoc): void {
  headings.value = doc.headings
  activeHeading.value = ''
  progress.value = 0

  void nextTick(() => {
    setupHeadingObserver()
    const id = decodeURIComponent(window.location.hash.slice(1))
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' })
  })
}

function updateProgress(): void {
  const y = window.scrollY
  const max = document.documentElement.scrollHeight - window.innerHeight
  progress.value = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0
}

function handleScroll(): void {
  if (scrollFrame) return
  scrollFrame = window.requestAnimationFrame(() => {
    scrollFrame = 0
    updateProgress()
  })
}

function toggleOutline(): void {
  outlineOpen.value = !outlineOpen.value
}

function jumpToHeading(id: string): void {
  const target = document.getElementById(id)
  if (!target) return
  activeHeading.value = id
  if (window.innerWidth <= 1179) outlineOpen.value = false
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}#${id}`,
  )
  target.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function scrollToTop(): void {
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
  const target = event.target as HTMLElement | null
  if (
    target &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  ) {
    return
  }
  if (event.key === 'Escape') {
    outlineOpen.value = false
    return
  }
  if (event.key === 'ArrowLeft' && previousReport.value) {
    event.preventDefault()
    void router.push({
      name: 'investment-report',
      params: { slug: previousReport.value.slug },
    })
  } else if (event.key === 'ArrowRight' && nextReport.value) {
    event.preventDefault()
    void router.push({
      name: 'investment-report',
      params: { slug: nextReport.value.slug },
    })
  }
}

function printReport(): void {
  window.print()
}

onMounted(() => {
  try {
    const saved = window.localStorage.getItem(OUTLINE_KEY)
    if (saved === '1' || saved === '0') outlineOpen.value = saved === '1'
  } catch {
    // 忽略损坏的本地状态。
  }
  window.addEventListener('scroll', handleScroll, { passive: true })
  window.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', handleScroll)
  window.removeEventListener('keydown', handleKeydown)
  if (scrollFrame) window.cancelAnimationFrame(scrollFrame)
  headingObserver?.disconnect()
})
</script>

<template>
  <div
    v-if="currentReport"
    class="report-reader"
    :class="{ 'is-outline-open': outlineOpen && headings.length }"
  >
    <div class="reader-progress" aria-hidden="true">
      <span :style="{ width: `${(progress * 100).toFixed(2)}%` }"></span>
    </div>

    <header class="reader-topbar">
      <div class="reader-topbar-main">
        <RouterLink
          class="reader-back-link"
          :to="{ name: 'investment-research' }"
          title="返回报告库"
        >
          <span aria-hidden="true">←</span>
          <span>报告库</span>
        </RouterLink>

        <ReportSwitcher
          :reports="stockReports"
          :current-slug="currentReport.slug"
        />
      </div>

      <div class="reader-topbar-actions">
        <div class="reader-pager" title="← / → 可切换报告">
          <RouterLink
            v-if="previousReport"
            class="reader-pager-icon"
            :to="{ name: 'investment-report', params: { slug: previousReport.slug } }"
            :title="`上一篇：${previousReport.title}`"
            :aria-label="`上一篇：${previousReport.title}`"
          >
            ‹
          </RouterLink>
          <span v-else class="reader-pager-icon is-disabled" aria-hidden="true">‹</span>
          <span class="reader-pager-position">
            {{ currentIndex + 1 }}/{{ stockReports.length }}
          </span>
          <RouterLink
            v-if="nextReport"
            class="reader-pager-icon"
            :to="{ name: 'investment-report', params: { slug: nextReport.slug } }"
            :title="`下一篇：${nextReport.title}`"
            :aria-label="`下一篇：${nextReport.title}`"
          >
            ›
          </RouterLink>
          <span v-else class="reader-pager-icon is-disabled" aria-hidden="true">›</span>
        </div>

        <button
          class="reader-topbar-button"
          type="button"
          :disabled="!headings.length"
          :aria-expanded="outlineOpen"
          title="显示或收起报告目录"
          @click="toggleOutline"
        >
          <span aria-hidden="true">≡</span>
          <span class="reader-topbar-label">目录</span>
        </button>
        <button class="reader-topbar-button" type="button" title="打印报告" @click="printReport">
          <span aria-hidden="true">⎙</span>
          <span class="reader-topbar-label">打印</span>
        </button>
        <button
          class="reader-topbar-button"
          type="button"
          aria-label="回到顶部"
          title="回到顶部"
          @click="scrollToTop"
        >
          <span aria-hidden="true">↑</span>
        </button>
      </div>
    </header>

    <button
      v-if="outlineOpen && headings.length"
      class="reader-outline-scrim"
      type="button"
      aria-label="关闭报告目录"
      @click="outlineOpen = false"
    ></button>

    <aside
      v-if="outlineOpen && headings.length"
      class="reader-outline-rail"
      aria-label="报告目录"
    >
      <div class="reader-outline-head">
        <strong>报告目录</strong>
        <button type="button" @click="outlineOpen = false">收起</button>
      </div>
      <nav class="reader-outline-list">
        <a
          v-for="item in headings"
          :key="item.id"
          :href="`#${item.id}`"
          :class="[`is-level-${item.level}`, { 'is-active': activeHeading === item.id }]"
          @click.prevent="jumpToHeading(item.id)"
        >
          {{ item.text }}
        </a>
      </nav>
    </aside>

    <div class="reader-body">
      <ReportDocument
        :key="currentReport.slug"
        :slug="currentReport.slug"
        @ready="handleReady"
      />
    </div>
  </div>
</template>
