import { createRouter, createWebHistory, type LocationQuery, type RouteLocationNormalized } from 'vue-router'

const PRODUCT_SECTIONS = ['screening', 'allocation', 'holdings'] as const
const EVALUATION_SECTIONS = ['proposals', 'decisions', 'results'] as const
const DAILY_SECTIONS = ['today', 'records', 'capital'] as const
const TRADES_SECTIONS = ['current-value', 'holdings', 'valuations', 'trades', 'inbox'] as const
const REVIEW_SECTIONS = ['attribution', 'rhythm', 'monthly-notes', 'quarterly-notes'] as const
const SCREENING_KEYS = [
  'run',
  'tab',
  'channel',
  'code',
  'page',
  'term',
  'category',
  'issuer',
  'hint',
  'q',
  'stage',
  'sort',
  'log',
] as const

const PRODUCT_ANCHORS: Record<string, string> = {
  '#holding-reviews': 'holdings',
  '#events': 'holdings',
  '#products': 'allocation',
  '#screening': 'screening',
}

const DAILY_ANCHORS: Record<string, string> = {
  '#capture-trade': 'today',
  '#capture-income': 'today',
  '#records': 'records',
  '#capital': 'capital',
  '#capitalPanel': 'capital',
}

const TRADES_ANCHORS: Record<string, string> = {
  '#current-value': 'current-value',
  '#holdings': 'holdings',
  '#valuations': 'valuations',
  '#trades': 'trades',
  '#inbox': 'inbox',
}

const REVIEW_ANCHORS: Record<string, string> = {
  '#attribution': 'attribution',
  '#score': 'attribution',
  '#rhythm': 'rhythm',
  '#monthly-notes': 'monthly-notes',
  '#quarterly-notes': 'quarterly-notes',
}

function textQuery(to: RouteLocationNormalized, key: string): string {
  const value = to.query[key]
  return typeof value === 'string' ? value.trim() : ''
}

function hasScreeningParams(to: RouteLocationNormalized): boolean {
  return SCREENING_KEYS.some((key) => textQuery(to, key) !== '')
}

interface NormalizedSection {
  section: string
  view: string
  hash: string
  notice: string
}

function normalizeProducts(to: RouteLocationNormalized): NormalizedSection {
  const explicit = textQuery(to, 'section')
  const invalid =
    explicit !== '' && !(PRODUCT_SECTIONS as readonly string[]).includes(explicit)
  let section = (PRODUCT_SECTIONS as readonly string[]).includes(explicit)
    ? explicit
    : ''
  if (!section) {
    if (
      to.hash === '#holding-reviews' ||
      to.hash === '#events' ||
      textQuery(to, 'view') === 'performance' ||
      textQuery(to, 'lot') !== ''
    ) {
      section = 'holdings'
    } else if (to.hash === '#screening' || hasScreeningParams(to)) {
      section = 'screening'
    } else {
      section = 'allocation'
    }
  }

  let view = textQuery(to, 'view')
  if (section !== 'holdings' || (view !== '' && view !== 'performance')) view = ''

  let hash = to.hash
  const anchorTarget = PRODUCT_ANCHORS[hash]
  if (anchorTarget && anchorTarget !== section) hash = ''

  return {
    section,
    view,
    hash,
    notice: invalid ? 'invalid-section' : textQuery(to, 'notice'),
  }
}

function normalizeEvaluation(to: RouteLocationNormalized): NormalizedSection {
  const explicit = textQuery(to, 'section')
  const invalid =
    explicit !== '' && !(EVALUATION_SECTIONS as readonly string[]).includes(explicit)
  let section = (EVALUATION_SECTIONS as readonly string[]).includes(explicit)
    ? explicit
    : ''
  if (!section) {
    if (to.hash === '#decisions') section = 'decisions'
    else if (to.hash === '#automation' || to.hash === '#calibration') section = 'results'
    else if (to.hash === '#proposals') section = 'proposals'
    else section = 'proposals'
  }

  let view = textQuery(to, 'view')
  if (section === 'results') {
    if (view !== 'evaluations' && view !== 'calibration') {
      view = to.hash === '#calibration' ? 'calibration' : 'evaluations'
    }
  } else {
    view = ''
  }

  let hash = to.hash
  if (hash === '#proposals' && section !== 'proposals') hash = ''
  else if (hash === '#decisions' && section !== 'decisions') hash = ''
  else if (hash === '#automation' && !(section === 'results' && view === 'evaluations')) {
    hash = ''
  } else if (hash === '#calibration' && !(section === 'results' && view === 'calibration')) {
    hash = ''
  }

  return {
    section,
    view,
    hash,
    notice: invalid ? 'invalid-section' : textQuery(to, 'notice'),
  }
}

function normalizeDaily(to: RouteLocationNormalized): NormalizedSection {
  const explicit = textQuery(to, 'section')
  const invalid =
    explicit !== '' && !(DAILY_SECTIONS as readonly string[]).includes(explicit)
  let section = (DAILY_SECTIONS as readonly string[]).includes(explicit)
    ? explicit
    : ''
  if (!section) {
    const anchorTarget = DAILY_ANCHORS[to.hash]
    if (anchorTarget === 'records' && textQuery(to, 'date') === '') {
      section = 'records'
    } else if (anchorTarget === 'capital') {
      section = 'capital'
    } else {
      section = 'today'
    }
  }

  // 带 date 的链接要打开收益录入表单，表单位于「两类截图」分区。
  let hash = to.hash
  const anchorTarget = DAILY_ANCHORS[hash]
  if (anchorTarget && anchorTarget !== section) hash = ''

  return {
    section,
    view: '',
    hash,
    notice: invalid ? 'invalid-section' : textQuery(to, 'notice'),
  }
}

function normalizeTrades(to: RouteLocationNormalized): NormalizedSection {
  const explicit = textQuery(to, 'section')
  const invalid =
    explicit !== '' && !(TRADES_SECTIONS as readonly string[]).includes(explicit)
  let section = (TRADES_SECTIONS as readonly string[]).includes(explicit)
    ? explicit
    : ''
  if (!section) section = TRADES_ANCHORS[to.hash] || 'current-value'

  let hash = to.hash
  const anchorTarget = TRADES_ANCHORS[hash]
  if (anchorTarget && anchorTarget !== section) hash = ''

  return {
    section,
    view: '',
    hash,
    notice: invalid ? 'invalid-section' : textQuery(to, 'notice'),
  }
}

function normalizeReview(to: RouteLocationNormalized): NormalizedSection {
  const explicit = textQuery(to, 'section')
  const alias = explicit === 'score' ? 'attribution' : explicit
  const invalid =
    alias !== '' && !(REVIEW_SECTIONS as readonly string[]).includes(alias)
  let section = (REVIEW_SECTIONS as readonly string[]).includes(alias)
    ? alias
    : ''
  if (!section) section = REVIEW_ANCHORS[to.hash] || 'attribution'

  let hash = to.hash === '#score' ? '' : to.hash
  const anchorTarget = REVIEW_ANCHORS[hash]
  if (anchorTarget && anchorTarget !== section) hash = ''

  return {
    section,
    view: '',
    hash,
    notice: invalid ? 'invalid-section' : textQuery(to, 'notice'),
  }
}

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return { ...savedPosition, behavior: 'instant' }
    if (to.hash && (to.hash !== from.hash || to.query.section !== from.query.section || to.name !== from.name)) {
      return { el: to.hash, top: 88, behavior: 'smooth' }
    }
    if (
      to.name === from.name &&
      to.query.section === from.query.section &&
      to.query.view === from.query.view
    ) {
      return false
    }
    return { top: 0, behavior: 'instant' }
  },
  routes: [
    {
      path: '/',
      redirect: { name: 'r2-overview' },
    },
    {
      path: '/ledger/screening',
      name: 'r2-screening',
      redirect: to => ({
        name: 'r2-products',
        query: { ...to.query, section: 'screening' },
        hash: to.hash,
      }),
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
          path: 'products',
          name: 'r2-products',
          component: () => import('@/views/r2/ProductsView.vue'),
          meta: { module: 'wealth', title: '理财 · 选品与配置 · 钱多多' },
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

function normalizedLocation(
  to: RouteLocationNormalized,
  next: NormalizedSection,
) {
  const viewChanged = next.view !== ''
    ? to.query.view !== next.view
    : to.query.view !== undefined
  const noticeChanged = next.notice !== '' && to.query.notice !== next.notice
  if (
    to.query.section === next.section &&
    !viewChanged &&
    to.hash === next.hash &&
    !noticeChanged
  ) {
    return true
  }
  const query: LocationQuery = { ...to.query, section: next.section }
  if (next.view !== '') query.view = next.view
  else delete query.view
  if (next.notice !== '') query.notice = next.notice
  return { path: to.path, query, hash: next.hash, replace: true }
}

router.beforeEach(to => {
  if (to.name === 'r2-products') {
    return normalizedLocation(to, normalizeProducts(to))
  }
  if (to.name === 'r2-evaluation') {
    return normalizedLocation(to, normalizeEvaluation(to))
  }
  if (to.name === 'r2-daily') {
    return normalizedLocation(to, normalizeDaily(to))
  }
  if (to.name === 'r2-trades') {
    return normalizedLocation(to, normalizeTrades(to))
  }
  if (to.name === 'r2-review') {
    return normalizedLocation(to, normalizeReview(to))
  }
})

const PRODUCT_LABELS: Record<string, string> = {
  screening: '候选初筛',
  allocation: '资金配置',
  holdings: '持仓复核',
}
const EVALUATION_LABELS: Record<string, string> = {
  proposals: '待处理提案',
  decisions: '决策记录',
  results: '评估与校准',
}
const DAILY_LABELS: Record<string, string> = {
  today: '两类截图',
  records: '历史记录',
  capital: '本金账户',
}
const TRADES_LABELS: Record<string, string> = {
  'current-value': '当前净值',
  holdings: '当前持仓',
  valuations: '产品收益',
  trades: '交易流水',
  inbox: '交易收件箱',
}
const REVIEW_LABELS: Record<string, string> = {
  attribution: '收益归因',
  rhythm: '复盘节奏',
  'monthly-notes': '月度五问',
  'quarterly-notes': '季度复盘',
}

router.afterEach((to) => {
  if (to.name === 'r2-daily') {
    const section = typeof to.query.section === 'string' ? to.query.section : ''
    const label = DAILY_LABELS[section] || DAILY_LABELS.today
    document.title = `理财 · 每日记账 · ${label} · 钱多多`
    return
  }
  if (to.name === 'r2-trades') {
    const section = typeof to.query.section === 'string' ? to.query.section : ''
    const label = TRADES_LABELS[section] || TRADES_LABELS['current-value']
    document.title = `理财 · 交易与持仓 · ${label} · 钱多多`
    return
  }
  if (to.name === 'r2-review') {
    const section = typeof to.query.section === 'string' ? to.query.section : ''
    const label = REVIEW_LABELS[section] || REVIEW_LABELS.attribution
    document.title = `理财 · 复盘 · ${label} · 钱多多`
    return
  }
  if (to.name === 'r2-products' || to.name === 'r2-evaluation') {
    const section = typeof to.query.section === 'string' ? to.query.section : ''
    const labels = to.name === 'r2-products' ? PRODUCT_LABELS : EVALUATION_LABELS
    const label = labels[section] || labels[Object.keys(labels)[0]]
    const workspace = to.name === 'r2-products' ? '选品与配置' : '决策与评估'
    const viewSuffix =
      to.name === 'r2-evaluation' && section === 'results'
        ? to.query.view === 'calibration'
          ? ' · 校准'
          : ' · 评价'
        : ''
    document.title = `理财 · ${workspace} · ${label}${viewSuffix} · 钱多多`
    return
  }
  if (typeof to.meta.title === 'string') {
    document.title = to.meta.title
  }
})

export default router
