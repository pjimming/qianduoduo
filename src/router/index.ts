import { createRouter, createWebHistory } from 'vue-router'
import DashboardView from '@/views/DashboardView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'dashboard',
      component: DashboardView,
    },
    {
      path: '/investment',
      redirect: { name: 'investment-tech-map' },
    },
    {
      path: '/investment/tech-map',
      name: 'investment-tech-map',
      component: () => import('@/views/InvestmentTechMapView.vue'),
      meta: {
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
