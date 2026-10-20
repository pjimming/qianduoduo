<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import EntryForm from '@/components/EntryForm.vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import { formatMoney } from '@/composables/useFormatters'
import type {
  AutomationWorkspace,
  DashboardPayload,
  ProductEventImpact,
  ProductEventType,
  ReviewWorkspace,
  TradeInboxItem,
  TradeInboxParsed,
} from '@/types/dashboard'

interface EntryFormExposed {
  loadRecordForEdit: (date: string, focus?: boolean) => void
  startRecord: (date: string) => void
  resetForm: () => void
  isEditingDate: (date: string) => boolean
}

type ModuleKey =
  | 'inbox'
  | 'trades'
  | 'holdings'
  | 'events'
  | 'holding_reviews'
  | 'decisions'
  | 'automation'
  | 'monthly'
  | 'quarterly'

const props = defineProps<{
  dashboard: DashboardPayload
  workspace: ReviewWorkspace
  automation: AutomationWorkspace
}>()

const emit = defineEmits<{
  saved: [date: string]
  'open-module': [key: ModuleKey]
}>()

const store = useDashboardStore()
const { show } = useToast()

const dailyRef = ref<EntryFormExposed | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const dragActive = ref(false)
const uploading = ref(false)
const savingCase = ref(false)

const today = computed(() => props.dashboard.meta.today)
const todayRecord = computed(
  () => props.dashboard.records.find((record) => record.date === today.value) ?? null,
)
const inbox = computed(() => props.workspace.trades?.inbox ?? [])
const pendingInbox = computed(() => inbox.value.filter((item) => item.status === 'pending'))
const tradeSummary = computed(() => props.workspace.trades?.summary ?? null)
const pendingEvaluations = computed(() => props.automation.pending_evaluations.length)
const openEvents = computed(
  () => props.workspace.events.filter((item) => item.status === '待复核').length,
)
const holdingReviewSummary = computed(
  () =>
    props.workspace.holding_reviews_summary ?? {
      total: 0,
      replace: 0,
      watch: 0,
      hold: 0,
      window: 0,
    },
)
const holdingReviewTodo = computed(
  () => holdingReviewSummary.value.replace + holdingReviewSummary.value.window,
)

const todos = computed(() => [
  {
    key: 'inbox' as ModuleKey,
    label: '截图待校正',
    value: pendingInbox.value.length,
    tone: pendingInbox.value.length > 0 ? 'is-warn' : 'is-done',
  },
  {
    key: 'daily' as const,
    label: '今日收益',
    value: todayRecord.value ? '已记' : '未记',
    tone: todayRecord.value ? 'is-done' : 'is-warn',
  },
  {
    key: 'trades' as ModuleKey,
    label: '待确认交易',
    value: tradeSummary.value?.pending_count ?? 0,
    tone: (tradeSummary.value?.pending_count ?? 0) > 0 ? 'is-warn' : 'is-done',
  },
  {
    key: 'automation' as ModuleKey,
    label: '待确认评估',
    value: pendingEvaluations.value,
    tone: pendingEvaluations.value > 0 ? 'is-warn' : 'is-done',
  },
  {
    key: 'holding_reviews' as ModuleKey,
    label: '持仓复核',
    value: holdingReviewTodo.value,
    tone: holdingReviewTodo.value > 0 ? 'is-warn' : 'is-done',
  },
  {
    key: 'events' as ModuleKey,
    label: '待复核事项',
    value: openEvents.value,
    tone: openEvents.value > 0 ? 'is-warn' : 'is-done',
  },
])

const caseTypes: ProductEventType[] = ['额度', '费率', '赎回规则', '经理', '底层', '其他']
const caseImpacts: ProductEventImpact[] = ['低', '中', '高']

const specialCase = reactive({
  date: today.value,
  product_name: '',
  event_type: '额度' as ProductEventType,
  impact: '中' as ProductEventImpact,
  description: '',
})

function handleTodo(key: ModuleKey | 'daily'): void {
  if (key === 'daily') {
    dailyRef.value?.startRecord(today.value)
    return
  }
  emit('open-module', key)
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

async function tryAutoApply(item: TradeInboxItem, ocrOk: boolean): Promise<boolean> {
  const parsed = item.parsed
  const ready =
    ocrOk &&
    Number(parsed.confidence ?? 0) >= 90 &&
    (parsed.warnings ?? []).length === 0 &&
    parsed.amount !== null &&
    parsed.amount !== undefined &&
    Boolean(parsed.product_name) &&
    Boolean(parsed.trade_date)
  if (!ready) return false
  const payload: TradeInboxParsed = {
    trade_date: parsed.trade_date,
    confirm_date: parsed.confirm_date ?? '',
    trade_type: parsed.trade_type ?? 'buy',
    status: 'pending',
    product_code: parsed.product_code ?? '',
    product_name: parsed.product_name ?? '',
    issuer: parsed.issuer ?? '招银理财',
    risk_level: parsed.risk_level ?? 'R2',
    amount: parsed.amount ?? null,
    settlement_amount: parsed.settlement_amount ?? null,
    shares: parsed.shares ?? null,
    term_days: parsed.term_days ?? null,
    maturity_date: parsed.maturity_date ?? '',
    confidence: parsed.confidence,
    warnings: [],
  }
  await store.applyTradeInbox(item.id, payload)
  return true
}

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
        continue
      }
      let applied = false
      try {
        applied = await tryAutoApply(response.inbox, Boolean(response.ocr?.ok))
      } catch {
        applied = false
      }
      show(
        applied
          ? `${file.name} 已识别并生成交易，待确认份额`
          : `${file.name} 已保存，识别不确定，请到「账本 → 交易收件箱」校正`,
        applied ? undefined : { duration: 6000 },
      )
      emit('saved', today.value)
    } catch (error) {
      show(error instanceof Error ? error.message : '上传失败', { error: true })
    }
  }
  uploading.value = false
  if (fileInput.value) fileInput.value.value = ''
}

function onDrop(event: DragEvent): void {
  dragActive.value = false
  if (event.dataTransfer?.files?.length) {
    void uploadFiles(event.dataTransfer.files)
  }
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  if (input.files?.length) {
    void uploadFiles(input.files)
  }
}

async function saveSpecialCase(): Promise<void> {
  const description = specialCase.description.trim()
  if (!description) {
    show('请写一句发生了什么', { error: true })
    return
  }
  savingCase.value = true
  try {
    await store.createProductEvent({
      date: specialCase.date,
      product_name: specialCase.product_name.trim() || '组合',
      event_type: specialCase.event_type,
      description,
      impact: specialCase.impact,
      status: '待复核',
    })
    specialCase.description = ''
    specialCase.product_name = ''
    specialCase.event_type = '额度'
    specialCase.impact = '中'
    show('特殊事项已提交，AI 会跟进')
    emit('saved', today.value)
  } catch (error) {
    show(error instanceof Error ? error.message : '提交失败', { error: true })
  } finally {
    savingCase.value = false
  }
}

function handleRecordSaved(date: string): void {
  emit('saved', date)
}

defineExpose({
  startRecord: (date: string) => dailyRef.value?.startRecord(date),
  loadRecordForEdit: (date: string) => dailyRef.value?.loadRecordForEdit(date),
  resetForm: () => dailyRef.value?.resetForm(),
  isEditingDate: (date: string) => dailyRef.value?.isEditingDate(date) ?? false,
})
</script>

<template>
  <section class="rw-quick" aria-labelledby="rwQuickTitle">
    <div class="rw-quick-head">
      <div>
        <p class="kicker">今日入口</p>
        <h3 id="rwQuickTitle">你只需要提交三件事</h3>
        <p>截图、收益、特殊事项交给这里；决策、持仓、评估和复盘由 AI 维护。</p>
      </div>
      <span class="rw-quick-badge">其余只读</span>
    </div>

    <div class="rw-todo-strip" aria-label="待我处理">
      <button
        v-for="item in todos"
        :key="item.key"
        type="button"
        class="rw-todo-chip"
        :class="item.tone"
        @click="handleTodo(item.key)"
      >
        <span>{{ item.label }}</span>
        <strong>{{ item.value }}</strong>
      </button>
    </div>

    <div class="rw-quick-grid">
      <section class="rw-quick-card">
        <div class="rw-quick-card-head">
          <span class="rw-quick-step">01</span>
          <div>
            <strong>买入 / 赎回截图</strong>
            <p>拖进来即可。高置信度截图自动生成交易，识别不准的才需要校正。</p>
          </div>
        </div>
        <div
          class="rw-dropzone is-compact"
          :class="{ 'is-active': dragActive, 'is-busy': uploading }"
          role="button"
          tabindex="0"
          @click="fileInput?.click()"
          @keydown.enter.prevent="fileInput?.click()"
          @keydown.space.prevent="fileInput?.click()"
          @dragover.prevent="dragActive = true"
          @dragleave.prevent="dragActive = false"
          @drop.prevent="onDrop"
        >
          <strong>{{ uploading ? '正在识别…' : '拖入成交截图' }}</strong>
          <span>或点击选择 PNG / JPEG / WebP，单张不超过 10 MB</span>
        </div>
        <input
          ref="fileInput"
          class="rw-file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          @change="onFileChange"
        />
        <div class="rw-quick-meta">
          <span v-if="pendingInbox.length">
            {{ pendingInbox.length }} 张待校正
          </span>
          <span v-else>没有待校正截图</span>
          <button
            v-if="pendingInbox.length"
            type="button"
            class="rw-link-button"
            @click="emit('open-module', 'inbox')"
          >
            去校正
          </button>
        </div>
      </section>

      <section class="rw-quick-card">
        <div class="rw-quick-card-head">
          <span class="rw-quick-step">02</span>
          <div>
            <strong>今日收益</strong>
            <p>只填今天赚了多少，本金和收益率自动计算。</p>
          </div>
        </div>
        <EntryForm
          ref="dailyRef"
          :dashboard="dashboard"
          compact
          @saved="handleRecordSaved"
        />
        <div class="rw-quick-meta">
          <span>{{ todayRecord ? '今日已记，可直接改' : '今天还没记' }}</span>
          <button type="button" class="rw-link-button" @click="dailyRef?.resetForm()">
            补记其他日期
          </button>
        </div>
      </section>

      <section class="rw-quick-card">
        <div class="rw-quick-card-head">
          <span class="rw-quick-step">03</span>
          <div>
            <strong>特殊事项</strong>
            <p>额度变化、费率调整、赎回异常等，写一句就交给 AI 跟进。</p>
          </div>
        </div>
        <form class="rw-case-form" @submit.prevent="saveSpecialCase">
          <div class="rw-case-row">
            <label>
              <span>日期</span>
              <input v-model="specialCase.date" type="date" :max="today" required />
            </label>
            <label>
              <span>类型</span>
              <select v-model="specialCase.event_type">
                <option v-for="type in caseTypes" :key="type" :value="type">{{ type }}</option>
              </select>
            </label>
            <label>
              <span>影响</span>
              <select v-model="specialCase.impact">
                <option v-for="level in caseImpacts" :key="level" :value="level">{{ level }}</option>
              </select>
            </label>
          </div>
          <label>
            <span>产品（可不填）</span>
            <input
              v-model="specialCase.product_name"
              type="text"
              maxlength="100"
              placeholder="不填则记为「组合」"
            />
          </label>
          <label>
            <span>发生了什么</span>
            <textarea
              v-model="specialCase.description"
              rows="3"
              maxlength="500"
              placeholder="例如：某产品额度临时关闭，明天再看；赎回晚到账 1 天…"
              required
            ></textarea>
          </label>
          <button class="rw-button" type="submit" :disabled="savingCase">
            {{ savingCase ? '提交中…' : '提交给 AI' }}
          </button>
        </form>
      </section>
    </div>

    <p class="rw-quick-foot">
      待确认交易合计
      <strong>¥{{ formatMoney(tradeSummary?.pending_buy_amount ?? 0, 0) }}</strong>
      ，确认份额后自动进入持仓、评估和月度复盘。
    </p>
  </section>
</template>
