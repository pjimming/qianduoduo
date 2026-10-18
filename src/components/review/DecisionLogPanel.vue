<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import type { DecisionEntry, DecisionInput, DecisionRating } from '@/types/dashboard'

const props = defineProps<{
  decisions: DecisionEntry[]
  today: string
}>()

const store = useDashboardStore()
const { show } = useToast()

const actions: Array<DecisionInput['action']> = ['买入', '赎回', '切换', '观察']
const ratings: DecisionRating[] = [
  '待评估',
  '流程正确，结果好',
  '流程正确，结果差',
  '流程错误，结果好',
  '流程错误，结果差',
]

const formOpen = ref(false)
const editingId = ref<number | null>(null)
const saving = ref(false)
const form = reactive<DecisionInput>(emptyForm())

const stats = computed(() => {
  const currentMonth = props.today.slice(0, 7)
  return {
    thisMonth: props.decisions.filter((item) => item.date.startsWith(currentMonth)).length,
    pending: props.decisions.filter((item) => item.rating === '待评估').length,
    wrongGood: props.decisions.filter((item) => item.rating === '流程错误，结果好').length,
    rightBad: props.decisions.filter((item) => item.rating === '流程正确，结果差').length,
  }
})

function emptyForm(): DecisionInput {
  return {
    date: props.today,
    product_name: '',
    action: '买入',
    reason: '',
    expectation: '',
    actual_result: '',
    rating: '待评估',
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

function openEdit(item: DecisionEntry): void {
  editingId.value = item.id
  Object.assign(form, {
    date: item.date,
    product_name: item.product_name,
    action: item.action,
    reason: item.reason,
    expectation: item.expectation,
    actual_result: item.actual_result,
    rating: item.rating,
  })
  formOpen.value = true
}

async function save(): Promise<void> {
  if (!form.product_name.trim()) {
    show('请填写产品名称', { error: true })
    return
  }
  if (!form.reason.trim()) {
    show('请填写当时的理由', { error: true })
    return
  }
  saving.value = true
  try {
    if (editingId.value !== null) {
      await store.updateDecision(editingId.value, { ...form })
      show('决策记录已更新')
    } else {
      await store.createDecision({ ...form })
      show('决策记录已保存')
    }
    formOpen.value = false
    resetForm()
  } catch (error) {
    show(error instanceof Error ? error.message : '保存失败', { error: true })
  } finally {
    saving.value = false
  }
}

async function remove(item: DecisionEntry): Promise<void> {
  if (!window.confirm(`删除「${item.product_name}」在 ${item.date} 的决策记录？`)) return
  try {
    await store.deleteDecision(item.id)
    show('决策记录已删除')
  } catch (error) {
    show(error instanceof Error ? error.message : '删除失败', { error: true })
  }
}

function ratingClass(rating: DecisionRating): string {
  if (rating === '流程正确，结果好') return 'is-good'
  if (rating === '流程正确，结果差') return 'is-neutral'
  if (rating === '流程错误，结果好') return 'is-warn'
  if (rating === '流程错误，结果差') return 'is-bad'
  return 'is-pending'
}

function actionClass(action: DecisionInput['action']): string {
  if (action === '买入') return 'is-buy'
  if (action === '赎回') return 'is-redeem'
  if (action === '切换') return 'is-switch'
  return 'is-none'
}
</script>

<template>
  <div class="rw-panel-body">
    <div class="rw-toolbar">
      <div class="rw-stat-row">
        <span class="rw-stat-chip">本月决策 <strong>{{ stats.thisMonth }}</strong></span>
        <span class="rw-stat-chip">待评估 <strong>{{ stats.pending }}</strong></span>
        <span class="rw-stat-chip" :class="{ 'is-warn': stats.wrongGood > 0 }">
          流程错误结果好 <strong>{{ stats.wrongGood }}</strong>
        </span>
        <span class="rw-stat-chip">流程正确结果差 <strong>{{ stats.rightBad }}</strong></span>
      </div>
      <button type="button" class="rw-button" @click="openCreate">新增决策</button>
    </div>

    <form v-if="formOpen" class="rw-form" @submit.prevent="save">
      <div class="rw-form-head">
        <strong>{{ editingId === null ? '记录一次决策' : '修改决策记录' }}</strong>
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
          <span>动作</span>
          <select v-model="form.action">
            <option v-for="action in actions" :key="action" :value="action">{{ action }}</option>
          </select>
        </label>
        <label class="rw-field">
          <span>事后评价</span>
          <select v-model="form.rating">
            <option v-for="rating in ratings" :key="rating" :value="rating">{{ rating }}</option>
          </select>
        </label>
        <label class="rw-field is-wide">
          <span>当时的理由</span>
          <textarea
            v-model="form.reason"
            rows="2"
            maxlength="1000"
            placeholder="为什么会做这笔操作？看到了什么证据？"
            required
          ></textarea>
        </label>
        <label class="rw-field is-wide">
          <span>预期（收益 / 流动性 / 风险）</span>
          <textarea
            v-model="form.expectation"
            rows="2"
            maxlength="1000"
            placeholder="例如：持有到期年化 2.9%，90 天后可用，最大回撤可接受"
          ></textarea>
        </label>
        <label class="rw-field is-wide">
          <span>实际结果</span>
          <textarea
            v-model="form.actual_result"
            rows="2"
            maxlength="1000"
            placeholder="可以事后补充：实际收益、到账情况、是否偏离预期"
          ></textarea>
        </label>
      </div>
      <div class="rw-form-actions">
        <button type="submit" class="rw-button" :disabled="saving">
          {{ saving ? '保存中…' : '保存决策' }}
        </button>
      </div>
    </form>

    <div v-if="decisions.length === 0" class="rw-empty">
      还没有决策记录。先记下最近一笔买入、赎回或切换的理由，事后才能区分流程和运气。
    </div>
    <div v-else class="rw-list">
      <article v-for="item in decisions" :key="item.id" class="rw-decision">
        <div class="rw-decision-head">
          <div class="rw-decision-title">
            <strong>{{ item.product_name }}</strong>
            <span class="action-tag" :class="actionClass(item.action)">{{ item.action }}</span>
            <span class="rw-muted">{{ item.date }}</span>
          </div>
          <span class="rw-rating" :class="ratingClass(item.rating)">{{ item.rating }}</span>
        </div>
        <p class="rw-decision-reason">{{ item.reason }}</p>
        <div class="rw-decision-meta">
          <span><em>预期</em>{{ item.expectation || '未填写' }}</span>
          <span><em>结果</em>{{ item.actual_result || '待观察' }}</span>
        </div>
        <div class="rw-row-actions">
          <button type="button" class="rw-link-button" @click="openEdit(item)">编辑</button>
          <button type="button" class="rw-link-button is-danger" @click="remove(item)">删除</button>
        </div>
      </article>
    </div>
  </div>
</template>
