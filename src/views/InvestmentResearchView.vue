<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import {
  stockReportLibrary,
  stockReportStats,
  stockReports,
} from '@/data/stockReports'
import {
  loadReportSearchIndex,
  searchReportBody,
  type ReportSearchDoc,
} from '@/data/reportSearch'

const query = ref('')
const activeCategory = ref('全部')
const searchDocs = shallowRef<ReportSearchDoc[] | null>(null)
const searchLoading = ref(false)

const categories = computed(() => {
  const counts = new Map<string, number>()
  for (const report of stockReports) {
    counts.set(report.category, (counts.get(report.category) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .map(([name, count]) => ({ name, count }))
})

const filteredReports = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return stockReports.filter((report) => {
    if (activeCategory.value !== '全部' && report.category !== activeCategory.value) return false
    if (!needle) return true
    return [
      report.title,
      report.summary,
      report.category,
      report.date,
      report.file,
      report.keywords,
    ]
      .join(' ')
      .toLowerCase()
      .includes(needle)
  })
})

const bodySearch = computed(() => {
  const needle = query.value.trim()
  if (!searchDocs.value || needle.length < 2) {
    return { hits: [], total: 0 }
  }
  return searchReportBody(searchDocs.value, needle)
})

async function ensureSearchIndex(): Promise<void> {
  if (searchDocs.value || searchLoading.value) return
  searchLoading.value = true
  try {
    searchDocs.value = await loadReportSearchIndex()
  } finally {
    searchLoading.value = false
  }
}

watch(query, (value) => {
  if (value.trim().length >= 2) void ensureSearchIndex()
})

function clearFilters(): void {
  query.value = ''
  activeCategory.value = '全部'
}

onMounted(() => {
  document.title = '钱多多 · 投资 · 股票调研报告库'
})
</script>

<template>
  <section class="library-page">
    <header class="library-head">
      <div class="library-heading">
        <p class="research-kicker">INVESTMENT LIBRARY · 非 R2 理财产品</p>
        <h1>股票调研<span>报告库</span></h1>
        <p class="library-lede">
          个股、产业链与板块研究，按调研日期归档
          <span>
            Serenity 供应链瓶颈分析 + Equity Research 框架 · 源目录
            {{ stockReportLibrary.source }}
          </span>
        </p>
      </div>

      <div class="library-stats" aria-label="报告库概览">
        <div class="library-stat">
          <b>{{ stockReportStats.count }}</b>
          <span>REPORTS / 篇</span>
        </div>
        <div class="library-stat">
          <b>{{ stockReportStats.latest }}</b>
          <span>LATEST / 最新</span>
        </div>
        <div class="library-stat">
          <b>{{ stockReportStats.categories }}</b>
          <span>TOPICS / 方向</span>
        </div>
      </div>
    </header>

    <div class="library-toolbar">
      <label class="library-search">
        <span class="library-search-icon" aria-hidden="true">⌕</span>
        <input
          v-model="query"
          type="search"
          placeholder="搜索公司、代码、产业链环节或正文结论…"
          autocomplete="off"
          aria-label="搜索股票调研报告"
          @focus="ensureSearchIndex"
        />
      </label>
      <div class="library-chips" role="group" aria-label="按研究方向筛选">
        <button
          class="library-chip"
          :class="{ 'is-active': activeCategory === '全部' }"
          type="button"
          @click="activeCategory = '全部'"
        >
          全部<span>{{ stockReports.length }}</span>
        </button>
        <button
          v-for="category in categories"
          :key="category.name"
          class="library-chip"
          :class="{ 'is-active': activeCategory === category.name }"
          type="button"
          @click="activeCategory = category.name"
        >
          {{ category.name }}<span>{{ category.count }}</span>
        </button>
      </div>
      <span class="library-count">显示 {{ filteredReports.length }} / {{ stockReports.length }}</span>
    </div>

    <div v-if="filteredReports.length" class="report-grid">
      <RouterLink
        v-for="report in filteredReports"
        :key="report.file"
        class="report-card"
        :to="{ name: 'investment-report', params: { slug: report.slug } }"
        :aria-label="`阅读 ${report.title}`"
      >
        <div class="report-card-top">
          <span class="report-tag">{{ report.category }}</span>
          <span class="report-date">{{ report.date }}</span>
          <span
            v-if="report.priority"
            class="report-priority"
            :title="report.priorityDetail ?? report.priority"
          >
            优先级 {{ report.priority }}
          </span>
        </div>
        <h3>{{ report.title }}</h3>
        <p>{{ report.summary }}</p>
        <div class="report-card-foot">
          <span>调研报告 · {{ report.date }}</span>
          <strong>阅读报告 →</strong>
        </div>
      </RouterLink>
    </div>

    <section v-if="bodySearch.hits.length" class="body-hits" aria-labelledby="bodyHitsTitle">
      <div class="body-hits-head">
        <div>
          <p class="research-kicker">FULL-TEXT SEARCH</p>
          <h2 id="bodyHitsTitle">正文命中 <span>{{ bodySearch.total }} 处</span></h2>
        </div>
        <span class="body-hits-status">点击跳到对应章节</span>
      </div>
      <RouterLink
        v-for="(hit, index) in bodySearch.hits"
        :key="`${hit.slug}-${hit.anchor}-${index}`"
        class="body-hit"
        :to="{
          name: 'investment-report',
          params: { slug: hit.slug },
          hash: hit.anchor ? `#${hit.anchor}` : undefined,
        }"
      >
        <span class="body-hit-meta">{{ hit.date }} · {{ hit.title }}</span>
        <strong>{{ hit.heading }}</strong>
        <p>
          <span>{{ hit.before }}</span><mark>{{ hit.match }}</mark><span>{{ hit.after }}</span>
        </p>
      </RouterLink>
    </section>

    <p
      v-else-if="searchLoading && query.trim().length >= 2"
      class="body-hits-loading"
      aria-live="polite"
    >
      正在加载正文索引…
    </p>

    <div
      v-if="!filteredReports.length && !bodySearch.hits.length && !searchLoading"
      class="library-empty"
    >
      <strong>没有匹配的报告</strong>
      <p>试试公司代码、产业链关键词，或清除当前筛选。</p>
      <button class="button button-ghost button-small" type="button" @click="clearFilters">
        清除筛选
      </button>
    </div>

    <aside class="library-crosslink">
      <div>
        <span class="library-crosslink-kicker">TECH MAP · 产业全景</span>
        <strong>需要先看产业链位置？</strong>
        <p>用 A股科技图谱从门类、子行业和细分方向定位公司，再回到报告库看具体标的。</p>
      </div>
      <RouterLink class="button button-ghost button-small" :to="{ name: 'investment-tech-map' }">
        打开 A股科技图谱 →
      </RouterLink>
    </aside>

    <p class="library-footnote">
      清单生成于 {{ stockReportLibrary.generatedAt }} · 报告内容为公开信息研究整理，不构成投资建议 ·
      与本机 R2 账本完全隔离
    </p>
  </section>
</template>
