<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

type GroupId = 'wealth' | 'investment'

const STORAGE_KEY = 'qianduoduo:sidebar-groups:v1'
const route = useRoute()
const groupOpen = ref<Record<GroupId, boolean>>({
  wealth: true,
  investment: true,
})

const activeGroup = computed<GroupId>(() =>
  route.meta.module === 'investment' ? 'investment' : 'wealth',
)

function closeMenu(): void {
  emit('close')
}

function persistGroups(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(groupOpen.value))
  } catch {
    // 本地存储不可用时仅保留当前会话状态。
  }
}

function toggleGroup(group: GroupId): void {
  groupOpen.value[group] = !groupOpen.value[group]
  persistGroups()
}

function openActiveGroup(): void {
  if (groupOpen.value[activeGroup.value]) return
  groupOpen.value[activeGroup.value] = true
  persistGroups()
}

onMounted(() => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Record<GroupId, boolean>>
      groupOpen.value.wealth = saved.wealth !== false
      groupOpen.value.investment = saved.investment !== false
    }
  } catch {
    // 忽略损坏的本地状态，使用默认展开。
  }
  openActiveGroup()
})

watch(
  () => route.fullPath,
  () => {
    openActiveGroup()
  },
)
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
      <section
        class="nav-group"
        :class="{ 'is-collapsed': !groupOpen.wealth }"
      >
        <button
          class="nav-group-toggle"
          :class="{ 'is-active': activeGroup === 'wealth' }"
          type="button"
          :aria-expanded="groupOpen.wealth"
          aria-controls="nav-group-wealth"
          @click="toggleGroup('wealth')"
        >
          <span class="nav-group-icon">
            <svg class="nav-icon" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3.5 6.5h13v9h-13z"></path>
              <path d="M3.5 6.5V5A1.5 1.5 0 0 1 5 3.5h9.5v3"></path>
              <path d="M12.5 11h4"></path>
            </svg>
          </span>
          <span class="nav-group-copy">
            <span class="nav-group-head">
              <strong>理财</strong>
              <span class="nav-group-en">WEALTH</span>
            </span>
            <small>现金管理与复盘</small>
          </span>
          <span class="nav-group-chevron" aria-hidden="true">⌄</span>
        </button>
        <div
          v-show="groupOpen.wealth"
          id="nav-group-wealth"
          class="nav-group-items"
        >
          <RouterLink
            class="sidebar-link"
            to="/"
            exact-active-class="is-active"
            @click="closeMenu"
          >
            <span class="sidebar-icon">
              <svg class="nav-icon" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M5 3.5h10v13l-2.5-1.4L10 16.5l-2.5-1.4L5 16.5z"></path>
                <path d="M7.5 7h5M7.5 9.8h5"></path>
              </svg>
            </span>
            <span class="sidebar-link-copy">
              <strong>R2 收益账本</strong>
              <small>本金 · 收益 · 月度复盘</small>
            </span>
          </RouterLink>
        </div>
      </section>

      <section
        class="nav-group"
        :class="{ 'is-collapsed': !groupOpen.investment }"
      >
        <button
          class="nav-group-toggle"
          :class="{ 'is-active': activeGroup === 'investment' }"
          type="button"
          :aria-expanded="groupOpen.investment"
          aria-controls="nav-group-investment"
          @click="toggleGroup('investment')"
        >
          <span class="nav-group-icon">
            <svg class="nav-icon" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3.5 15.5 8 11l3 2.5 5-6"></path>
              <path d="M12.5 7.5H16v3.5"></path>
            </svg>
          </span>
          <span class="nav-group-copy">
            <span class="nav-group-head">
              <strong>投资</strong>
              <span class="nav-group-en">INVEST</span>
            </span>
            <small>产业链与公司研究</small>
          </span>
          <span class="nav-group-chevron" aria-hidden="true">⌄</span>
        </button>
        <div
          v-show="groupOpen.investment"
          id="nav-group-investment"
          class="nav-group-items"
        >
          <RouterLink
            class="sidebar-link"
            to="/investment/tech-map"
            active-class="is-active"
            @click="closeMenu"
          >
            <span class="sidebar-icon">
              <svg class="nav-icon" viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="4.5" r="1.6"></circle>
                <circle cx="4.8" cy="14.8" r="1.6"></circle>
                <circle cx="15.2" cy="14.8" r="1.6"></circle>
                <path d="M9.1 5.9 5.7 13.4M10.9 5.9l3.4 7.5M6.4 14.8h7.2"></path>
              </svg>
            </span>
            <span class="sidebar-link-copy">
              <strong>科技全景图</strong>
              <small>A股产业链分层地图</small>
            </span>
          </RouterLink>
          <RouterLink
            class="sidebar-link"
            to="/investment/research"
            active-class="is-active"
            @click="closeMenu"
          >
            <span class="sidebar-icon">
              <svg class="nav-icon" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M5 3.5h7l3 3v10H5z"></path>
                <path d="M12 3.5v3h3"></path>
                <path d="M7.5 10h5M7.5 12.5h3.8"></path>
              </svg>
            </span>
            <span class="sidebar-link-copy">
              <strong>调研报告</strong>
              <small>个股 · 产业链 · 板块</small>
            </span>
          </RouterLink>
        </div>
      </section>
    </nav>
  </aside>
</template>
