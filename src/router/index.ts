import { createRouter, createWebHistory } from 'vue-router'
import DashboardView from '@/views/DashboardView.vue'

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior(_to, _from, savedPosition) {
    if (savedPosition) return { ...savedPosition, behavior: 'instant' }
    return { top: 0, behavior: 'instant' }
  },
  routes: [
    {
      path: '/',
      name: 'dashboard',
      component: DashboardView,
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
      path: '/investment/research/:slug',
      name: 'investment-report',
      component: () => import('@/views/InvestmentReportView.vue'),
      meta: {
        module: 'investment',
        title: '投资 · 股票调研报告 · 钱多多',
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

export default router
