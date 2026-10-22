<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import EntryForm from '@/components/EntryForm.vue'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import { formatDateShort } from '@/composables/useFormatters'
import type {
  AutomationWorkspace,
  DashboardPayload,
  IncomeInboxItem,
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

interface IncomeDraft {
  date: string
  daily_pnl: number | null
  action: '无操作' | '买入' | '赎回' | '切换'
  notes: string
  products: Array<{
    product_code: string
    product_name: string
    holding_amount: number | null
    yield_date: string
    credit_date: string
    daily_pnl: number | null
    confidence: number
    notes: string
  }>
}

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
const manualDetailsRef = ref<HTMLDetailsElement | null>(null)
const tradeFileInput = ref<HTMLInputElement | null>(null)
const incomeFileInput = ref<HTMLInputElement | null>(null)
const tradeDragActive = ref(false)
const incomeDragActive = ref(false)
const uploadingTrade = ref(false)
const uploadingIncome = ref(false)
const savingCase = ref(false)
const applyingIncomeId = ref<number | null>(null)
const incomeDrafts = reactive<Record<number, IncomeDraft>>({})

const today = computed(() => props.dashboard.meta.today)
const reportingDate = computed(
  () => props.dashboard.meta.reporting_date || props.dashboard.meta.today,
)
const tradeInbox = computed(() => props.workspace.trades?.inbox ?? [])
const pendingTradeScreenshots = computed(() =>
  tradeInbox.value.filter((item) => item.status === 'pending'),
)
const incomeInbox = computed(() => props.workspace.income_inbox ?? [])
const pendingIncomeScreenshots = computed(() =>
  incomeInbox.value.filter((item) => item.status === 'pending'),
)
const inboxSummary = computed(() => props.dashboard.inbox_center.summary)
const remainingWork = computed(() => props.dashboard.inbox_center.pending.slice(0, 5))

const caseTypes: ProductEventType[] = ['额度', '费率', '赎回规则', '经理', '底层', '其他']
const caseImpacts: ProductEventImpact[] = ['低', '中', '高']

const specialCase = reactive({
  date: today.value,
  product_name: '',
  event_type: '额度' as ProductEventType,
  impact: '中' as ProductEventImpact,
  description: '',
})

watch(
  () => incomeInbox.value,
  (items) => {
    for (const item of items) {
      if (!incomeDrafts[item.id]) {
        incomeDrafts[item.id] = {
          date: item.parsed.date || item.record_date || reportingDate.value,
          daily_pnl:
            item.parsed.daily_pnl === null || item.parsed.daily_pnl === undefined
              ? null
              : Number(item.parsed.daily_pnl),
          action: item.parsed.action || '无操作',
          notes: item.parsed.notes || '',
          products: (item.parsed.products || []).map((product) => ({
            product_code: product.product_code,
            product_name: product.product_name || '',
            holding_amount:
              product.holding_amount === null ||
              product.holding_amount === undefined
                ? null
                : Number(product.holding_amount),
            yield_date: product.yield_date || item.parsed.date || item.record_date || reportingDate.value,
            credit_date:
              product.credit_date ||
              item.parsed.credit_date ||
              item.parsed.date ||
              item.record_date ||
              reportingDate.value,
            daily_pnl:
              product.daily_pnl === null || product.daily_pnl === undefined
                ? null
                : Number(product.daily_pnl),
            confidence: Number(product.confidence ?? item.parse_confidence),
            notes: product.notes || '',
          })),
        }
      }
    }
  },
  { immediate: true },
)

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

function validImage(file: File): boolean {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    show(`${file.name} 不是 PNG/JPEG/WebP 图片`, { error: true })
    return false
  }
  if (file.size > 10 * 1024 * 1024) {
    show(`${file.name} 超过 10 MB`, { error: true })
    return false
  }
  return true
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
    status: parsed.status === 'confirmed' ? 'confirmed' : 'pending',
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

async function uploadTradeFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files)
  if (!list.length) return
  uploadingTrade.value = true
  for (const file of list) {
    if (!validImage(file)) continue
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
          ? `${file.name} 已自动入账；平台已匹配已采纳提案或建立计划外决策，并继续审计`
          : `${file.name} 已交给平台；只有识别歧义才会进入消息中心`,
        applied ? { duration: 7000 } : { duration: 6000 },
      )
      emit('saved', today.value)
    } catch (error) {
      show(error instanceof Error ? error.message : '上传失败', { error: true })
    }
  }
  uploadingTrade.value = false
  if (tradeFileInput.value) tradeFileInput.value.value = ''
}

async function uploadIncomeFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files)
  if (!list.length) return
  uploadingIncome.value = true
  for (const file of list) {
    if (!validImage(file)) continue
    try {
      const data = await readAsDataUrl(file)
      const response = await store.uploadIncomeScreenshot({
        filename: file.name,
        mime: file.type,
        data,
      })
      if (response.duplicate) {
        show(`${file.name} 已处理过，平台不会重复记账`)
      } else if (response.income_conflict) {
        show(
          `${file.name} 与 ${response.income_conflict.date} 已有收益 ¥${Number(
            response.income_conflict.existing_daily_pnl,
          ).toFixed(2)} 不一致；未覆盖，已转消息中心人工确认`,
          { error: true, duration: 8000 },
        )
      } else if (response.income_ignored) {
        show(`${file.name} 对应日期已有相同收益，本次已忽略`)
      } else if (response.auto_applied) {
        const savedCount = response.saved_valuations?.length ?? 0
        const mismatch = response.reconciliation?.status === 'mismatch'
        show(
          mismatch
            ? `${file.name} 已记录账户与 ${savedCount} 只产品收益；产品合计与总账不一致，已转入对账提醒`
            : `${file.name} 已自动记录 ${response.record?.date ?? ''} 收益 ¥${Number(
                response.record?.daily_pnl ?? 0,
              ).toFixed(2)}${savedCount ? `，含 ${savedCount} 只产品明细` : ''}`,
          mismatch ? { duration: 7000 } : undefined,
        )
      } else {
        show(
          response.ocr?.ok
            ? `${file.name} 已交给平台；识别有歧义，可在消息中心核对`
            : `${file.name} 已保存；本地 OCR 未读到收益，可在下方补正`,
          { duration: 6500 },
        )
      }
      if (response.record?.date) emit('saved', response.record.date)
      else emit('saved', reportingDate.value)
    } catch (error) {
      show(error instanceof Error ? error.message : '上传失败', { error: true })
    }
  }
  uploadingIncome.value = false
  if (incomeFileInput.value) incomeFileInput.value.value = ''
}

function onTradeDrop(event: DragEvent): void {
  tradeDragActive.value = false
  if (event.dataTransfer?.files?.length) void uploadTradeFiles(event.dataTransfer.files)
}

function onIncomeDrop(event: DragEvent): void {
  incomeDragActive.value = false
  if (event.dataTransfer?.files?.length) void uploadIncomeFiles(event.dataTransfer.files)
}

async function applyIncome(item: IncomeInboxItem): Promise<void> {
  const draft = incomeDrafts[item.id]
  if (!draft || draft.daily_pnl === null || !draft.date) {
    show('请先确认日期和收益数字', { error: true })
    return
  }
  const incompleteProduct = draft.products.find(
    (product) =>
      !product.product_code.trim() ||
      product.daily_pnl === null ||
      !product.yield_date ||
      !product.credit_date,
  )
  if (incompleteProduct) {
    show('产品明细需要代码、收益归属日、到账/可见日和收益；无法确认的行可先移除', {
      error: true,
    })
    return
  }
  applyingIncomeId.value = item.id
  try {
    const response = await store.applyIncomeScreenshot(item.id, draft)
    const savedCount = response.saved_valuations?.length ?? 0
    const mismatch = response.reconciliation?.status === 'mismatch'
    show(
      response.conflict
        ? `${response.conflict.date} 已有收益 ¥${Number(
            response.conflict.existing_daily_pnl,
          ).toFixed(2)}，本次 ¥${Number(
            response.conflict.incoming_daily_pnl,
          ).toFixed(2)}；未覆盖，已生成人工确认提醒`
        : response.ignored
        ? '该日期收益已存在且金额一致，本次已忽略'
        : mismatch
        ? `截图已入账；${savedCount} 只产品收益合计与账户总账不一致，已进入对账提醒`
        : response.overwritten
        ? '已用收益截图更新这笔记录'
        : response.matched_existing
          ? '截图已归档；该日期已有记录，平台没有覆盖'
          : `收益截图已入账${savedCount ? `，同步 ${savedCount} 只产品明细` : ''}`,
      mismatch ? { duration: 7000 } : undefined,
    )
    emit('saved', draft.date)
  } catch (error) {
    show(error instanceof Error ? error.message : '入账失败', { error: true })
  } finally {
    applyingIncomeId.value = null
  }
}

async function ignoreIncome(item: IncomeInboxItem): Promise<void> {
  if (!window.confirm('忽略这张收益截图？原图会保留到定期清理。')) return
  applyingIncomeId.value = item.id
  try {
    await store.ignoreIncomeScreenshot(item.id)
    show('收益截图已忽略')
  } catch (error) {
    show(error instanceof Error ? error.message : '操作失败', { error: true })
  } finally {
    applyingIncomeId.value = null
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
    show('特殊情况已交给 AI 跟进')
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

async function startRecord(date: string): Promise<void> {
  if (manualDetailsRef.value) manualDetailsRef.value.open = true
  await nextTick()
  dailyRef.value?.startRecord(date)
}

async function loadRecordForEdit(date: string): Promise<void> {
  if (manualDetailsRef.value) manualDetailsRef.value.open = true
  await nextTick()
  dailyRef.value?.loadRecordForEdit(date)
}

defineExpose({
  startRecord,
  loadRecordForEdit,
  resetForm: () => dailyRef.value?.resetForm(),
  isEditingDate: (date: string) => dailyRef.value?.isEditingDate(date) ?? false,
})
</script>

<template>
  <section class="rw-quick" aria-labelledby="rwQuickTitle">
    <div class="rw-quick-head">
      <div>
        <p class="kicker">ONLY TWO UPLOADS</p>
        <h3 id="rwQuickTitle">你只做两件事：买入 / 赎回，上传交易与收益截图</h3>
        <p>
          交易入账、持仓维护、追踪和复盘由平台自动完成。图片看不到你的原始决策理由，
          自动建临时决策后只需补齐一次关键证据；消息中心只保留真正需要你处理的例外。
        </p>
      </div>
      <span class="rw-quick-badge">
        待处理 {{ inboxSummary.pending_count }}
      </span>
    </div>

    <div class="income-capture-layout">
      <section id="capture-trade" class="rw-quick-card capture-card r2-anchor">
        <div class="rw-quick-card-head">
          <span class="rw-quick-step">01</span>
          <div>
            <strong>交易截图</strong>
            <p>完成买入、赎回或切换后上传成交截图。高置信度交易会直接进入持仓。</p>
          </div>
        </div>
        <div
          class="rw-dropzone is-compact"
          :class="{ 'is-active': tradeDragActive, 'is-busy': uploadingTrade }"
          role="button"
          tabindex="0"
          @click="tradeFileInput?.click()"
          @keydown.enter.prevent="tradeFileInput?.click()"
          @keydown.space.prevent="tradeFileInput?.click()"
          @dragover.prevent="tradeDragActive = true"
          @dragleave.prevent="tradeDragActive = false"
          @drop.prevent="onTradeDrop"
        >
          <strong>{{ uploadingTrade ? '平台正在识别…' : '拖入成交截图' }}</strong>
          <span>PNG / JPEG / WebP，单张不超过 10 MB</span>
        </div>
        <input
          ref="tradeFileInput"
          class="rw-file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          @change="uploadTradeFiles(($event.target as HTMLInputElement).files || [])"
        />
        <div class="rw-quick-meta">
          <span>
            待平台处理 {{ pendingTradeScreenshots.length }} 张 · 待确认交易
            {{ inboxSummary.by_source.pending_trade?.pending ?? 0 }} 笔
          </span>
          <div class="capture-status-actions">
            <button
              type="button"
              class="rw-link-button"
              @click="emit('open-module', 'decisions')"
            >
              交易前先写决策
            </button>
            <RouterLink class="rw-link-button" to="/ledger/trades#inbox">
              查看交易收件箱
            </RouterLink>
          </div>
        </div>
      </section>

      <section id="capture-income" class="rw-quick-card capture-card r2-anchor">
        <div class="rw-quick-card-head">
          <span class="rw-quick-step">02</span>
          <div>
            <strong>收益截图</strong>
            <p>
              上传招行收益页截图。平台按识别到的收益日期先核对是否已有记录和金额，再决定记录、忽略或提醒。
            </p>
          </div>
        </div>
        <div
          class="rw-dropzone is-compact"
          :class="{ 'is-active': incomeDragActive, 'is-busy': uploadingIncome }"
          role="button"
          tabindex="0"
          @click="incomeFileInput?.click()"
          @keydown.enter.prevent="incomeFileInput?.click()"
          @keydown.space.prevent="incomeFileInput?.click()"
          @dragover.prevent="incomeDragActive = true"
          @dragleave.prevent="incomeDragActive = false"
          @drop.prevent="onIncomeDrop"
        >
          <strong>{{ uploadingIncome ? '平台正在识别…' : '拖入收益截图' }}</strong>
          <span>平台会识别收益、截图日期和逐产品归属日</span>
        </div>
        <input
          ref="incomeFileInput"
          class="rw-file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          @change="uploadIncomeFiles(($event.target as HTMLInputElement).files || [])"
        />
        <div class="rw-quick-meta">
          <span>
            {{ reportingDate }} 最近披露提醒 · 收益日期以你确认为准
            {{ dashboard.meta.has_reporting_record ? '已自动记录' : '等待截图' }}
            · 待核 {{ pendingIncomeScreenshots.length }} 张
          </span>
          <button
            v-if="pendingIncomeScreenshots.length"
            type="button"
            class="rw-link-button"
            @click="incomeFileInput?.click()"
          >
            继续上传
          </button>
        </div>
      </section>
    </div>

    <div class="capture-status-strip">
      <div>
        <span>平台自动完成</span>
        <strong>交易入账 · 临时决策 · 持仓维护 · 每日追踪 · 自动评估 · 月季复盘</strong>
      </div>
      <div class="capture-status-actions">
        <span class="capture-count">
          {{ inboxSummary.pending_count }} 项待处理 · {{ inboxSummary.reminder_count }}
          项提醒 · {{ inboxSummary.unread_count }} 项未读
        </span>
        <RouterLink class="button button-ghost button-small" to="/ledger/inbox">
          打开消息中心
        </RouterLink>
      </div>
    </div>

    <div v-if="remainingWork.length" class="capture-exceptions">
      <div class="capture-exceptions-head">
        <strong>平台需要你补充的事实</strong>
        <span>只有这些例外需要你查看；其余工作已在后台自动完成。</span>
      </div>
      <RouterLink
        v-for="item in remainingWork"
        :key="item.id"
        :to="item.action_url"
        class="capture-exception-row"
        :class="`is-${item.severity}`"
      >
        <span>{{ item.source_label }}</span>
        <strong>{{ item.title }}</strong>
        <small>{{ item.summary }}</small>
        <em>{{ item.action_label }} →</em>
      </RouterLink>
    </div>

    <section v-if="pendingIncomeScreenshots.length" class="income-correction">
      <div class="capture-exceptions-head">
        <strong>收益截图识别补正</strong>
        <span>平台已尽量自动识别；只有数字或日期不确定时才需要确认。</span>
      </div>
      <article
        v-for="item in pendingIncomeScreenshots"
        :key="item.id"
        class="income-correction-card"
      >
        <div class="income-correction-meta">
          <strong>{{ item.original_name || `收益截图 #${item.id}` }}</strong>
          <span>
            {{ formatDateShort(item.received_at.slice(0, 10)) }} · 识别
            {{ item.parse_confidence }}%
            <template v-if="item.error"> · {{ item.error }}</template>
          </span>
          <small v-if="item.parsed.warnings?.length">
            {{ item.parsed.warnings.join('、') }}
          </small>
        </div>
        <div v-if="incomeDrafts[item.id]?.products.length" class="income-product-editor">
          <div class="income-product-head">
            <strong>产品明细</strong>
            <span>产品收益只进个人档案，不重复计入账户总收益</span>
          </div>
          <div
            v-for="(product, index) in incomeDrafts[item.id].products"
            :key="`${item.id}-${product.product_code}-${index}`"
            class="income-product-row"
          >
            <label>
              <span>产品代码</span>
              <input v-model.trim="product.product_code" type="text" maxlength="32" />
            </label>
            <label class="is-name">
              <span>产品名称</span>
              <input v-model.trim="product.product_name" type="text" maxlength="100" />
            </label>
            <label>
              <span>当日持仓金额</span>
              <input v-model.number="product.holding_amount" type="number" min="0" step="0.01" />
            </label>
            <label>
              <span>当日收益</span>
              <input v-model.number="product.daily_pnl" type="number" step="0.01" />
            </label>
            <label>
              <span>收益归属日</span>
              <input v-model="product.yield_date" type="date" :max="today" />
            </label>
            <label>
              <span>到账/可见日</span>
              <input v-model="product.credit_date" type="date" :max="today" />
            </label>
            <button
              type="button"
              class="rw-link-button is-danger"
              @click="incomeDrafts[item.id].products.splice(index, 1)"
            >
              移除
            </button>
          </div>
        </div>
        <p v-else class="income-product-empty">
          本次截图没有可确认的产品明细，只会记录账户总收益；当前持仓会标记为“本次未拍到”，不会自动记 0 或视为赎回。
        </p>
        <div class="income-correction-form">
          <label>
            <span>截图披露日</span>
            <input v-model="incomeDrafts[item.id].date" type="date" :max="today" />
          </label>
          <label>
            <span>账户披露收益</span>
            <input
              v-model.number="incomeDrafts[item.id].daily_pnl"
              type="number"
              step="0.01"
            />
          </label>
          <button
            type="button"
            class="rw-button"
            :disabled="applyingIncomeId === item.id"
            @click="applyIncome(item)"
          >
            自动入账
          </button>
          <button
            type="button"
            class="rw-link-button is-danger"
            :disabled="applyingIncomeId === item.id"
            @click="ignoreIncome(item)"
          >
            忽略
          </button>
        </div>
      </article>
    </section>

    <details ref="manualDetailsRef" class="capture-manual">
      <summary>例外情况下手工维护</summary>
      <div class="capture-manual-grid">
        <section>
          <h4>手工修正某天收益</h4>
          <EntryForm
            ref="dailyRef"
            :dashboard="dashboard"
            compact
            @saved="handleRecordSaved"
          />
        </section>
        <section>
          <h4>补充平台看不到的事实</h4>
          <form class="rw-case-form" @submit.prevent="saveSpecialCase">
            <div class="rw-case-row">
              <label>
                <span>日期</span>
                <input v-model="specialCase.date" type="date" :max="today" required />
              </label>
              <label>
                <span>类型</span>
                <select v-model="specialCase.event_type">
                  <option v-for="type in caseTypes" :key="type" :value="type">
                    {{ type }}
                  </option>
                </select>
              </label>
              <label>
                <span>影响</span>
                <select v-model="specialCase.impact">
                  <option v-for="level in caseImpacts" :key="level" :value="level">
                    {{ level }}
                  </option>
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
                placeholder="只填截图中看不到、但会影响判断的事实"
                required
              ></textarea>
            </label>
            <button class="rw-button" type="submit" :disabled="savingCase">
              {{ savingCase ? '提交中…' : '交给平台跟踪' }}
            </button>
          </form>
        </section>
      </div>
    </details>
  </section>
</template>
