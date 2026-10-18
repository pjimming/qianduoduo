<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import TechMapHighlight from '@/components/techmap/TechMapHighlight.vue'
import { firstReportForCompany } from '@/data/techMapReports'
import {
  groupColor,
  groupCompanyCount,
  groupLeafCount,
  leafSearchText,
  techMap,
  techMapNotes,
  techMapStats,
  techMapUsage,
  type TechGroup,
  type TechLeaf,
  type TechSub,
} from '@/data/techmap'

interface FilteredSub {
  sub: TechSub
  key: string
  leaves: TechLeaf[]
}

interface FilteredGroup {
  group: TechGroup
  color: string
  subs: FilteredSub[]
}

const searchInput = ref('')
const term = computed(() => searchInput.value.trim().toLowerCase())
const forceOpen = computed(() => term.value.length > 0)

function groupKey(group: TechGroup): string {
  return `group:${group.id}`
}

function subKey(group: TechGroup, sub: TechSub): string {
  return `sub:${group.id}:${sub.name}`
}

const openKeys = ref(
  new Set(
    techMap.groups.flatMap((group) => [
      groupKey(group),
      ...group.subs.map((sub) => subKey(group, sub)),
    ]),
  ),
)

const filteredGroups = computed<FilteredGroup[]>(() => {
  const needle = term.value
  const result: FilteredGroup[] = []

  for (const group of techMap.groups) {
    const groupMatches =
      !needle || group.name.toLowerCase().includes(needle) || group.desc.toLowerCase().includes(needle)
    const subs: FilteredSub[] = []

    for (const sub of group.subs) {
      const subMatches = Boolean(needle) && sub.name.toLowerCase().includes(needle)
      const leaves = sub.leaves.filter(
        (leaf) =>
          !needle ||
          groupMatches ||
          subMatches ||
          leafSearchText(group, sub, leaf).includes(needle),
      )
      if (leaves.length) {
        subs.push({ sub, key: subKey(group, sub), leaves })
      }
    }

    if (!needle || subs.length) {
      result.push({ group, color: groupColor(group), subs })
    }
  }

  return result
})

const matchedLeaves = computed(() =>
  filteredGroups.value.reduce(
    (total, group) =>
      total + group.subs.reduce((subTotal, sub) => subTotal + sub.leaves.length, 0),
    0,
  ),
)

const hitText = computed(() => {
  if (!term.value) return ''
  return `匹配 ${matchedLeaves.value} / ${techMapStats.leaves} 个细分方向`
})

function isOpen(key: string): boolean {
  return forceOpen.value || openKeys.value.has(key)
}

function toggle(key: string): void {
  const next = new Set(openKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  openKeys.value = next
}

function expandAll(): void {
  openKeys.value = new Set(
    techMap.groups.flatMap((group) => [
      groupKey(group),
      ...group.subs.map((sub) => subKey(group, sub)),
    ]),
  )
}

function showSkeleton(): void {
  openKeys.value = new Set(techMap.groups.map((group) => groupKey(group)))
}

function clearSearch(): void {
  searchInput.value = ''
}

function reportOf(code: string) {
  return firstReportForCompany(code)
}

function handleBeforePrint(): void {
  clearSearch()
  expandAll()
}

onMounted(() => window.addEventListener('beforeprint', handleBeforePrint))
onBeforeUnmount(() => window.removeEventListener('beforeprint', handleBeforePrint))

defineExpose({
  preparePrint() {
    clearSearch()
    expandAll()
  },
  restoreAfterPrint() {},
})
</script>

<template>
  <div class="tm-view tm-tree-view">
    <div class="tm-controlbar">
      <label class="tm-search">
        <input
          v-model="searchInput"
          type="search"
          placeholder="搜索：电子布 / CPO / 存储 / 中际旭创 / 机器人"
          autocomplete="off"
          aria-label="搜索科技图谱"
          @keydown.esc="clearSearch"
        />
        <button
          v-if="searchInput"
          class="tm-clear"
          type="button"
          aria-label="清空搜索"
          @click="clearSearch"
        >
          ×
        </button>
      </label>
      <div class="tm-btn-group">
        <button class="tm-btn" type="button" @click="expandAll">全部展开</button>
        <button class="tm-btn" type="button" @click="showSkeleton">只留骨架</button>
      </div>
      <span class="tm-hit" role="status" aria-live="polite">{{ hitText }}</span>
    </div>

    <div class="tm-tree-scroll">
      <div class="tm-tree-root">
        <span class="tm-tree-root-pill">A股科技</span>
        <span class="tm-tree-root-meta">
          {{ techMapStats.groups }} 大门类 · {{ techMapStats.subs }} 个子行业 ·
          {{ techMapStats.leaves }} 个细分方向 · {{ techMapStats.companies }} 家代表公司 ·
          小字为证券代码
        </span>
      </div>

      <p v-if="!filteredGroups.length" class="tm-empty">没有匹配的方向，试试公司简称或板块关键词。</p>

      <section
        v-for="entry in filteredGroups"
        :key="entry.group.id"
        class="tm-tree-group"
        :style="{ '--node-color': entry.color }"
      >
        <div class="tm-tree-heading">
          <button
            class="tm-tree-toggle"
            type="button"
            :aria-expanded="isOpen(groupKey(entry.group))"
            :aria-label="`展开或折叠 ${entry.group.name}`"
            @click="toggle(groupKey(entry.group))"
          >
            <span></span>
          </button>
          <span class="tm-tree-group-name">{{ entry.group.name }}</span>
          <span class="tm-tree-meta">
            {{ entry.group.subs.length }} 个子行业 · {{ groupLeafCount(entry.group) }} 个方向 ·
            {{ groupCompanyCount(entry.group) }} 家公司
          </span>
        </div>
        <p class="tm-tree-desc">{{ entry.group.desc }}</p>

        <div v-show="isOpen(groupKey(entry.group))" class="tm-tree-branch">
          <div v-for="subEntry in entry.subs" :key="subEntry.key" class="tm-tree-sub">
            <div class="tm-tree-heading">
              <button
                class="tm-tree-toggle"
                type="button"
                :aria-expanded="isOpen(subEntry.key)"
                :aria-label="`展开或折叠 ${subEntry.sub.name}`"
                @click="toggle(subEntry.key)"
              >
                <span></span>
              </button>
              <span class="tm-tree-sub-name">{{ subEntry.sub.name }}</span>
              <span class="tm-tree-meta">{{ subEntry.sub.leaves.length }} 个方向</span>
            </div>

            <div v-show="isOpen(subEntry.key)" class="tm-tree-branch tm-tree-leaves">
              <div v-for="leaf in subEntry.leaves" :key="leaf.name" class="tm-tree-leaf">
                <span class="tm-tree-dot" aria-hidden="true"></span>
                <span class="tm-tree-leaf-name">
                  <TechMapHighlight :text="leaf.name" :term="term" />
                </span>
                <span v-if="leaf.board" class="tm-tree-board">
                  <TechMapHighlight :text="leaf.board" :term="term" />
                </span>
                <span class="tm-tree-companies">
                  <template v-for="company in leaf.cos" :key="company.c">
                    <RouterLink
                      v-if="reportOf(company.c)"
                      class="tm-tree-company has-report"
                      :to="{
                        name: 'investment-report',
                        params: { slug: reportOf(company.c)?.slug },
                      }"
                      :title="`${reportOf(company.c)?.title} · 打开调研报告`"
                    >
                      <TechMapHighlight :text="company.n" :term="term" />
                      <em><TechMapHighlight :text="company.c" :term="term" /></em>
                      <b class="tm-co-report">调研</b>
                    </RouterLink>
                    <span v-else class="tm-tree-company">
                      <TechMapHighlight :text="company.n" :term="term" />
                      <em><TechMapHighlight :text="company.c" :term="term" /></em>
                    </span>
                  </template>
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="tm-notes">
        <h2>口径与用法</h2>
        <ul>
          <li v-for="note in techMapNotes" :key="note.label">
            <b>{{ note.label }}：</b>{{ note.text }}
          </li>
        </ul>
        <h3>怎么用这张图</h3>
        <ul>
          <li v-for="item in techMapUsage" :key="item">{{ item }}</li>
        </ul>
      </section>
    </div>
  </div>
</template>
