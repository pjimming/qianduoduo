import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior(to, _from, savedPosition) {
    if (savedPosition) return { ...savedPosition, behavior: 'instant' }
    if (to.hash) return { el: to.hash, behavior: 'smooth' }
    return { top: 0, behavior: 'instant' }
  },
  routes: [
    {
      path: '/',
      redirect: { name: 'r2-overview' },
    },
    {
      path: '/ledger',
      component: () => import('@/views/r2/R2LayoutView.vue'),
      meta: { module: 'wealth' },
      children: [
        {
          path: '',
          redirect: { name: 'r2-overview' },
        },
        {
          path: 'inbox',
          name: 'r2-inbox',
          component: () => import('@/views/r2/InboxView.vue'),
          meta: {
            module: 'wealth',
            title: '理财 · 消息中心 · 钱多多',
          },
        },
        {
          path: 'overview',
          name: 'r2-overview',
          component: () => import('@/views/r2/OverviewView.vue'),
          meta: {
            module: 'wealth',
            title: '理财 · 收益概览 · 钱多多',
          },
        },
        {
          path: 'daily',
          name: 'r2-daily',
          component: () => import('@/views/r2/DailyEntryView.vue'),
          meta: {
            module: 'wealth',
            title: '理财 · 每日记账 · 钱多多',
          },
        },
        {
          path: 'trades',
          name: 'r2-trades',
          component: () => import('@/views/r2/TradesView.vue'),
          meta: {
            module: 'wealth',
            title: '理财 · 交易与持仓 · 钱多多',
          },
        },
        {
          path: 'products',
          name: 'r2-products',
          component: () => import('@/views/r2/ProductsView.vue'),
          meta: {
            module: 'wealth',
            title: '理财 · 产品与配置 · 钱多多',
          },
        },
        {
          path: 'review',
          name: 'r2-review',
          component: () => import('@/views/r2/ReviewView.vue'),
          meta: {
            module: 'wealth',
            title: '理财 · 复盘 · 钱多多',
          },
        },
        {
          path: 'evaluation',
          name: 'r2-evaluation',
          component: () => import('@/views/r2/EvaluationView.vue'),
          meta: {
            module: 'wealth',
            title: '理财 · 决策与评估 · 钱多多',
          },
        },
      ],
    },
    {
      path: '/investment',
      redirect: { name: 'investment-research' },
    },
    {
      path: '/investment/research',
      name: 'investment-research',
      component: () => import('@/views/InvestmentResearchView.vue'),
      meta: {
        module: 'investment',
        title: '投资 · 股票调研报告库 · 钱多多',
      },
    },
    {
      path: '/investment/briefs',
      name: 'investment-briefs',
      component: () => import('@/views/InvestmentBriefsView.vue'),
      meta: {
        module: 'investment',
        title: '投资 · 每日市场简报 · 钱多多',
      },
    },
    {
      path: '/investment/research/:slug',
      name: 'investment-report',
      component: () => import('@/views/InvestmentReportView.vue'),
      meta: {
        module: 'investment',
        title: '投资 · 股票调研报告 · 钱多多',
        hideBackToTop: true,
      },
    },
    {
      path: '/investment/tech-map',
      name: 'investment-tech-map',
      component: () => import('@/views/InvestmentTechMapView.vue'),
      meta: {
        module: 'investment',
        title: '投资 · A股科技图谱 · 钱多多',
      },
    },
    {
      path: '/research/tech-map',
      redirect: (to) => ({
        name: 'investment-tech-map',
        query: to.query,
      }),
    },
  ],
})

router.afterEach((to) => {
  if (typeof to.meta.title === 'string') {
    document.title = to.meta.title
  }
})

export default router
