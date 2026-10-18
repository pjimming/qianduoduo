<script setup lang="ts">
import { groupColor, techMap, techMapStats } from '@/data/techmap'
</script>

<template>
  <section class="tm-print-outline" aria-hidden="true">
    <header>
      <h2>A股科技全景图</h2>
      <p>
        数据快照 {{ techMap.date }} · {{ techMapStats.groups }} 大门类 ·
        {{ techMapStats.subs }} 个子行业 · {{ techMapStats.leaves }} 个细分方向 ·
        {{ techMapStats.companies }} 家代表公司
      </p>
      <p>产业地图与事实索引，不构成投资建议。个股信息以最新公告与定期报告为准。</p>
    </header>

    <section v-for="group in techMap.groups" :key="group.id" class="tm-print-group">
      <h3 :style="{ color: groupColor(group) }">{{ group.name }}</h3>
      <p class="tm-print-desc">{{ group.desc }}</p>
      <div v-for="sub in group.subs" :key="sub.name" class="tm-print-sub">
        <h4>{{ sub.name }}</h4>
        <p v-for="leaf in sub.leaves" :key="leaf.name" class="tm-print-leaf">
          <strong>{{ leaf.name }}</strong>
          <span v-if="leaf.board"> · {{ leaf.board }}</span>
          <br />
          <span>{{ leaf.cos.map((company) => `${company.n} ${company.c}`).join(' · ') }}</span>
        </p>
      </div>
    </section>
  </section>
</template>

<style scoped>
.tm-print-outline {
  display: none;
}

@media print {
  .tm-print-outline {
    display: block;
    color: #111;
    font: 10.5pt/1.5 "Microsoft YaHei UI", "PingFang SC", sans-serif;
  }

  .tm-print-outline header {
    padding-bottom: 10pt;
    border-bottom: 1pt solid #bbb;
  }

  .tm-print-outline h2 {
    margin: 0 0 5pt;
    font-size: 22pt;
  }

  .tm-print-outline header p {
    margin: 3pt 0;
    color: #555;
  }

  .tm-print-group {
    margin-top: 14pt;
    break-before: page;
  }

  .tm-print-group:first-of-type {
    break-before: auto;
  }

  .tm-print-group h3 {
    margin: 0;
    font-size: 16pt;
  }

  .tm-print-desc {
    margin: 3pt 0 8pt;
    color: #555;
  }

  .tm-print-sub {
    margin-top: 8pt;
  }

  .tm-print-sub h4 {
    margin: 0 0 3pt;
    font-size: 12pt;
  }

  .tm-print-leaf {
    margin: 2pt 0 5pt;
    color: #333;
    break-inside: avoid;
  }

  .tm-print-leaf strong {
    color: #111;
  }

  .tm-print-leaf span {
    color: #555;
  }
}
</style>
