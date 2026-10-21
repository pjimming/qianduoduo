<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import { formatDateShort, formatMoney } from '@/composables/useFormatters'
import type { TradeInboxItem, TradeInboxParsed } from '@/types/dashboard'

const props = defineProps<{
  inbox: TradeInboxItem[]
  today: string
}>()

const store = useDashboardStore()
const { show } = useToast()
const dragActive = ref(false)
const uploading = ref(false)
const busyId = ref<number | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const showProcessed = ref(false)
const drafts = reactive<Record<number, TradeInboxParsed>>({})

const pendingItems = computed(() =>
  props.inbox.filter((item) => item.status === 'pending'),
)
const processedCount = computed(() => props.inbox.length - pendingItems.value.length)
const visibleItems = computed(() =>
  showProcessed.value ? props.inbox : pendingItems.value,
)

watch(
  () => props.inbox,
  (items) => {
    for (const item of items) {
      if (!drafts[item.id]) {
        drafts[item.id] = {
          trade_date: item.parsed.trade_date || props.today,
          confirm_date: item.parsed.confirm_date || '',
          trade_type: item.parsed.trade_type || 'buy',
          status: item.parsed.status || 'pending',
          product_code: item.parsed.product_code || '',
          product_name: item.parsed.product_name || '',
          issuer: item.parsed.issuer || '招银理财',
          risk_level: item.parsed.risk_level || 'R2',
          amount: item.parsed.amount ?? null,
          settlement_amount: item.parsed.settlement_amount ?? null,
          shares: item.parsed.shares ?? null,
          term_days: item.parsed.term_days ?? null,
          maturity_date: item.parsed.maturity_date || '',
          confidence: item.parsed.confidence,
          warnings: item.parsed.warnings || [],
        }
      }
    }
  },
  { immediate: true },
)

async function uploadFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files)
  if (!list.length) return
  uploading.value = true
  for (const file of list) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      show(`${file.name} 不是 PNG/JPEG/WebP 图片`, { error: true })
      continue
    }
    if (file.size > 10 * 1024 * 1024) {
      show(`${file.name} 超过 10 MB`, { error: true })
      continue
    }
    try {
      const data = await readAsDataUrl(file)
      const response = await store.uploadTradeScreenshot({
        filename: file.name,
        mime: file.type,
        data,
      })
      if (response.duplicate) {
        show(`${file.name} 已在收件箱，未重复保存`)
      } else if (response.ocr?.ok) {
        show(`${file.name} 已识别文字，请校正后生成交易`)
      } else {
        show(`${file.name} 已保存，OCR 未识别到文字，请手工填写`)
      }
    } catch (error) {
      show(error instanceof Error ? error.message : '上传失败', { error: true })
    }
  }
  uploading.value = false
  if (fileInput.value) fileInput.value.value = ''
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

function onDrop(event: DragEvent): void {
  dragActive.value = false
  if (event.dataTransfer?.files?.length) {
    void uploadFiles(event.dataTransfer.files)
  }
}

async function saveDraft(item: TradeInboxItem): Promise<void> {
  busyId.value = item.id
  try {
    await store.updateTradeInbox(item.id, drafts[item.id] || {})
    show('识别结果已保存')
  } catch (error) {
    show(error instanceof Error ? error.message : '保存失败', { error: true })
  } finally {
    busyId.value = null
  }
}

async function applyDraft(item: TradeInboxItem): Promise<void> {
  busyId.value = item.id
  try {
    const response = await store.applyTradeInbox(item.id, drafts[item.id] || {})
    show(
      response.matched
        ? '已匹配到已有交易，截图已归档'
        : '已生成交易流水，待确认后进入持仓',
    )
  } catch (error) {
    show(error instanceof Error ? error.message : '生成交易失败', { error: true })
  } finally {
    busyId.value = null
  }
}

async function ignore(item: TradeInboxItem): Promise<void> {
  if (!window.confirm('忽略这张截图？原图会保留在本地，直到定期清理。')) return
  busyId.value = item.id
  try {
    await store.ignoreTradeInbox(item.id)
    show('截图已忽略')
  } catch (error) {
    show(error instanceof Error ? error.message : '操作失败', { error: true })
  } finally {
    busyId.value = null
  }
}

async function prune(): Promise<void> {
  if (!window.confirm('清理 180 天前已处理或已忽略截图的原图？交易流水和业务字段会保留。')) {
    return
  }
  try {
    const result = await store.pruneTradeScreenshots(180)
    show(`已清理 ${result.removed} 张旧截图`)
  } catch (error) {
    show(error instanceof Error ? error.message : '清理失败', { error: true })
  }
}

function confidenceLabel(item: TradeInboxItem): string {
  const value = Number(drafts[item.id]?.confidence ?? item.parse_confidence)
  if (!value) return '未识别'
  if (value >= 80) return `识别 ${value}% · 较完整`
  if (value >= 50) return `识别 ${value}% · 请核对`
  return `识别 ${value}% · 需手工补充`
}

function draftFor(item: TradeInboxItem): TradeInboxParsed {
  if (!drafts[item.id]) {
    drafts[item.id] = {
      trade_date: item.parsed.trade_date || props.today,
      trade_type: item.parsed.trade_type || 'buy',
      status: item.parsed.status || 'pending',
      product_code: item.parsed.product_code || '',
      product_name: item.parsed.product_name || '',
      amount: item.parsed.amount ?? null,
    }
  }
  return drafts[item.id]
}
</script>

<template>
  <div class="rw-panel-body">
    <div class="rw-toolbar">
      <div class="rw-card-heading">
        <p class="kicker">TRADE INBOX</p>
        <strong class="rw-panel-title">把成交截图拖进来</strong>
        <p class="rw-panel-sub">
          图片只在本地识别并归档，不上传银行。OCR 也会看错数字，
          生成交易前请逐项核对产品、金额和状态。
        </p>
      </div>
      <div class="rw-toolbar-actions">
        <button type="button" class="rw-button is-secondary" @click="prune">
          清理 180 天前原图
        </button>
      </div>
    </div>

    <div
      class="rw-dropzone"
      :class="{ 'is-active': dragActive, 'is-busy': uploading }"
      role="button"
      tabindex="0"
      @dragover.prevent="dragActive = true"
      @dragleave.prevent="dragActive = false"
      @drop.prevent="onDrop"
      @click="fileInput?.click()"
      @keydown.enter.prevent="fileInput?.click()"
      @keydown.space.prevent="fileInput?.click()"
    >
      <input
        ref="fileInput"
        class="rw-file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        @change="uploadFiles(($event.target as HTMLInputElement).files || [])"
      />
      <strong>{{ uploading ? '正在识别…' : '拖入招行成交截图' }}</strong>
      <span>或点击选择 PNG / JPEG / WebP，单张不超过 10 MB</span>
    </div>

    <div v-if="inbox.length === 0" class="rw-empty">
      收件箱还是空的。买入或赎回后，把招行 App 的成交截图拖到上方即可。
    </div>
    <div v-else-if="pendingItems.length === 0 && !showProcessed" class="rw-empty">
      没有待校正截图。已处理的
      {{ processedCount }} 张仍保留在本地，可展开核对。
    </div>

    <div v-if="visibleItems.length" class="rw-inbox-list">
      <article
        v-for="item in visibleItems"
        :key="item.id"
        class="rw-inbox-card"
        :class="{ 'is-applied': item.status === 'applied', 'is-ignored': item.status === 'ignored' }"
      >
        <div class="rw-inbox-thumb">
          <a v-if="item.image_url" :href="item.image_url" target="_blank" rel="noreferrer">
            <img :src="item.image_url" :alt="item.original_name || '成交截图'" loading="lazy" />
          </a>
          <div v-else class="rw-inbox-no-image">原图已清理</div>
          <small>{{ item.original_name || `截图 #${item.id}` }}</small>
          <small>{{ formatDateShort(item.received_at.slice(0, 10)) }} · {{ confidenceLabel(item) }}</small>
        </div>

        <div class="rw-inbox-body">
          <div class="rw-inbox-head">
            <span
              class="rw-trade-status"
              :class="{
                'is-pending': item.status === 'pending',
                'is-confirmed': item.status === 'applied',
                'is-cancelled': item.status === 'ignored',
              }"
            >
              {{ item.status === 'pending' ? '待处理' : item.status === 'applied' ? '已入账' : '已忽略' }}
            </span>
            <span v-if="item.duplicate_of" class="rw-alert is-info">
              匹配到已有交易 #{{ item.duplicate_of }}
            </span>
            <span v-if="item.error" class="rw-alert is-warn">{{ item.error }}</span>
          </div>

          <div v-if="item.status === 'pending'" class="rw-inbox-grid">
            <label class="rw-field">
              <span>类型</span>
              <select v-model="draftFor(item).trade_type">
                <option value="buy">买入</option>
                <option value="redeem">赎回</option>
                <option value="switch">切换</option>
              </select>
            </label>
            <label class="rw-field">
              <span>交易日期</span>
              <input v-model="draftFor(item).trade_date" type="date" />
            </label>
            <label class="rw-field">
              <span>状态</span>
              <select v-model="draftFor(item).status">
                <option value="pending">待确认</option>
                <option value="confirmed">已确认</option>
              </select>
            </label>
            <label class="rw-field">
              <span>交易金额</span>
              <input v-model.number="draftFor(item).amount" type="number" min="0" step="0.01" />
            </label>
            <label class="rw-field">
              <span>产品代码</span>
              <input v-model="draftFor(item).product_code" type="text" maxlength="50" />
            </label>
            <label class="rw-field">
              <span>产品名称</span>
              <input v-model="draftFor(item).product_name" type="text" maxlength="120" />
            </label>
            <label class="rw-field">
              <span>产品期限（天）</span>
              <input v-model.number="draftFor(item).term_days" type="number" min="0" max="3650" />
            </label>
            <label v-if="draftFor(item).status === 'confirmed'" class="rw-field">
              <span>确认日期</span>
              <input v-model="draftFor(item).confirm_date" type="date" />
            </label>
            <label
              v-if="draftFor(item).trade_type === 'redeem' || draftFor(item).trade_type === 'switch'"
              class="rw-field"
            >
              <span>实际到账金额</span>
              <input v-model.number="draftFor(item).settlement_amount" type="number" min="0" step="0.01" />
            </label>
          </div>

          <div v-else class="rw-inbox-summary">
            <span>{{ draftFor(item).product_name || '未填写产品' }}</span>
            <span>{{ formatMoney(Number(draftFor(item).amount || 0), 2) }}</span>
            <span v-if="item.trade_id">流水 #{{ item.trade_id }}</span>
          </div>

          <details v-if="item.ocr_text" class="rw-ocr-details">
            <summary>查看 OCR 原文</summary>
            <pre>{{ item.ocr_text }}</pre>
          </details>

          <div v-if="item.status === 'pending'" class="rw-form-actions">
            <button
              type="button"
              class="rw-button"
              :disabled="busyId === item.id"
              @click="saveDraft(item)"
            >
              保存校正
            </button>
            <button
              type="button"
              class="rw-button is-secondary"
              :disabled="busyId === item.id"
              @click="applyDraft(item)"
            >
              生成 / 匹配交易
            </button>
            <button
              type="button"
              class="rw-link-button is-danger"
              @click="ignore(item)"
            >
              忽略
            </button>
          </div>
        </div>
      </article>
    </div>

    <div v-if="processedCount > 0" class="rw-inbox-processed">
      <button
        type="button"
        class="rw-link-button"
        :aria-expanded="showProcessed"
        @click="showProcessed = !showProcessed"
      >
        {{ showProcessed ? '收起已处理截图' : `显示已处理截图 ${processedCount} 张` }}
      </button>
    </div>
  </div>
</template>
