<script setup lang="ts">
import { RouterLink, useRoute, type LocationQueryRaw } from 'vue-router'

const props = defineProps<{
  items: { key: string; label: string; meta?: string; query?: LocationQueryRaw }[]
  active: string
  label: string
}>()
const route = useRoute()

function target(item: { key: string; query?: LocationQueryRaw }) {
  return {
    path: route.path,
    query: {
      ...route.query,
      notice: undefined,
      view: undefined,
      ...(item.query || {}),
      section: item.key,
    },
    hash: '',
  }
}
</script>
<template>
  <nav class="workspace-nav" :aria-label="label">
    <RouterLink
      v-for="item in props.items"
      :key="item.key"
      :data-section="item.key"
      :aria-current="active === item.key ? 'page' : undefined"
      :to="target(item)"
    >
      {{ item.label }}
      <span v-if="item.meta" class="workspace-nav-meta">{{ item.meta }}</span>
    </RouterLink>
  </nav>
</template>
<style scoped>
.workspace-nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px;
  width: fit-content;
  max-width: 100%;
  margin: 0 0 20px;
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--card-soft);
  box-shadow: 0 1px 2px rgba(13, 60, 52, 0.04);
}

a {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 0 15px;
  border: 1px solid transparent;
  border-radius: 11px;
  color: var(--ink-soft);
  text-decoration: none;
  font-size: 13.5px;
  font-weight: 650;
  letter-spacing: 0.01em;
  transition:
    color 160ms ease,
    border-color 160ms ease,
    background 160ms ease,
    box-shadow 160ms ease;
}

a:hover {
  border-color: var(--line);
  background: var(--card);
  color: var(--green);
}

a[aria-current] {
  border-color: rgba(var(--green-rgb), 0.26);
  background: var(--card);
  color: var(--green-deep);
  box-shadow: 0 2px 8px rgba(13, 60, 52, 0.08);
}

a[aria-current]::before {
  content: '';
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 999px;
  background: currentColor;
  box-shadow: 0 0 0 4px var(--green-wash);
}

a:focus-visible {
  outline: 2px solid var(--green);
  outline-offset: 2px;
}

.workspace-nav-meta {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--green-wash);
  color: var(--green);
  font-size: 12px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

a[aria-current] .workspace-nav-meta {
  background: var(--green-soft);
  color: var(--green-deep);
}
</style>
