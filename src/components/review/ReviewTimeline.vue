<script setup lang="ts">
import type { ReviewWorkspace, TimelineStatus } from '@/types/dashboard'

defineProps<{
  timeline: ReviewWorkspace['timeline']
}>()

const statusLabel: Record<TimelineStatus, string> = {
  done: '已完成',
  due: '该做了',
  overdue: '待补',
  upcoming: '未到时间',
}
</script>

<template>
  <div class="rw-timeline" aria-label="复盘节奏">
    <div
      v-for="node in timeline.nodes"
      :key="node.key"
      class="rw-node"
      :class="[`is-${node.status}`, { 'is-focus': node.key === timeline.focus }]"
    >
      <div class="rw-node-top">
        <span class="rw-node-label">{{ node.label }}</span>
        <span class="rw-node-cadence">{{ node.cadence }}</span>
      </div>
      <strong>{{ node.title }}</strong>
      <p>{{ node.detail }}</p>
      <span class="rw-node-status">
        {{ statusLabel[node.status] }}
        <em v-if="node.key === timeline.focus">现在</em>
      </span>
    </div>
  </div>
</template>
