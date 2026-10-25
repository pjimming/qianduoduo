<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useDashboardStore } from '@/stores/dashboard'
import { useToast } from '@/composables/useToast'
import { formatMoney } from '@/composables/useFormatters'
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

const activeProposals = computed(() => [
  ...props.proposals.pending,
  ...props.proposals.accepted,
])

async function adopt(proposal: DecisionProposal): Promise<void> {
  if (
    !window.confirm(
      `采纳提案「${proposal.title}」？\n采纳后仍需你在招行 App 自行执行并上传成交截图。`,
    )
  ) {
    return
  }
  busyId.value = proposal.id
  try {
    const result = await store.adoptDecisionProposal(proposal.id)
    show(
      `提案已采纳，决策 #${result.result.decision?.id ?? ''} 进入待执行状态`,
    )
  } catch (error) {
    show(error instanceof Error ? error.message : '采纳失败', { error: true })
  } finally {
    busyId.value = null
  }
}

async function reject(proposal: DecisionProposal): Promise<void> {
  const reason =
    window.prompt(
      `${proposal.status === 'accepted' ? '取消采纳' : '拒绝'}原因（可留空）`,
      '当前不接受该收益、期限或流动性取舍。',
    ) ??
    ''
  busyId.value = proposal.id
  try {
    await store.rejectDecisionProposal(proposal.id, reason)
    show('提案已拒绝，不会生成正式决策')
  } catch (error) {
    show(error instanceof Error ? error.message : '拒绝失败', { error: true })
  } finally {
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
        <p class="kicker">DECISION PROPOSALS</p>
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
              :disabled="busyId === proposal.id"
              @click="adopt(proposal)"
            >
              采纳，待我执行
            </button>
            <button
              type="button"
              class="rw-link-button is-danger"
              :disabled="busyId === proposal.id"
              @click="reject(proposal)"
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
            v-if="proposal.status === 'accepted'"
            type="button"
            class="rw-link-button is-danger"
            :disabled="busyId === proposal.id"
            @click="reject(proposal)"
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
  </div>
</template>
