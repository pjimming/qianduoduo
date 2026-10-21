<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const VISIBILITY_THRESHOLD = 360
const visible = ref(false)
let scrollFrame = 0

function syncVisibility(): void {
  visible.value = window.scrollY > VISIBILITY_THRESHOLD
}

function scheduleVisibilitySync(): void {
  if (scrollFrame) return
  scrollFrame = window.requestAnimationFrame(() => {
    scrollFrame = 0
    syncVisibility()
  })
}

function scrollToTop(): void {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  window.scrollTo({
    top: 0,
    behavior: reduceMotion ? 'auto' : 'smooth',
  })
}

onMounted(() => {
  syncVisibility()
  window.addEventListener('scroll', scheduleVisibilitySync, { passive: true })
  window.addEventListener('resize', scheduleVisibilitySync)
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', scheduleVisibilitySync)
  window.removeEventListener('resize', scheduleVisibilitySync)
  if (scrollFrame) window.cancelAnimationFrame(scrollFrame)
})
</script>

<template>
  <Transition name="back-to-top">
    <button
      v-if="visible"
      class="back-to-top"
      type="button"
      aria-label="回到页面顶部"
      title="回到顶部"
      @click="scrollToTop"
    >
      <span aria-hidden="true">↑</span>
    </button>
  </Transition>
</template>

<style scoped>
.back-to-top {
  position: fixed;
  right: max(24px, env(safe-area-inset-right));
  bottom: max(24px, env(safe-area-inset-bottom));
  z-index: 39;
  display: grid;
  width: 48px;
  height: 48px;
  padding: 0;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 50%;
  background: var(--green-deep);
  color: #fffaf0;
  box-shadow:
    0 12px 28px rgba(23, 64, 55, 0.24),
    inset 0 1px 0 rgba(255, 255, 255, 0.12);
  cursor: pointer;
  font-family: var(--sans);
  font-size: 21px;
  font-weight: 650;
  line-height: 1;
  transition:
    transform 160ms ease,
    background 160ms ease,
    box-shadow 160ms ease;
}

.back-to-top:hover {
  background: var(--green);
  box-shadow:
    0 15px 32px rgba(23, 64, 55, 0.28),
    inset 0 1px 0 rgba(255, 255, 255, 0.16);
  transform: translateY(-2px);
}

.back-to-top:focus-visible {
  outline: 3px solid rgba(23, 100, 86, 0.28);
  outline-offset: 3px;
}

.back-to-top:active {
  transform: translateY(0);
}

.back-to-top-enter-active,
.back-to-top-leave-active {
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}

.back-to-top-enter-from,
.back-to-top-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.92);
}

@media (max-width: 820px) {
  .back-to-top {
    right: max(16px, env(safe-area-inset-right));
    bottom: max(16px, env(safe-area-inset-bottom));
    width: 44px;
    height: 44px;
    font-size: 19px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .back-to-top,
  .back-to-top-enter-active,
  .back-to-top-leave-active {
    transition: none;
  }
}
</style>
