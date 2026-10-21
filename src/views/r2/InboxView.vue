<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import { formatDateShort } from '@/composables/useFormatters'
import type {
  DashboardPayload,
  InboxItem,
  InboxSeverity,
} from '@/types/dashboard'

type InboxFilter = 'pending' | 'reminders' | 'handled'
const tabs: Array<{ key: InboxFilter; label: string }> = [
  { key: 'pending', label: '待处理' },
  { key: 'reminders', label: '提醒' },
  { key: 'handled', label: '已处理' },
]

const props = defineProps<{
  dashboard: DashboardPayload
}>()

const router = useRouter()
const store = useDashboardStore()
const { show } = useToast()

const filter = ref<InboxFilter>('pending')
const keyword = ref('')
const busyId = ref<number | null>(null)
const markingAll = ref(false)

const center = computed(() => props.dashboard.inbox_center)
const summary = computed(() => center.value.summary)

const filterCounts = computed(() => ({
  pending: summary.value.pending_count,
  reminders: summary.value.reminder_count,
  handled: summary.value.handled_count,
}))

const sourceItems = computed(() => {
  if (filter.value === 'handled') return center.value.handled
  if (filter.value === 'reminders') return center.value.reminders
  return center.value.pending
})

const visibleItems = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  if (!query) return sourceItems.value
  return sourceItems.value.filter((item) =>
    [item.title, item.summary, item.source_label, item.action_label]
      .join(' ')
      .toLowerCase()
      .includes(query),
  )
})

const groups = computed(() => {
  const grouped = new Map<string, InboxItem[]>()
  for (const item of visibleItems.value) {
    const list = grouped.get(item.source_label) || []
    list.push(item)
    grouped.set(item.source_label, list)
  }
  return [...grouped.entries()].map(([label, items]) => ({
    label,
    items,
    unread: items.filter((item) => !item.read_at).length,
  }))
})

const tomorrow = computed(() => {
  const stamp = Date.parse(`${props.dashboard.meta.today}T00:00:00Z`)
  return new Date(stamp + 86400000).toISOString().slice(0, 10)
})

function severityLabel(item: InboxItem): string {
  const labels: Record<InboxSeverity, string> = {
    urgent: '紧急',
    warn: '需核对',
    info: '提醒',
  }
  return labels[item.severity]
}

async function openItem(item: InboxItem): Promise<void> {
  busyId.value = item.id
  try {
    if (!item.read_at) await store.markInboxItem(item.id, 'read')
    if (item.action_url) {
      await router.push(item.action_url)
    }
  } catch (error) {
    show(error instanceof Error ? error.message : '打开消息失败', { error: true })
  } finally {
    busyId.value = null
  }
}

async function markUnread(item: InboxItem): Promise<void> {
  busyId.value = item.id
  try {
    await store.markInboxItem(item.id, item.read_at ? 'unread' : 'read')
  } catch (error) {
    show(error instanceof Error ? error.message : '更新消息失败', { error: true })
  } finally {
    busyId.value = null
  }
}

async function snooze(item: InboxItem): Promise<void> {
  busyId.value = item.id
  try {
    await store.markInboxItem(
      item.id,
      item.status === 'snoozed' ? 'unsnooze' : 'snooze',
      item.status === 'snoozed' ? {} : { until: tomorrow.value },
    )
    show(item.status === 'snoozed' ? '已恢复提醒' : '已改为明天提醒')
  } catch (error) {
    show(error instanceof Error ? error.message : '更新提醒失败', { error: true })
  } finally {
    busyId.value = null
  }
}

async function markAllRead(): Promise<void> {
  markingAll.value = true
  try {
    await store.markAllInboxRead()
    show('消息已全部标记为已读')
  } catch (error) {
    show(error instanceof Error ? error.message : '更新失败', { error: true })
  } finally {
    markingAll.value = false
  }
}

async function adoptProposal(item: InboxItem): Promise<void> {
  const proposalId = Number(item.metadata.proposal_id);
  if (!proposalId) return
  busyId.value = item.id
  try {
    const result = await store.adoptDecisionProposal(proposalId)
    show(
      `提案已采纳，决策 #${result.result.decision?.id ?? ''} 进入待执行状态。请自行完成交易后上传截图。`,
      { duration: 8000 },
    )
  } catch (error) {
    show(error instanceof Error ? error.message : '采纳提案失败', { error: true })
  } finally {
    busyId.value = null
  }
}

async function rejectProposal(item: InboxItem): Promise<void> {
  const proposalId = Number(item.metadata.proposal_id)
  if (!proposalId) return
  const reason =
    window.prompt(
      `${
        item.metadata.proposal_status === 'accepted' ? '取消采纳' : '拒绝'
      }原因（可留空）`,
      '当前不接受该收益、期限或流动性取舍。',
    ) ??
    ''
  busyId.value = item.id
  try {
    await store.rejectDecisionProposal(proposalId, reason)
    show('提案已拒绝，不会生成正式决策')
  } catch (error) {
    show(error instanceof Error ? error.message : '拒绝提案失败', { error: true })
  } finally {
    busyId.value = null
  }
}
</script>

<template>
  <div class="r2-page inbox-page">
    <header class="inbox-hero">
      <div>
        <p class="kicker">MESSAGE CENTER</p>
        <h1>消息中心</h1>
        <p>
          平台已经自动汇总交易、收益、持仓、产品事件、评估与复盘。
          这里只显示需要你补事实、做最后确认或知悉的异常。
        </p>
      </div>
      <div class="inbox-hero-stats">
        <span>
          <strong>{{ summary.pending_count }}</strong>
          待处理
        </span>
        <span>
          <strong>{{ summary.unread_count }}</strong>
          未读
        </span>
        <span>
          <strong>{{ summary.urgent_count }}</strong>
          紧急
        </span>
      </div>
    </header>

    <section class="inbox-toolbar" aria-label="消息筛选">
      <div class="inbox-tabs" role="tablist" aria-label="消息状态">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          role="tab"
          :aria-selected="filter === tab.key"
          :class="{ 'is-active': filter === tab.key }"
          @click="filter = tab.key"
        >
          {{ tab.label }}
          <span>{{ filterCounts[tab.key] }}</span>
        </button>
      </div>
      <label class="inbox-search">
        <span>搜索</span>
        <input
          v-model="keyword"
          type="search"
          placeholder="产品、交易、收益或提醒"
        />
      </label>
      <button
        type="button"
        class="button button-ghost button-small"
        :disabled="markingAll || summary.unread_count === 0"
        @click="markAllRead"
      >
        全部已读
      </button>
    </section>

    <section v-if="groups.length === 0" class="inbox-empty">
      <strong>
        {{ filter === 'handled' ? '还没有已处理记录' : '当前没有需要你处理的消息' }}
      </strong>
      <p>
        {{
          filter === 'pending'
            ? '平台会自动继续追踪；新的异常或确认点出现后会出现在这里。'
            : '切换筛选可以查看其他消息。'
        }}
      </p>
    </section>

    <section
      v-for="group in groups"
      :key="group.label"
      class="inbox-source-group"
      :aria-label="group.label"
    >
      <header>
        <strong>{{ group.label }}</strong>
        <span>{{ group.items.length }} 项<template v-if="group.unread"> · {{ group.unread }} 未读</template></span>
      </header>
      <div class="inbox-list">
        <article
          v-for="item in group.items"
          :key="item.id"
          class="inbox-message"
          :class="[
            `is-${item.severity}`,
            {
              'is-unread': !item.read_at,
              'is-snoozed': item.status === 'snoozed',
              'is-resolved': item.status === 'resolved',
            },
          ]"
        >
          <button
            class="inbox-message-main"
            type="button"
            :disabled="busyId === item.id"
            @click="openItem(item)"
          >
            <span class="inbox-message-topline">
              <span class="inbox-severity">{{ severityLabel(item) }}</span>
              <span>{{ formatDateShort(item.updated_at.slice(0, 10)) }}</span>
              <span v-if="!item.read_at" class="inbox-unread-dot">未读</span>
            </span>
            <strong>{{ item.title }}</strong>
            <p>{{ item.summary }}</p>
            <span class="inbox-message-action">
              {{ item.action_label }} →
            </span>
          </button>
          <div class="inbox-message-tools">
            <template
              v-if="
                item.source_type === 'decision_proposal' &&
                item.metadata.proposal_status === 'pending'
              "
            >
              <button
                type="button"
                class="rw-button button-small"
                :disabled="busyId === item.id"
                @click="adoptProposal(item)"
              >
                采纳提案
              </button>
              <button
                type="button"
                class="rw-link-button is-danger"
                :disabled="busyId === item.id"
                @click="rejectProposal(item)"
              >
                拒绝
              </button>
            </template>
            <button
              v-if="
                item.source_type === 'decision_proposal' &&
                item.metadata.proposal_status === 'accepted'
              "
              type="button"
              class="rw-link-button is-danger"
              :disabled="busyId === item.id"
              @click="rejectProposal(item)"
            >
              取消采纳
            </button>
            <button
              v-if="item.status !== 'resolved'"
              type="button"
              class="rw-link-button"
              :disabled="busyId === item.id"
              @click="markUnread(item)"
            >
              {{ item.read_at ? '标为未读' : '标为已读' }}
            </button>
            <button
              v-if="item.status !== 'resolved'"
              type="button"
              class="rw-link-button"
              :disabled="busyId === item.id"
              @click="snooze(item)"
            >
              {{ item.status === 'snoozed' ? '恢复提醒' : '明天再提醒' }}
            </button>
            <span v-if="item.due_at">截止 {{ item.due_at }}</span>
            <span v-if="item.snoozed_until">稍后至 {{ item.snoozed_until }}</span>
            <span v-if="item.resolved_at">
              已处理 {{ formatDateShort(item.resolved_at.slice(0, 10)) }}
            </span>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>
