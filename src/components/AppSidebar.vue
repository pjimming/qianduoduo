<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useDashboardStore } from '@/stores/dashboard'

defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

type GroupId = 'wealth' | 'investment'

const STORAGE_KEY = 'qianduoduo:sidebar-groups:v1'
const route = useRoute()
const dashboardStore = useDashboardStore()
const inboxUnread = computed(
  () => dashboardStore.dashboard?.inbox_center.summary.unread_count ?? 0,
)
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
            to="/ledger/overview"
            active-class="is-active"
            @click="closeMenu"
          >
            <span class="sidebar-icon">
              <svg class="nav-icon" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M3.5 3.5h5v5h-5zM11.5 3.5h5v5h-5zM3.5 11.5h5v5h-5zM11.5 11.5h5v5h-5z"></path>
              </svg>
            </span>
            <span class="sidebar-link-copy">
              <strong>收益概览</strong>
              <small>净值 · 收益 · 曲线</small>
            </span>
          </RouterLink>
          <RouterLink
            class="sidebar-link"
            to="/ledger/inbox"
            active-class="is-active"
            @click="closeMenu"
          >
            <span class="sidebar-icon">
              <svg class="nav-icon" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M3.5 5.5h13v9h-13z"></path>
                <path d="m4 6 6 4.5L16 6"></path>
              </svg>
            </span>
            <span class="sidebar-link-copy">
              <strong>消息中心</strong>
              <small>待处理 · 异常 · 提醒</small>
            </span>
            <span
              v-if="inboxUnread > 0"
              class="sidebar-link-badge"
              :aria-label="`${inboxUnread} 条未读消息`"
            >
              {{ inboxUnread > 99 ? '99+' : inboxUnread }}
            </span>
          </RouterLink>
          <RouterLink
            class="sidebar-link"
            to="/ledger/daily"
            active-class="is-active"
            @click="closeMenu"
          >
            <span class="sidebar-icon">
              <svg class="nav-icon" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M5 3.5h10v13l-2.5-1.4L10 16.5l-2.5-1.4L5 16.5z"></path>
                <path d="M7.5 7h5M7.5 9.8h5"></path>
              </svg>
            </span>
            <span class="sidebar-link-copy">
              <strong>每日记账</strong>
              <small>收益 · 本金 · 流水</small>
            </span>
          </RouterLink>
          <RouterLink
            class="sidebar-link"
            to="/ledger/trades"
            active-class="is-active"
            @click="closeMenu"
          >
            <span class="sidebar-icon">
              <svg class="nav-icon" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M4 6.5h11m0 0-3-3m3 3-3 3"></path>
                <path d="M16 13.5H5m0 0 3-3m-3 3 3 3"></path>
              </svg>
            </span>
            <span class="sidebar-link-copy">
              <strong>交易与持仓</strong>
              <small>截图 · 流水 · 单只占比</small>
            </span>
          </RouterLink>
          <RouterLink
            class="sidebar-link"
            to="/ledger/products"
            active-class="is-active"
            @click="closeMenu"
          >
            <span class="sidebar-icon">
              <svg class="nav-icon" viewBox="0 0 20 20" aria-hidden="true">
                <path d="m10 3 6 3-6 3-6-3z"></path>
                <path d="m4 10 6 3 6-3M4 14l6 3 6-3"></path>
              </svg>
            </span>
            <span class="sidebar-link-copy">
              <strong>产品与配置</strong>
              <small>候选池 · 额度 · 事件</small>
            </span>
          </RouterLink>
          <RouterLink
            class="sidebar-link"
            to="/ledger/review"
            active-class="is-active"
            @click="closeMenu"
          >
            <span class="sidebar-icon">
              <svg class="nav-icon" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M4 4.5h12v11H4z"></path>
                <path d="M4 7.5h12M7 3.5v2M13 3.5v2"></path>
                <path d="m7.5 11 1.6 1.6 3.4-3.6"></path>
              </svg>
            </span>
            <span class="sidebar-link-copy">
              <strong>复盘</strong>
              <small>评分 · 五问 · 季度</small>
            </span>
          </RouterLink>
          <RouterLink
            class="sidebar-link"
            to="/ledger/evaluation"
            active-class="is-active"
            @click="closeMenu"
          >
            <span class="sidebar-icon">
              <svg class="nav-icon" viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="10" r="6.5"></circle>
                <path d="m10 6.5 2 2-2 5-2-5z"></path>
              </svg>
            </span>
            <span class="sidebar-link-copy">
              <strong>决策与评估</strong>
              <small>理由 · 结果 · 自动评估</small>
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
