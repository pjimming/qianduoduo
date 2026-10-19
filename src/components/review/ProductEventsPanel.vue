<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import type {
  ProductEvent,
  ProductEventImpact,
  ProductEventInput,
  ProductEventType,
} from '@/types/dashboard'

const props = defineProps<{
  events: ProductEvent[]
  today: string
}>()

const store = useDashboardStore()
const { show } = useToast()

const eventTypes: ProductEventType[] = ['费率', '经理', '底层', '赎回规则', '额度', '其他']
const impacts: ProductEventImpact[] = ['低', '中', '高']

const formOpen = ref(false)
const editingId = ref<number | null>(null)
const saving = ref(false)
const form = reactive<ProductEventInput>(emptyForm())

const stats = computed(() => {
  const currentMonth = props.today.slice(0, 7)
  return {
    open: props.events.filter((item) => item.status === '待复核').length,
    highOpen: props.events.filter(
      (item) => item.status === '待复核' && item.impact === '高',
    ).length,
    thisMonth: props.events.filter((item) => item.date.startsWith(currentMonth)).length,
  }
})

function emptyForm(): ProductEventInput {
  return {
    date: props.today,
    product_name: '',
    event_type: '额度',
    description: '',
    impact: '中',
    status: '待复核',
  }
}

function resetForm(): void {
  Object.assign(form, emptyForm())
  editingId.value = null
}

function openCreate(): void {
  resetForm()
  formOpen.value = true
}

function openEdit(item: ProductEvent): void {
  editingId.value = item.id
  Object.assign(form, {
    date: item.date,
    product_name: item.product_name,
    event_type: item.event_type,
    description: item.description,
    impact: item.impact,
    status: item.status,
  })
  formOpen.value = true
}

function payloadOf(item: ProductEvent, status = item.status): ProductEventInput {
  return {
    date: item.date,
    product_name: item.product_name,
    event_type: item.event_type,
    description: item.description,
    impact: item.impact,
    status,
  }
}

async function save(): Promise<void> {
  if (!form.product_name.trim()) {
    show('请填写产品名称', { error: true })
    return
  }
  if (!form.description.trim()) {
    show('请填写事件说明', { error: true })
    return
  }
  saving.value = true
  try {
    if (editingId.value !== null) {
      await store.updateProductEvent(editingId.value, { ...form })
      show('产品事件已更新')
    } else {
      await store.createProductEvent({ ...form })
      show('产品事件已记录')
    }
    formOpen.value = false
    resetForm()
  } catch (error) {
    show(error instanceof Error ? error.message : '保存失败', { error: true })
  } finally {
    saving.value = false
  }
}

async function toggleStatus(item: ProductEvent): Promise<void> {
  try {
    await store.updateProductEvent(
      item.id,
      payloadOf(item, item.status === '待复核' ? '已处理' : '待复核'),
    )
    show(item.status === '待复核' ? '已标记为已处理' : '已重新打开')
  } catch (error) {
    show(error instanceof Error ? error.message : '更新失败', { error: true })
  }
}

async function remove(item: ProductEvent): Promise<void> {
  if (!window.confirm(`删除「${item.product_name}」在 ${item.date} 的产品事件？`)) return
  try {
    await store.deleteProductEvent(item.id)
    show('产品事件已删除')
  } catch (error) {
    show(error instanceof Error ? error.message : '删除失败', { error: true })
  }
}
</script>

<template>
  <div class="rw-panel-body">
    <div class="rw-toolbar">
      <div class="rw-card-heading">
        <p class="kicker">PRODUCT EVENTS</p>
        <strong class="rw-panel-title">产品事件 / 特殊事项</strong>
        <p class="rw-panel-sub">
          费率、经理、底层、赎回规则、额度等变化，记一条并在周检查时复核。
        </p>
      </div>
      <div class="rw-toolbar-actions">
        <button type="button" class="rw-button" @click="openCreate">新增事件</button>
      </div>
    </div>

    <div class="rw-stat-row rw-stat-row-spaced">
      <span class="rw-stat-chip">本月事件 <strong>{{ stats.thisMonth }}</strong></span>
      <span class="rw-stat-chip" :class="{ 'is-warn': stats.open > 0 }">
        待复核 <strong>{{ stats.open }}</strong>
      </span>
      <span class="rw-stat-chip" :class="{ 'is-warn': stats.highOpen > 0 }">
        高影响待复核 <strong>{{ stats.highOpen }}</strong>
      </span>
    </div>

    <form v-if="formOpen" class="rw-form" @submit.prevent="save">
      <div class="rw-form-head">
        <strong>{{ editingId === null ? '记录产品事件' : '修改产品事件' }}</strong>
        <button type="button" class="rw-link-button" @click="formOpen = false; resetForm()">
          取消
        </button>
      </div>
      <div class="rw-form-grid">
        <label class="rw-field">
          <span>日期</span>
          <input v-model="form.date" type="date" required />
        </label>
        <label class="rw-field">
          <span>产品名称</span>
          <input v-model="form.product_name" type="text" maxlength="100" required />
        </label>
        <label class="rw-field">
          <span>事件类型</span>
          <select v-model="form.event_type">
            <option v-for="type in eventTypes" :key="type" :value="type">{{ type }}</option>
          </select>
        </label>
        <label class="rw-field">
          <span>影响程度</span>
          <select v-model="form.impact">
            <option v-for="impact in impacts" :key="impact" :value="impact">{{ impact }}</option>
          </select>
        </label>
        <label class="rw-field">
          <span>状态</span>
          <select v-model="form.status">
            <option value="待复核">待复核</option>
            <option value="已处理">已处理</option>
          </select>
        </label>
        <label class="rw-field is-wide">
          <span>事件说明</span>
          <textarea
            v-model="form.description"
            rows="3"
            maxlength="1000"
            placeholder="例如：赎回规则从 T+1 改为 T+2；费率下调 0.05%；额度窗口提前"
            required
          ></textarea>
        </label>
      </div>
      <div class="rw-form-actions">
        <button type="submit" class="rw-button" :disabled="saving">
          {{ saving ? '保存中…' : '保存事件' }}
        </button>
      </div>
    </form>

    <div v-if="events.length === 0" class="rw-empty">
      还没有产品事件记录。费率、经理、底层、赎回规则或额度发生变化时，在这里留一条，周检查时逐项复核。
    </div>
    <div v-else class="rw-list">
      <article
        v-for="item in events"
        :key="item.id"
        class="rw-event"
        :class="[`is-impact-${item.impact}`, { 'is-closed': item.status === '已处理' }]"
      >
        <div class="rw-event-head">
          <div class="rw-decision-title">
            <strong>{{ item.product_name }}</strong>
            <span class="rw-type-badge">{{ item.event_type }}</span>
            <span class="rw-muted">{{ item.date }}</span>
          </div>
          <div class="rw-event-tags">
            <span class="rw-impact" :class="`is-${item.impact}`">影响 {{ item.impact }}</span>
            <span class="rw-status" :class="{ 'is-closed': item.status === '已处理' }">
              {{ item.status }}
            </span>
          </div>
        </div>
        <p>{{ item.description }}</p>
        <div class="rw-row-actions">
          <button type="button" class="rw-link-button" @click="toggleStatus(item)">
            {{ item.status === '待复核' ? '标记已处理' : '重新打开' }}
          </button>
          <button type="button" class="rw-link-button" @click="openEdit(item)">编辑</button>
          <button type="button" class="rw-link-button is-danger" @click="remove(item)">删除</button>
        </div>
      </article>
    </div>
  </div>
</template>
