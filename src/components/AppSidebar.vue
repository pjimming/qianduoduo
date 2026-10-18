<script setup lang="ts">
import { RouterLink } from 'vue-router'

defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

function closeMenu(): void {
  emit('close')
}
</script>

<template>
  <aside class="sidebar" :class="{ 'is-open': open }" aria-label="模块导航">
    <div class="sidebar-head">
      <RouterLink class="brand" to="/" aria-label="钱多多首页" @click="closeMenu">
        <span class="brand-mark">钱</span>
        <span class="brand-copy">
          <strong>钱多多</strong>
          <small>个人财富工作台</small>
        </span>
      </RouterLink>
      <button class="sidebar-close" type="button" aria-label="关闭菜单" @click="closeMenu">
        ×
      </button>
    </div>

    <nav class="sidebar-nav" aria-label="主导航">
      <RouterLink
        class="sidebar-link"
        to="/"
        exact-active-class="is-active"
        @click="closeMenu"
      >
        <span class="sidebar-icon">财</span>
        <span class="sidebar-link-copy">
          <strong>理财</strong>
          <small>R2 收益账本</small>
        </span>
      </RouterLink>
      <RouterLink
        class="sidebar-link"
        to="/investment/tech-map"
        active-class="is-active"
        @click="closeMenu"
      >
        <span class="sidebar-icon">投</span>
        <span class="sidebar-link-copy">
          <strong>投资</strong>
          <small>A股科技图谱</small>
        </span>
      </RouterLink>
    </nav>
  </aside>
</template>
