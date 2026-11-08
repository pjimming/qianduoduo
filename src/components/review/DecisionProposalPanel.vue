<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import { formatMoney } from '@/composables/useFormatters'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import type {
  DecisionEntry,
  DecisionProposal,
  DecisionProposalWorkspace,
} from '@/types/dashboard'

const props = defineProps<{
  proposals: DecisionProposalWorkspace
  decisions: DecisionEntry[]
}>()

const store = useDashboardStore()
const { show } = useToast()
const busyId = ref<number | null>(null)
const pendingAction = ref<{
  kind: 'adopt' | 'reject' | 'cancel_remaining'
  proposal: DecisionProposal
} | null>(null)
const reason = ref('')
const submitting = ref(false)

const activeProposals = computed(() => [
  ...props.proposals.pending,
  ...props.proposals.accepted,
])

const dialogTitle = computed(() => {
  const action = pendingAction.value
  if (!action) return ''
  if (action.kind === 'adopt') return `采纳提案「${action.proposal.title}」？`
  if (action.kind === 'cancel_remaining') {
    return `取消「${action.proposal.title}」未执行余额？`
  }
  return action.proposal.status === 'accepted'
    ? `取消采纳「${action.proposal.title}」？`
    : `拒绝提案「${action.proposal.title}」？`
})
const dialogMessage = computed(() => {
  const action = pendingAction.value
  if (!action) return ''
  if (action.kind === 'adopt') {
    return '采纳后仍需你在招行 App 自行执行并上传成交截图；平台不会代你下单。'
  }
  if (action.kind === 'cancel_remaining') {
    return '只释放尚未执行的资金预留；已确认成交、决策、冻结预测和证据都会保留。'
  }
  return action.proposal.status === 'accepted'
    ? '取消后不会创建正式决策，原提案、证据和日志都会保留。'
    : '提案会标记为已拒绝，不会创建正式决策。原因可留空，取消不写入任何内容。'
})
const dialogConfirmLabel = computed(() => {
  const action = pendingAction.value
  if (!action) return '确认'
  if (action.kind === 'adopt') return '确认采纳'
  return action.kind === 'cancel_remaining'
    ? '确认取消剩余'
    : action.proposal.status === 'accepted'
      ? '确认取消采纳'
      : '确认拒绝'
})

function askAdopt(proposal: DecisionProposal): void {
  if (busyId.value !== null) return
  pendingAction.value = { kind: 'adopt', proposal }
  reason.value = ''
}

function askReject(proposal: DecisionProposal): void {
  if (busyId.value !== null) return
  pendingAction.value = { kind: 'reject', proposal }
  reason.value = ''
}

function askCancelRemaining(proposal: DecisionProposal): void {
  if (busyId.value !== null) return
  pendingAction.value = { kind: 'cancel_remaining', proposal }
  reason.value = ''
}

function isPartiallyExecuted(proposal: DecisionProposal): boolean {
  return String(decisionFor(proposal)?.review_meta?.execution_status || '') === 'partial'
}

function closeDialog(): void {
  if (submitting.value) return
  pendingAction.value = null
  reason.value = ''
}

async function confirmAction(): Promise<void> {
  const action = pendingAction.value
  if (!action || submitting.value) return
  submitting.value = true
  busyId.value = action.proposal.id
  try {
    if (action.kind === 'adopt') {
      const result = await store.adoptDecisionProposal(action.proposal.id)
      show(
        `提案已采纳，决策 #${result.result.decision?.id ?? ''} 进入待执行状态`,
      )
    } else if (action.kind === 'cancel_remaining') {
      const result = await store.cancelRemainingDecisionProposal(
        action.proposal.id,
        reason.value.trim(),
      )
      show(
        `已取消剩余 ¥${formatMoney(result.remaining_cents / 100, 2)}，释放预留 ¥${formatMoney(result.released_cents / 100, 2)}`,
      )
    } else {
      await store.rejectDecisionProposal(
        action.proposal.id,
        action.kind === 'reject' ? reason.value.trim() : '',
      )
      show(
        action.proposal.status === 'accepted'
          ? '已取消未执行计划，原决策和证据保留'
          : '提案已拒绝，未创建正式决策',
      )
    }
    pendingAction.value = null
    reason.value = ''
  } catch (error) {
    show(error instanceof Error ? error.message : '操作失败', { error: true })
  } finally {
    submitting.value = false
    busyId.value = null
  }
}

function decisionFor(proposal: DecisionProposal): DecisionEntry | null {
  return (
    props.decisions.find((decision) => decision.id === proposal.decision_id) ||
    null
  )
}

function executionLabel(proposal: DecisionProposal): string {
  const decision = decisionFor(proposal)
  const status = String(decision?.review_meta?.execution_status || '')
  return {
    pending: '已采纳，待执行',
    partial: '部分执行',
    executed: '已执行，待确认',
    confirmed: '交易已确认',
    deviation: '执行偏差',
    partial_cancelled: '已取消剩余',
    unplanned: '计划外执行',
  }[status] || proposal.status
}

function statusClass(proposal: DecisionProposal): string {
  const meta = decisionFor(proposal)?.review_meta || {}
  if (
    ['deviation'].includes(String(meta.execution_status || '')) ||
    ['review', 'amount-adjustment', 'deviation'].includes(
      String(meta.audit_status || ''),
    )
  ) {
    return 'is-warn'
  }
  if (proposal.status === 'accepted') return 'is-neutral'
  if (proposal.status === 'executed' || proposal.status === 'confirmed') {
    return 'is-good'
  }
  if (proposal.status === 'rejected' || proposal.status === 'expired') {
    return 'is-bad'
  }
  return 'is-warn'
}

function yieldEvidenceText(
  evidence: NonNullable<DecisionProposal['payload']['yield_policy']>['current'],
): string {
  if (!evidence) return '未获取'
  if (evidence.status === 'available') {
    const windows = evidence.available_horizons.join(' + ') || '—'
    return evidence.reason === 'partial_history'
      ? `部分历史 ${windows}`
      : `可用 ${windows}`
  }
  return {
    no_product_snapshot: '快照缺失',
    unknown_term: '期限未知',
    no_available_horizons: '指定窗口均缺失',
  }[String(evidence.reason)] || '不可计算'
}

function yieldPolicyText(proposal: DecisionProposal): string {
  const policy = proposal.payload.yield_policy
  if (!policy) return '收益口径未记录'
  const evidence = policy.candidate || policy.product || policy.current
  return `${policy.version} · ${evidence?.snapshot_date || policy.snapshot_date || '快照待核'} · ${yieldEvidenceText(evidence)}`
}
</script>

<template>
  <div class="rw-panel-body">
    <div class="rw-toolbar">
      <div class="rw-card-heading">
        <strong class="rw-panel-title">待采纳决策提案</strong>
        <p class="rw-panel-sub">
          平台只提出有证据的方案。采纳不会替你交易；你仍需在招行 App
          自行执行，再上传成交截图。
        </p>
      </div>
      <div class="rw-toolbar-actions">
        <span class="rw-stat-chip">
          待采纳 <strong>{{ proposals.summary.pending }}</strong>
        </span>
        <span class="rw-stat-chip">
          待执行 <strong>{{ proposals.summary.accepted }}</strong>
        </span>
      </div>
    </div>

    <div v-if="activeProposals.length === 0" class="rw-empty">
      当前没有待采纳或待执行的提案。出现可切换持仓或新增可分配资金时，提案会进入消息中心。
    </div>
    <div v-else class="rw-list">
      <article
        v-for="proposal in activeProposals"
        :key="proposal.id"
        class="rw-decision proposal-card"
      >
        <div class="rw-decision-head">
          <div class="rw-decision-title">
            <strong>{{ proposal.title }}</strong>
            <span class="rw-type-badge">{{ proposal.action }}</span>
            <span class="rw-rating" :class="statusClass(proposal)">
              {{ proposal.status === 'pending' ? '待采纳' : executionLabel(proposal) }}
            </span>
          </div>
          <span class="rw-muted">置信度 {{ proposal.confidence }}%</span>
        </div>
        <p class="rw-decision-reason">{{ proposal.summary }}</p>
        <div class="rw-decision-meta">
          <span>
            <em>产品</em>{{ proposal.product_code || '—' }}
            <template v-if="proposal.target_product_code">
              → {{ proposal.target_product_code }}
            </template>
          </span>
          <span><em>金额</em>¥{{ formatMoney(proposal.amount, 2) }}</span>
          <span><em>证据日</em>{{ proposal.evidence_date || '—' }}</span>
          <span data-testid="proposal-yield-policy">
            <em>收益口径</em>{{ yieldPolicyText(proposal) }}
          </span>
          <span><em>有效期</em>{{ proposal.expires_at || '—' }}</span>
          <span><em>验证日</em>{{ proposal.verify_date || '—' }}</span>
        </div>
        <div class="rw-row-actions">
          <template v-if="proposal.status === 'pending'">
            <button
              type="button"
              class="rw-button"
              data-testid="proposal-adopt"
              :disabled="busyId !== null"
              @click="askAdopt(proposal)"
            >
              采纳，待我执行
            </button>
            <button
              type="button"
              class="rw-link-button is-danger"
              data-testid="proposal-reject"
              :disabled="busyId !== null"
              @click="askReject(proposal)"
            >
              拒绝
            </button>
          </template>
          <RouterLink
            v-else
            class="rw-link-button"
            :to="{ name: 'r2-trades', hash: '#inbox' }"
          >
            上传成交截图
          </RouterLink>
          <button
            v-if="proposal.status === 'accepted' && isPartiallyExecuted(proposal)"
            type="button"
            class="rw-link-button is-danger"
            data-testid="proposal-cancel-remaining"
            :disabled="busyId !== null"
            @click="askCancelRemaining(proposal)"
          >
            取消剩余
          </button>
          <button
            v-else-if="proposal.status === 'accepted'"
            type="button"
            class="rw-link-button is-danger"
            data-testid="proposal-cancel"
            :disabled="busyId !== null"
            @click="askReject(proposal)"
          >
            取消采纳
          </button>
          <RouterLink
            class="rw-link-button"
            :to="{ name: 'r2-evaluation', hash: '#decisions' }"
          >
            查看决策日志
          </RouterLink>
        </div>
      </article>
    </div>

    <ConfirmDialog
      :open="pendingAction !== null"
      :title="dialogTitle"
      :message="dialogMessage"
      :confirm-label="dialogConfirmLabel"
      :danger="pendingAction?.kind !== 'adopt'"
      :busy="submitting"
      @confirm="confirmAction"
      @cancel="closeDialog"
    >
      <label v-if="pendingAction?.kind !== 'adopt'" class="proposal-reason">
        <span>原因（可留空）</span>
        <textarea
          v-model="reason"
          rows="3"
          maxlength="200"
          data-testid="proposal-reason"
          :placeholder="pendingAction?.kind === 'cancel_remaining'
            ? '例如：剩余金额不再执行，保留已确认成交。'
            : '例如：当前不接受该收益、期限或流动性取舍。'"
        />
      </label>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.rw-panel-sub,
.rw-muted,
.rw-decision-meta em {
  color: var(--ink-soft);
}
.proposal-reason {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0 4px;
  font-size: 12px;
  color: var(--ink-soft);
}
.proposal-reason textarea {
  min-height: 72px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--card);
  color: var(--ink);
  font: inherit;
  font-size: 13px;
  padding: 8px 10px;
  resize: vertical;
}
.proposal-reason textarea:focus-visible {
  outline: 2px solid var(--green);
  outline-offset: 1px;
}
</style>
