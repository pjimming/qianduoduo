<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import TechMapHighlight from '@/components/techmap/TechMapHighlight.vue'
import { firstReportForCompany } from '@/data/techMapReports'
import {
  groupColor,
  groupCompanyCount,
  groupLeafCount,
  leafSearchText,
  techMap,
  techMapChain,
  techMapGroupSources,
  techMapNotes,
  techMapStats,
  techMapUsage,
  type TechGroup,
  type TechLeaf,
  type TechSub,
} from '@/data/techmap'

interface FilteredSub {
  sub: TechSub
  leaves: TechLeaf[]
}

interface FilteredGroup {
  group: TechGroup
  color: string
  subs: FilteredSub[]
}

const searchInput = ref('')
const activeGroup = ref('all')
const scrollRef = ref<HTMLElement | null>(null)
const term = computed(() => searchInput.value.trim().toLowerCase())

const filteredGroups = computed<FilteredGroup[]>(() => {
  const needle = term.value
  const result: FilteredGroup[] = []

  for (const group of techMap.groups) {
    if (activeGroup.value !== 'all' && activeGroup.value !== group.id) continue
    const subs: FilteredSub[] = []

    for (const sub of group.subs) {
      const subMatches = Boolean(needle) && sub.name.toLowerCase().includes(needle)
      const leaves = sub.leaves.filter(
        (leaf) => !needle || subMatches || leafSearchText(group, sub, leaf).includes(needle),
      )
      if (leaves.length) subs.push({ sub, leaves })
    }

    if (subs.length) result.push({ group, color: groupColor(group), subs })
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
  if (!term.value && activeGroup.value === 'all') return ''
  return `匹配 ${matchedLeaves.value} / ${techMapStats.leaves} 个细分方向`
})

function selectGroup(groupId: string): void {
  activeGroup.value = groupId
  if (groupId === 'all') return
  void nextTick(() => {
    scrollToGroup(groupId)
  })
}

function scrollToGroup(groupId: string): void {
  const container = scrollRef.value
  const target = document.getElementById(`tm-group-${groupId}`)
  if (!container || !target) return
  const top =
    target.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop -
    8
  container.scrollTo({ top, behavior: 'smooth' })
}

function clearSearch(): void {
  searchInput.value = ''
}

function reportOf(code: string) {
  return firstReportForCompany(code)
}

watch(term, async (value) => {
  if (!value) return
  await nextTick()
  const first = filteredGroups.value[0]
  if (first) scrollToGroup(first.group.id)
})

defineExpose({
  preparePrint() {},
  restoreAfterPrint() {},
})
</script>

<template>
  <div class="tm-view tm-table-view">
    <div class="tm-controlbar">
      <label class="tm-search">
        <input
          v-model="searchInput"
          type="search"
          placeholder="搜索细分方向或公司名，例如：电子布、CPO、存储、中际旭创"
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
      <div class="tm-chips" role="group" aria-label="按门类筛选">
        <button
          class="tm-chip"
          :class="{ 'is-on': activeGroup === 'all' }"
          type="button"
          @click="selectGroup('all')"
        >
          全部
        </button>
        <button
          v-for="group in techMap.groups"
          :key="group.id"
          class="tm-chip"
          :class="{ 'is-on': activeGroup === group.id }"
          type="button"
          @click="selectGroup(group.id)"
        >
          {{ group.name }}
        </button>
      </div>
      <span class="tm-hit" role="status" aria-live="polite">{{ hitText }}</span>
    </div>

    <div ref="scrollRef" class="tm-table-scroll">
      <p class="tm-ov-title">总览：八大科技门类</p>
      <div class="tm-overview">
        <button
          v-for="group in techMap.groups"
          :key="group.id"
          class="tm-card"
          :class="{ 'is-active': activeGroup === group.id }"
          type="button"
          :style="{ '--node-color': groupColor(group) }"
          @click="selectGroup(group.id)"
        >
          <span class="tm-card-name">{{ group.name }}</span>
          <span class="tm-card-num">
            {{ groupLeafCount(group) }} 个细分 · {{ groupCompanyCount(group) }} 家公司
          </span>
          <span class="tm-card-subs">
            <template v-for="(sub, index) in group.subs" :key="sub.name">
              <span v-if="index"> · </span>
              {{ sub.name }} <b>{{ sub.leaves.length }}</b>
            </template>
          </span>
        </button>
      </div>

      <p class="tm-ov-title">横切视角：同一条产业链上的六层卡位</p>
      <div class="tm-chain-wrap">
        <table class="tm-chain">
          <thead>
            <tr>
              <th v-for="cell in techMapChain[0]" :key="cell">{{ cell }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in techMapChain.slice(1)" :key="row[0]">
              <td v-for="cell in row" :key="cell">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="!filteredGroups.length" class="tm-empty">没有匹配的方向，试试公司简称或板块关键词。</p>

      <section
        v-for="entry in filteredGroups"
        :id="`tm-group-${entry.group.id}`"
        :key="entry.group.id"
        class="tm-table-group"
        :style="{ '--node-color': entry.color }"
      >
        <header class="tm-table-group-head">
          <div>
            <h2>{{ entry.group.name }}</h2>
            <p class="tm-table-desc">{{ entry.group.desc }}</p>
            <p class="tm-table-source">{{ techMapGroupSources[entry.group.id] }}</p>
          </div>
          <div class="tm-group-stat">
            <strong>{{ entry.group.subs.length }}</strong><span>子行业</span>
            <strong>{{ groupLeafCount(entry.group) }}</strong><span>细分方向</span>
            <strong>{{ groupCompanyCount(entry.group) }}</strong><span>代表公司</span>
          </div>
        </header>

        <div v-for="subEntry in entry.subs" :key="subEntry.sub.name" class="tm-table-sub">
          <h3>
            <i class="tm-bar" aria-hidden="true"></i>
            {{ subEntry.sub.name }}
            <span class="tm-sub-count">{{ subEntry.leaves.length }} 个方向</span>
          </h3>
          <div v-for="leaf in subEntry.leaves" :key="leaf.name" class="tm-dir">
            <div class="tm-dir-name">
              <span><TechMapHighlight :text="leaf.name" :term="term" /></span>
              <span v-if="leaf.board" class="tm-board">
                <TechMapHighlight :text="leaf.board" :term="term" />
              </span>
            </div>
            <div class="tm-cos">
              <template v-for="company in leaf.cos" :key="company.c">
                <RouterLink
                  v-if="reportOf(company.c)"
                  class="tm-co has-report"
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
                <span v-else class="tm-co">
                  <TechMapHighlight :text="company.n" :term="term" />
                  <em><TechMapHighlight :text="company.c" :term="term" /></em>
                </span>
              </template>
            </div>
          </div>
        </div>
      </section>

      <section class="tm-notes">
        <h2>口径、边界与阅读提示</h2>
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
