<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { loadReportDoc, type ReportDoc } from '@/data/reportDocs'

const props = defineProps<{
  slug: string
}>()

const emit = defineEmits<{
  ready: [doc: ReportDoc]
  failed: [message: string]
}>()

const doc = shallowRef<ReportDoc | null>(null)
const failure = ref('')
let styleElement: HTMLStyleElement | null = null
let requestId = 0

function removeStyle(): void {
  styleElement?.remove()
  styleElement = null
}

function mountStyle(slug: string, css: string): void {
  removeStyle()
  const style = document.createElement('style')
  style.dataset.reportDoc = slug
  style.textContent = css
  document.head.append(style)
  styleElement = style
}

watch(
  () => props.slug,
  async (slug) => {
    const id = ++requestId
    removeStyle()
    doc.value = null
    failure.value = ''

    const pending = loadReportDoc(slug)
    if (!pending) {
      failure.value = '没有找到这篇报告的 Vue 文档。请重新执行 npm run research:publish。'
      emit('failed', failure.value)
      return
    }

    try {
      const loaded = await pending
      if (id !== requestId) return
      // 先挂样式再渲染正文，避免正文以工作台字体闪一下。
      mountStyle(slug, loaded.css)
      doc.value = loaded
      emit('ready', loaded)
    } catch (error) {
      if (id !== requestId) return
      failure.value = `报告内容加载失败：${error instanceof Error ? error.message : String(error)}`
      emit('failed', failure.value)
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  requestId += 1
  removeStyle()
})
</script>

<template>
  <div v-if="failure" class="report-doc-error" role="alert">
    <strong>报告暂时无法显示</strong>
    <p>{{ failure }}</p>
  </div>
  <div v-else-if="!doc" class="report-doc-loading" aria-live="polite">
    <span class="report-doc-spinner" aria-hidden="true"></span>
    正在加载报告…
  </div>
  <article
    v-else
    class="rp-doc"
    :class="doc.bodyClass"
    :lang="doc.lang"
    :data-report-slug="doc.slug"
    v-html="doc.html"
  ></article>
</template>
