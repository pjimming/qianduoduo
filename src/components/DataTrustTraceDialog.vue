<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDashboardStore } from '@/stores/dashboard'
import type {
  DataTrustEvidenceEvent,
  DataTrustEvidenceLink,
  DataTrustFactTrace,
  DataTrustRevision,
} from '@/types/dashboard'

const props = defineProps<{
  open: boolean
  factType: string
  factKey: string
  title: string
}>()

const emit = defineEmits<{
  close: []
}>()

const store = useDashboardStore()
const loading = ref(false)
const error = ref('')
const trace = ref<DataTrustFactTrace | null>(null)

const evidenceItems = computed<DataTrustEvidenceLink[]>(() => {
  const seen = new Set<number>()
  return (trace.value?.evidence_links || []).filter((item) => {
    if (seen.has(item.evidence_id)) return false
    seen.add(item.evidence_id)
    return true
  })
})

const statusLabel = computed(() => {
  return {
    complete: '证据完整',
    partial: '证据部分缺失',
    incomplete: '证据不完整',
  }[trace.value?.evidence_status || 'incomplete']
})

const statusClass = computed(() => {
  return `is-${trace.value?.evidence_status || 'incomplete'}`
})

function eventLabel(type: string): string {
  return {
    received: '接收原图',
    duplicate_received: '重复上传',
    ocr_completed: 'OCR 识别',
    machine_parsed: '机器解析',
    vision_parsed: '视觉识别',
    human_corrected: '人工校正',
    version_selected: '选择采用版本',
    state_changed: '流程状态变化',
    conflict_detected: '发现冲突',
    posted: '正式入账',
    ignored: '已忽略',
    failed: '处理失败',
    reopened: '重新打开',
    legacy_snapshot: '历史迁移快照',
  }[type] || type
}

function actionLabel(action: DataTrustRevision['action']): string {
  return {
    create: '创建',
    update: '更新',
    delete: '删除',
    confirm: '确认',
    cancel: '撤销',
    recalculate: '重算',
  }[action]
}

function formatTime(value: string): string {
  if (!value) return '—'
  return value.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z').slice(0, 19)
}

function textValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function eventText(event: DataTrustEvidenceEvent): string {
  const payload = event.payload || {}
  if (event.event_type === 'ocr_completed') {
    return textValue(payload.text || payload.error).slice(0, 500)
  }
  if (event.event_type === 'human_corrected') {
    return textValue(payload.reason || payload.after).slice(0, 500)
  }
  if (event.event_type === 'state_changed') {
    return `${textValue(payload.from_state)} → ${textValue(
      payload.to_state,
    )} · ${textValue(payload.reason)}`
  }
  if (event.event_type === 'failed') {
    return `${textValue(payload.stage)} · ${textValue(payload.error)}`
  }
  if (event.event_type === 'legacy_snapshot') {
    return textValue(payload.message || '历史状态快照')
  }
  return textValue(payload).slice(0, 500)
}

function changedSummary(revision: DataTrustRevision): string {
  if (!revision.changed_fields.length) return '无字段变化'
  return revision.changed_fields.join('、')
}

async function loadTrace(): Promise<void> {
  if (!props.open || !props.factType || !props.factKey) return
  loading.value = true
  error.value = ''
  trace.value = null
  try {
    trace.value = await store.loadFactTrace(props.factType, props.factKey)
  } catch (caught) {
    error.value =
      caught instanceof Error ? caught.message : '来源与修订加载失败'
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.open, props.factType, props.factKey],
  () => {
    void loadTrace()
  },
  { immediate: true },
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dt-overlay"
      role="presentation"
      @click.self="emit('close')"
    >
      <section
        class="dt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dataTrustTitle"
      >
        <header class="dt-head">
          <div>
            <p class="dt-kicker">SOURCE & REVISIONS</p>
            <h2 id="dataTrustTitle">{{ title }}</h2>
            <p>{{ factType }} · {{ factKey }}</p>
          </div>
          <button
            type="button"
            class="dt-close"
            aria-label="关闭来源与修订"
            @click="emit('close')"
          >
            ×
          </button>
        </header>

        <div v-if="loading" class="dt-state">正在加载来源与修订…</div>
        <div v-else-if="error" class="dt-state is-error">{{ error }}</div>
        <div v-else-if="trace" class="dt-body">
          <div class="dt-summary">
            <span class="dt-status" :class="statusClass">{{ statusLabel }}</span>
            <span>{{ trace.revisions.length }} 个修订版本</span>
            <span>{{ trace.evidence_links.length }} 条证据链接</span>
          </div>

          <section class="dt-section">
            <div class="dt-section-head">
              <h3>原始证据与解析</h3>
              <span>{{ evidenceItems.length }} 项证据</span>
            </div>
            <div v-if="evidenceItems.length" class="dt-evidence-list">
              <article
                v-for="link in evidenceItems"
                :key="link.evidence_id"
                class="dt-evidence"
              >
                <div class="dt-evidence-head">
                  <div>
                    <strong>{{ link.evidence?.original_name || '未命名证据' }}</strong>
                    <span>
                      {{ link.evidence?.evidence_type || '证据' }} ·
                      {{ link.evidence?.available ? '原图可读' : '原图不可读' }}
                    </span>
                  </div>
                  <code>{{ link.evidence?.sha256?.slice(0, 16) || '—' }}…</code>
                </div>
                <img
                  v-if="link.evidence_trace?.source?.image_url && link.evidence?.available"
                  :src="link.evidence_trace.source.image_url"
                  :alt="link.evidence?.original_name || '原始截图'"
                  loading="lazy"
                />
                <div class="dt-event-list">
                  <details
                    v-for="event in link.evidence_trace?.events || []"
                    :key="event.id"
                    :open="['human_corrected', 'failed', 'state_changed'].includes(event.event_type)"
                  >
                    <summary>
                      <span>{{ eventLabel(event.event_type) }}</span>
                      <time>{{ formatTime(event.created_at) }}</time>
                    </summary>
                    <p>{{ eventText(event) }}</p>
                    <small>
                      {{ event.actor_type }}
                      <template v-if="event.actor_ref"> · {{ event.actor_ref }}</template>
                      <template v-if="event.confidence !== null">
                        · 置信度 {{ event.confidence }}%
                      </template>
                    </small>
                  </details>
                </div>
              </article>
            </div>
            <div v-else class="dt-empty">
              该事实没有有效证据链接，当前只能查看正式值，不能还原银行原图或人工校正过程。
            </div>
          </section>

          <section class="dt-section">
            <div class="dt-section-head">
              <h3>事实修订历史</h3>
              <span>最新在前</span>
            </div>
            <div v-if="trace.revisions.length" class="dt-revisions">
              <article
                v-for="revision in trace.revisions"
                :key="revision.id"
                class="dt-revision"
              >
                <div class="dt-revision-head">
                  <strong>#{{ revision.revision_no }} · {{ actionLabel(revision.action) }}</strong>
                  <time>{{ formatTime(revision.created_at) }}</time>
                </div>
                <p>{{ revision.reason || '未填写修订原因' }}</p>
                <div class="dt-meta">
                  <span>{{ revision.source_class }}</span>
                  <span>{{ revision.actor_type }}</span>
                  <span>{{ changedSummary(revision) }}</span>
                </div>
                <details>
                  <summary>查看前后值与请求键</summary>
                  <div class="dt-json-grid">
                    <div>
                      <b>修改前</b>
                      <pre>{{ JSON.stringify(revision.before, null, 2) }}</pre>
                    </div>
                    <div>
                      <b>修改后</b>
                      <pre>{{ JSON.stringify(revision.after, null, 2) }}</pre>
                    </div>
                  </div>
                  <small>
                    {{ revision.operation_id }}
                    <template v-if="revision.related_fact_key">
                      · 关联 {{ revision.related_fact_key }}
                    </template>
                  </small>
                </details>
              </article>
            </div>
            <div v-else class="dt-empty">还没有事实修订记录。</div>
          </section>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.dt-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(20, 32, 28, 0.56);
  backdrop-filter: blur(3px);
}

.dt-dialog {
  width: min(960px, 100%);
  max-height: min(88vh, 920px);
  overflow: auto;
  border: 1px solid #d8e2dc;
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 28px 80px rgba(20, 42, 33, 0.24);
  color: #22312b;
  font-size: 12px;
}

.dt-head {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  justify-content: space-between;
  gap: 18px;
  padding: 18px 20px;
  border-bottom: 1px solid #e7ede9;
  background: rgba(255, 255, 255, 0.97);
}

.dt-head h2,
.dt-head p,
.dt-section h3,
.dt-evidence p,
.dt-revision p {
  margin: 0;
}

.dt-head h2 {
  font-size: 18px;
}

.dt-head p:not(.dt-kicker) {
  margin-top: 4px;
  color: #6a7771;
  font-size: 12px;
  word-break: break-all;
}

.dt-kicker {
  color: #2f7a59;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.dt-close {
  width: 34px;
  height: 34px;
  border: 1px solid #ccd8d2;
  border-radius: 50%;
  background: #fff;
  color: #405149;
  cursor: pointer;
  font-size: 22px;
  line-height: 1;
}

.dt-body {
  padding: 18px 20px 24px;
}

.dt-summary,
.dt-meta,
.dt-evidence-head,
.dt-section-head,
.dt-revision-head,
.dt-event-list summary {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dt-summary {
  flex-wrap: wrap;
  margin-bottom: 16px;
  color: #64716b;
}

.dt-summary > span:not(.dt-status),
.dt-meta > span {
  padding: 4px 8px;
  border-radius: 999px;
  background: #f2f6f4;
}

.dt-status {
  padding: 5px 9px;
  border-radius: 999px;
  font-weight: 700;
}

.dt-status.is-complete {
  background: #e7f7ee;
  color: #17613f;
}

.dt-status.is-partial,
.dt-status.is-incomplete {
  background: #fff3df;
  color: #8a5312;
}

.dt-section {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid #edf1ef;
}

.dt-section-head {
  justify-content: space-between;
  margin-bottom: 10px;
}

.dt-section h3 {
  font-size: 15px;
}

.dt-section-head > span {
  color: #6d7973;
}

.dt-evidence-list,
.dt-revisions {
  display: grid;
  gap: 10px;
}

.dt-evidence,
.dt-revision {
  padding: 12px;
  border: 1px solid #e1e9e4;
  border-radius: 12px;
  background: #fbfdfc;
}

.dt-evidence-head,
.dt-revision-head {
  justify-content: space-between;
}

.dt-evidence-head span,
.dt-revision time,
.dt-event-list time,
.dt-meta,
.dt-evidence small,
.dt-revision small {
  color: #6c7872;
}

.dt-evidence-head > div {
  display: grid;
  gap: 3px;
}

.dt-evidence code {
  color: #456458;
  font-size: 12px;
}

.dt-evidence img {
  display: block;
  width: min(100%, 420px);
  max-height: 300px;
  margin-top: 10px;
  border: 1px solid #dfe7e3;
  border-radius: 10px;
  object-fit: contain;
  background: #f5f8f6;
}

.dt-event-list {
  display: grid;
  gap: 6px;
  margin-top: 10px;
}

.dt-event-list details,
.dt-revision details {
  padding: 8px 10px;
  border: 1px solid #e6ece8;
  border-radius: 9px;
  background: #fff;
}

.dt-event-list summary,
.dt-revision summary {
  justify-content: space-between;
  cursor: pointer;
  font-weight: 600;
}

.dt-event-list p,
.dt-revision p {
  margin-top: 7px;
  line-height: 1.6;
  word-break: break-word;
}

.dt-meta {
  flex-wrap: wrap;
  margin-top: 8px;
}

.dt-json-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 8px 0;
}

.dt-json-grid b {
  display: block;
  margin-bottom: 4px;
}

.dt-json-grid pre {
  max-height: 220px;
  overflow: auto;
  margin: 0;
  padding: 8px;
  border-radius: 8px;
  background: #f4f7f5;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.dt-empty,
.dt-state {
  padding: 18px;
  border: 1px dashed #cfdad4;
  border-radius: 12px;
  color: #68756f;
  text-align: center;
}

.dt-state {
  margin: 20px;
}

.dt-state.is-error {
  border-color: #e4b9b4;
  background: #fff5f4;
  color: #9b332b;
}

@media (max-width: 720px) {
  .dt-overlay {
    padding: 0;
    align-items: end;
  }

  .dt-dialog {
    width: 100%;
    max-height: 94vh;
    border-radius: 18px 18px 0 0;
  }

  .dt-body {
    padding: 14px;
  }

  .dt-json-grid {
    grid-template-columns: 1fr;
  }
}
</style>
