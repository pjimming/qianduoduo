<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

interface SectionItem {
  id: string
  label: string
  meta?: string
}

const props = defineProps<{
  items: SectionItem[]
  sticky?: boolean
}>()

const activeId = ref(props.items[0]?.id ?? '')
let observer: IntersectionObserver | null = null

function syncHash(): void {
  const id = window.location.hash.slice(1)
  if (props.items.some((item) => item.id === id)) {
    activeId.value = id
  }
}

function observeSections(): void {
  observer?.disconnect()
  if (typeof IntersectionObserver === 'undefined') return

  observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      const first = visible[0]
      if (first) activeId.value = first.target.id
    },
    { rootMargin: '-96px 0px -58% 0px', threshold: 0 },
  )

  for (const item of props.items) {
    const element = document.getElementById(item.id)
    if (element) observer.observe(element)
  }
}

function select(id: string): void {
  activeId.value = id
}

function scrollToInitialHash(): void {
  let id = ''
  try {
    id = decodeURIComponent(window.location.hash.slice(1))
  } catch {
    return
  }
  if (!id || !props.items.some((item) => item.id === id)) return

  activeId.value = id
  nextTick(() => {
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start' })
    })
  })
}

onMounted(() => {
  syncHash()
  scrollToInitialHash()
  observeSections()
  window.addEventListener('hashchange', syncHash)
})

watch(
  () => props.items.map((item) => item.id).join('|'),
  () => observeSections(),
  { flush: 'post' },
)

onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('hashchange', syncHash)
})
</script>

<template>
  <nav
    class="r2-view-switch r2-section-switch"
    :class="{ 'is-sticky': sticky }"
    aria-label="页内导航"
  >
    <a
      v-for="item in items"
      :key="item.id"
      class="r2-index-link"
      :href="`#${item.id}`"
      :data-section="item.id"
      :aria-current="activeId === item.id ? 'location' : undefined"
      @click="select(item.id)"
    >
      {{ item.label }}
      <span v-if="item.meta">{{ item.meta }}</span>
    </a>
  </nav>
</template>
