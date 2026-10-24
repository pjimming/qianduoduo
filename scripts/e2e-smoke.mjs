#!/usr/bin/env node
/**
 * 端到端冒烟：用本机 Chrome/Edge 验证
 * - 报告库 → 正文检索 → 报告直达（无 iframe）
 * - 报告目录、键盘切换、返回报告库后的样式清理
 * - 首页账本能正常加载
 *
 * 运行前会执行 npm run build（见 package.json 的 pretest:e2e）。
 */

import { chromium } from 'playwright-core'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { createServer } = require('../server.js')
const { openDatabase } = require('../lib/db.js')
const { resolveProductCsv } = require('../server.js')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Wl3sAAAAASUVORK5CYII='
const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)
const executablePath = chromeCandidates.find((candidate) => existsSync(candidate))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function assertFontFloor(page, selector, label) {
  const offenders = await page.locator(selector).evaluate((root) => {
    return [root, ...Array.from(root.querySelectorAll('*'))]
      .filter((element) => {
        const style = getComputedStyle(element)
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          !element.getClientRects().length
        ) {
          return false
        }
        const hasDirectText = Array.from(element.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        )
        return hasDirectText && Number.parseFloat(style.fontSize) < 12
      })
      .slice(0, 8)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: element.textContent?.trim().slice(0, 40) || '',
        size: getComputedStyle(element).fontSize,
      }))
  })
  assert(
    offenders.length === 0,
    `${label}存在低于 12px 的信息文字：${JSON.stringify(offenders)}`,
  )
}

async function assertNoLargeLightSurface(page, selector, label) {
  const surfaces = await page.locator(selector).first().evaluate((root) => {
    const isLightPaint = (value) => {
      for (const match of value.matchAll(
        /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/g,
      )) {
        const alpha = match[4] === undefined ? 1 : Number(match[4])
        if (
          alpha >= 0.45 &&
          Number(match[1]) >= 210 &&
          Number(match[2]) >= 210 &&
          Number(match[3]) >= 210
        ) {
          return true
        }
      }
      return false
    }

    return [root, ...Array.from(root.querySelectorAll('*'))]
      .filter((element) => {
        if (
          !(element instanceof HTMLElement) &&
          !(element instanceof SVGElement)
        ) {
          return false
        }
        if (
          element.closest('svg') ||
          element.tagName === 'IMG' ||
          element.closest('[aria-hidden="true"]')
        ) {
          return false
        }
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        if (
          rect.width * rect.height < 5000 ||
          style.display === 'none' ||
          style.visibility === 'hidden'
        ) {
          return false
        }
        return (
          isLightPaint(style.backgroundColor) ||
          isLightPaint(style.backgroundImage)
        )
      })
      .slice(0, 6)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className:
          typeof element.className === 'string'
            ? element.className
            : element.getAttribute('class') || '',
        background: getComputedStyle(element).backgroundColor,
        backgroundImage: getComputedStyle(element).backgroundImage.slice(0, 160),
      }))
  })
  assert(
    surfaces.length === 0,
    `${label}仍存在大面积浅色表面：${JSON.stringify(surfaces)}`,
  )
}

async function main() {
  process.env.R2_OCR = '0'
  if (!existsSync(path.join(root, 'dist', 'index.html'))) {
    throw new Error('缺少 dist/index.html，请先执行 npm run build')
  }
  if (!executablePath) {
    throw new Error('没有找到 Chrome/Edge，可设置 CHROME_PATH 后重试')
  }

  const directory = mkdtempSync(path.join(os.tmpdir(), 'r2-e2e-'))
  const repository = openDatabase({
    dbPath: path.join(directory, 'e2e.sqlite'),
    productCsvPath: resolveProductCsv(root),
    logger: { warn() {} },
  })
  const server = createServer({ repository })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  const browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))

  try {
    await page.goto(`${base}/investment/research`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.library-page')
    const cards = await page.locator('.report-card').count()
    const reportManifest = JSON.parse(
      readFileSync(path.join(root, 'src', 'data', 'stockReports.json'), 'utf8'),
    )
    const expectedReports = Number(reportManifest.count ?? reportManifest.reports?.length)
    assert(
      cards === expectedReports,
      `报告库应有 ${expectedReports} 张卡片，实际 ${cards}`,
    )

    await page.fill('.library-search input', '合同负债')
    await page.waitForSelector('.body-hit', { timeout: 15000 })
    const hits = await page.locator('.body-hit').count()
    assert(hits > 0, '正文检索没有返回结果')

    await page.locator('.body-hit').first().click()
    await page.waitForSelector('.rp-doc')
    assert(
      (await page.locator('.back-to-top').count()) === 0,
      '报告阅读页不应显示全局回到顶部悬浮球',
    )
    assert(new URL(page.url()).hash.length > 1, '正文命中没有跳到章节锚点')
    assert(
      (await page.locator('iframe').count()) === 0,
      '报告页不应出现 iframe',
    )
    assert(
      (await page.locator('style[data-report-doc]').count()) === 1,
      '报告样式没有按篇挂载',
    )

    const firstSlug = await page.locator('.rp-doc').getAttribute('data-report-slug')
    await page.waitForSelector('.reader-outline-rail')
    const outlineItems = await page.locator('.reader-outline-list a').count()
    assert(outlineItems >= 4, `目录项过少：${outlineItems}`)

    await page.locator('.report-switcher-trigger').click()
    await page.waitForSelector('.report-switcher-pop')
    await page.locator('.report-switcher-search input').fill('AI短剧')
    await page.waitForTimeout(200)
    const switcherItems = page.locator('.report-switcher-item')
    assert((await switcherItems.count()) > 0, '切换器搜索没有返回结果')
    const firstTitle =
      (await switcherItems.first().locator('.report-switcher-title').textContent()) ?? ''
    assert(firstTitle.includes('AI短剧'), `切换器搜索结果不匹配：${firstTitle}`)
    await switcherItems.first().click()
    await page.waitForFunction(
      (slug) =>
        document.querySelector('.rp-doc')?.getAttribute('data-report-slug') !== slug,
      firstSlug,
      { timeout: 10000 },
    )
    const secondSlug = await page.locator('.rp-doc').getAttribute('data-report-slug')

    await page.keyboard.press('Escape')
    await page.waitForSelector('.reader-outline-rail', { state: 'detached' })

    await page.locator('.rp-doc h1').click()
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(
      (slug) =>
        document.querySelector('.rp-doc')?.getAttribute('data-report-slug') !== slug,
      secondSlug,
      { timeout: 10000 },
    )

    await page.locator('.reader-back-link').click()
    await page.waitForSelector('.library-page')
    assert(
      (await page.locator('style[data-report-doc]').count()) === 0,
      '离开报告后样式没有卸载',
    )

    await fetch(`${base}/api/capital/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initial_principal: 10000, initial_date: '2026-09-01' }),
    })
    await fetch(`${base}/api/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: '2026-10-18',
        daily_pnl: 5,
        action: '无操作',
        notes: 'e2e',
      }),
    })
    repository.tradeStore.createTrade({
      trade_date: '2026-10-01',
      confirm_date: '2026-10-01',
      trade_type: 'buy',
      status: 'confirmed',
      product_code: '120056A',
      product_name: '招银理财90天',
      issuer: '招银理财',
      risk_level: 'R2',
      amount: 2000,
      term_days: 90,
      source: 'manual',
      notes: 'e2e',
    })
    repository.tradeStore.createTrade({
      trade_date: '2026-10-01',
      confirm_date: '2026-10-01',
      trade_type: 'buy',
      status: 'confirmed',
      product_code: '120026A',
      product_name: '招银理财14天',
      issuer: '招银理财',
      risk_level: 'R2',
      amount: 1000,
      term_days: 14,
      source: 'manual',
      notes: 'e2e',
    })
    repository.productValuationStore.upsertMany(
      [
        {
          yield_date: '2026-10-18',
          valuation_date: '2026-10-18',
          product_code: '120056A',
          product_name: '招银理财90天',
          holding_amount: 2000,
          daily_pnl: 1.44,
          confidence: 95,
        },
        {
          yield_date: '2026-10-18',
          valuation_date: '2026-10-18',
          product_code: '120026A',
          product_name: '招银理财14天',
          holding_amount: 1000,
          daily_pnl: 0.58,
          confidence: 95,
        },
      ],
      { source: 'income-screenshot', screenshotId: 99 },
    )
    repository.holdingValuationStore.createSnapshot(
      {
        as_of_date: '2026-10-24',
        total_value: 3002.03,
        source: 'user-confirmed',
        notes: 'E2E 银行对照市值',
      },
      { today: '2026-10-24' },
    )
    const addIncomeHistory = ({
      key,
      name,
      status,
      recordDate,
      appliedAt,
      productCode,
      notes,
      warning = '',
    }) => {
      const storedName = `e2e-income-${key}.png`
      writeFileSync(
        path.join(repository.incomeInboxDir, storedName),
        Buffer.from(ONE_PIXEL_PNG, 'base64'),
      )
      const parsed = {
        date: recordDate,
        daily_pnl: 5,
        products: [
          {
            product_code: productCode,
            product_name: productCode === '120056A' ? '招银理财90天' : '招银理财14天',
            yield_date: recordDate,
            credit_date: recordDate,
            daily_pnl: 1,
          },
        ],
        warnings: warning ? [warning] : [],
        notes,
      }
      const item = repository.incomeStore.addInbox({
        original_name: name,
        stored_name: storedName,
        mime: 'image/png',
        bytes: Buffer.from(ONE_PIXEL_PNG, 'base64').length,
        sha256: `e2e-income-history-${key}`,
        parsed,
        parse_confidence: 95,
        record_date: recordDate,
      })
      return repository.incomeStore.updateInbox(item.id, {
        parsed,
        status,
        applied_at: appliedAt,
        notes,
      })
    }
    addIncomeHistory({
      key: 'applied',
      name: 'e2e-applied.png',
      status: 'applied',
      recordDate: '2026-10-18',
      appliedAt: '2026-10-18T10:00:00.000Z',
      productCode: '120056A',
      notes: 'E2E 已入账截图',
    })
    addIncomeHistory({
      key: 'ignored',
      name: 'e2e-ignored.png',
      status: 'ignored',
      recordDate: '2026-10-18',
      appliedAt: '2026-10-18T10:10:00.000Z',
      productCode: '120026A',
      notes: 'E2E 手工忽略截图',
    })
    addIncomeHistory({
      key: 'same',
      name: 'e2e-same-amount.png',
      status: 'applied',
      recordDate: '2026-10-18',
      appliedAt: '2026-10-18T10:20:00.000Z',
      productCode: '120056A',
      notes: 'E2E 同金额忽略截图',
      warning: '该日期收益已存在且金额一致，本次已忽略',
    })
    addIncomeHistory({
      key: 'conflict',
      name: 'e2e-conflict.png',
      status: 'pending',
      recordDate: '2026-10-18',
      appliedAt: null,
      productCode: '120056A',
      notes: 'E2E 金额冲突截图',
      warning: '该日期已有不同收益，平台未覆盖',
    })

    await page.goto(`${base}/`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.stats-grid')
    assert(
      new URL(page.url()).pathname === '/ledger/overview',
      '根路径应重定向到收益概览',
    )
    assert(
      (await page.locator('#nav-group-wealth .sidebar-link').count()) === 7,
      '侧边栏理财分区应有 7 个入口',
    )
    const wealthLinkTexts = await page
      .locator('#nav-group-wealth .sidebar-link')
      .allTextContents()
    assert(
      wealthLinkTexts[0]?.includes('收益概览') &&
        wealthLinkTexts[1]?.includes('消息中心'),
      '理财菜单前两项应为“收益概览、消息中心”',
    )
    assert(
      (await page.locator('.r2-jump-card').count()) === 3,
      '收益概览应只保留两类截图和消息中心入口',
    )
    const desktopThemeModes = page.locator(
      '.sidebar-appearance .theme-mode-switch',
    )
    await desktopThemeModes.locator('[data-theme-preference="dark"]').click()
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === 'dark',
    )
    assert(
      (await page.evaluate(() =>
        localStorage.getItem('qianduoduo:theme:v1'),
      )) === 'dark',
      '深色主题没有写入本地偏好',
    )
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('.stats-grid')
    assert(
      (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark',
      '刷新后没有恢复深色主题',
    )
    assert(
      (await page
        .locator(
          '.sidebar-appearance [data-theme-preference="dark"]',
        )
        .getAttribute(
        'aria-pressed',
      )) === 'true',
      '刷新后主题按钮状态与页面不一致',
    )
    await assertFontFloor(page, '.sidebar-appearance', '主题切换')
    await assertNoLargeLightSurface(page, '.app-main', '收益概览深色主题')
    await page
      .locator('.sidebar-appearance [data-theme-preference="light"]')
      .click()
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === 'light',
    )
    assert(
      (await page.evaluate(() =>
        localStorage.getItem('qianduoduo:theme:v1'),
      )) === 'light',
      '切回浅色主题没有写入本地偏好',
    )
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('.stats-grid')
    assert(
      (await page.evaluate(() => document.documentElement.dataset.theme)) ===
        'light',
      '刷新后没有恢复浅色主题',
    )
    await page
      .locator('.sidebar-appearance [data-theme-preference="system"]')
      .click()
    const systemMode = await page.evaluate(() => ({
      preference: localStorage.getItem('qianduoduo:theme:v1'),
      resolvedPreference: document.documentElement.dataset.themePreference,
    }))
    assert(
      systemMode.preference === 'system' &&
        systemMode.resolvedPreference === 'system',
      '跟随系统模式没有写入本地偏好',
    )
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === 'dark',
    )
    await page.emulateMedia({ colorScheme: 'light' })
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === 'light',
    )
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('.stats-grid')
    const restoredSystemMode = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      preference: document.documentElement.dataset.themePreference,
    }))
    assert(
      restoredSystemMode.theme === 'light' &&
        restoredSystemMode.preference === 'system',
      '刷新后没有恢复跟随系统模式',
    )
    await page
      .locator('.sidebar-appearance [data-theme-preference="dark"]')
      .click()
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === 'dark',
    )

    const currentValueCard =
      (await page.locator('.stat-primary').textContent()) ?? ''
    assert(
      currentValueCard.includes('已确认持仓净值') &&
        currentValueCard.includes('¥3,002.02') &&
        currentValueCard.includes('待确认 ¥0 未计入'),
      `首页没有使用逐产品收益推算净值：${currentValueCard}`,
    )
    await assertFontFloor(page, '.stats-grid', '收益概览桌面端')

    await page.goto(`${base}/investment/research`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.library-page')
    await assertNoLargeLightSurface(page, '.app-main', '报告库深色主题')
    await page.locator('.report-card').first().click()
    await page.waitForSelector('.rp-doc')
    await assertNoLargeLightSurface(page, '.rp-doc', '报告正文深色主题')
    await page.locator('.report-switcher-trigger').click()
    await page.waitForSelector('.report-switcher-pop')
    await assertNoLargeLightSurface(
      page,
      '.report-switcher-pop',
      '报告切换器深色主题',
    )
    await page.keyboard.press('Escape')
    await page.goto(`${base}/investment/tech-map`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.tm-view')
    await assertNoLargeLightSurface(page, '.app-main', '科技图谱深色主题')
    await page.goto(`${base}/investment/tech-map?view=tree`, {
      waitUntil: 'networkidle',
    })
    await page.waitForSelector('.tm-tree-view')
    await assertNoLargeLightSurface(page, '.app-main', '科技图谱树状深色主题')
    await page.goto(`${base}/investment/tech-map?view=table`, {
      waitUntil: 'networkidle',
    })
    await page.waitForSelector('.tm-table-view')
    await assertNoLargeLightSurface(page, '.app-main', '科技图谱表格深色主题')

    await page.goto(`${base}/ledger/daily`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.ledger-panel')
    await assertNoLargeLightSurface(page, '.app-main', '每日记账深色主题')
    await page.locator('.ledger-table tbody tr').first().hover()
    await assertNoLargeLightSurface(page, '.ledger-table', '账本表格悬浮深色主题')
    await page.getByRole('button', { name: '调整起始' }).click()
    await page.waitForSelector('.capital-dialog[open]')
    await assertNoLargeLightSurface(
      page,
      '.capital-dialog[open]',
      '本金设置弹窗深色主题',
    )
    await page.keyboard.press('Escape')
    assert(
      (await page.locator('.rw-quick-card').count()) === 2,
      '每日记账应只保留交易截图和收益截图两个主入口',
    )
    assert(
      (await page.locator('.ledger-table tbody tr').count()) === 1,
      '每日记账没有渲染历史记录',
    )
    const incomeHistory = page.locator('.income-history')
    await incomeHistory.waitFor()
    const incomeHistorySummary =
      (await incomeHistory.locator('summary').textContent()) ?? ''
    assert(
      incomeHistorySummary.includes('4 张'),
      `收益截图历史数量不正确：${JSON.stringify(incomeHistorySummary)}`,
    )
    await incomeHistory.locator('summary').click()
    await page.waitForFunction(
      () => document.querySelectorAll('.income-history-card').length === 4,
    )
    const incomeHistoryText = (await incomeHistory.textContent()) ?? ''
    for (const label of ['已入账', '已忽略', '同金额已忽略', '金额冲突']) {
      assert(incomeHistoryText.includes(label), `收益截图历史缺少状态：${label}`)
    }
    assert(
      incomeHistoryText.includes('2026-10-18') &&
        incomeHistoryText.includes('120056A') &&
        incomeHistoryText.includes('E2E 金额冲突截图'),
      '收益截图历史缺少关联日期、产品代码或备注',
    )
    const originalHref = await incomeHistory
      .locator('a[aria-label^="查看收益截图原图"]')
      .first()
      .getAttribute('href')
    assert(originalHref, '收益截图历史没有原图入口')
    const originalImage = await fetch(new URL(originalHref, base))
    assert(originalImage.status === 200, '收益截图原图无法访问')
    assert(
      (originalImage.headers.get('content-type') || '').includes('image/png'),
      '收益截图原图响应类型不正确',
    )
    const accountHistoryLink = incomeHistory
      .getByRole('link', { name: '查看当日账户收益' })
      .first()
    assert(
      (await accountHistoryLink.getAttribute('href'))?.includes(
        '/ledger/daily?date=2026-10-18#records',
      ),
      '收益截图历史没有关联到账户收益记录',
    )
    await accountHistoryLink.click()
    await page.waitForURL('**/ledger/daily?date=2026-10-18#records')
    await page.waitForSelector('#recordDate')
    assert(
      (await page.locator('#recordDate').inputValue()) === '2026-10-18',
      '收益截图历史没有打开对应账户收益记录',
    )
    await incomeHistory
      .getByRole('link', { name: '查看逐产品收益档案' })
      .first()
      .click()
    await page.waitForURL('**/ledger/trades?product=120056A#valuations')
    await page.waitForSelector('.product-valuation-panel .pv-card.is-selected')
    await page.waitForSelector('.product-valuation-panel .pv-detail-head')
    assert(
      ((await page.locator('.product-valuation-panel .pv-detail-head').textContent()) ?? '')
        .includes('120056A'),
      '收益截图历史没有打开对应产品收益档案',
    )
    await page.goto(`${base}/ledger/daily`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.income-history')
    await page.locator('.income-history > summary').click()
    await assertFontFloor(page, '.income-history', '收益截图历史桌面端')

    await page.locator('.capture-manual > summary').click()
    await assertNoLargeLightSurface(page, '.capture-manual', '手工补正深色主题')
    await page.getByLabel('发生了什么').fill('E2E 特殊事项：额度临时关闭')
    await page.getByRole('button', { name: '交给平台跟踪' }).click()
    await page.waitForFunction(
      () => document.querySelector('.toast')?.textContent?.includes('特殊情况已交给 AI 跟进'),
      null,
      { timeout: 5000 },
    )

    await page.locator('.ledger-table .icon-button.is-danger').first().click()
    await page.waitForSelector('.confirm-dialog')
    await page.getByRole('button', { name: '取消' }).click()
    assert(
      (await page.locator('.ledger-table tbody tr').count()) === 1,
      '取消删除后记录不应消失',
    )

    await page.goto(`${base}/ledger/review`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.monthly-record-panel')
    await assertNoLargeLightSurface(page, '.app-main', '复盘深色主题')
    const reviewSectionOrder = await page
      .locator('.r2-stack > [id]')
      .evaluateAll((sections) => sections.map((section) => section.id))
    assert(
      reviewSectionOrder.join(',') === 'score,rhythm,monthly-notes,quarterly-notes',
      `复盘页模块顺序不正确：${reviewSectionOrder.join(',')}`,
    )
    assert(
      (await page.locator('.review-module-card').count()) === 2,
      '复盘页应有复盘节奏和自动复盘两张模块卡',
    )
    assert(
      (await page.locator('.rw-node').count()) === 4,
      '复盘时间轴应有 4 个节点',
    )
    assert(
      (await page.locator('.record-day').count()) >= 28,
      '月度记录日历没有渲染完整月份',
    )
    assert(
      (await page.locator('.recent-day-row').count()) === 7,
      '最近 7 天卡片行数不正确',
    )
    assert(
      (await page.locator('#monthly-notes .rw-question').count()) === 5,
      '月度五问应有 5 个问题',
    )
    await page.locator('#monthly-notes > summary').click()
    await assertNoLargeLightSurface(page, '#monthly-notes', '月度五问深色主题')
    await page.locator('#score .review-history-row').first().hover()
    await assertNoLargeLightSurface(page, '#score', '复盘历史悬浮深色主题')
    assert(
      (await page.locator('#monthly-notes .rw-question:visible').count()) === 5,
      '展开月度五问后应显示 5 个问题',
    )
    const missingDay = page.locator('.record-day.is-missing').first()
    const missingText = (await missingDay.textContent())?.trim() || ''
    await missingDay.click()
    await page.waitForSelector('#recordDate')
    assert(
      new URL(page.url()).pathname === '/ledger/daily',
      '点击缺记日期应跳到每日记账',
    )
    assert(
      (await page.locator('#recordDate').inputValue()).endsWith(
        missingText.padStart(2, '0'),
      ),
      '点击缺记日期没有带入记账表单',
    )

    await page.goto(`${base}/ledger/trades`, { waitUntil: 'networkidle' })
    await page.waitForSelector('#inbox .rw-dropzone')
    await assertNoLargeLightSurface(page, '.app-main', '交易与持仓深色主题')
    const tradesSectionOrder = await page
      .locator('.r2-stack > section')
      .evaluateAll((sections) => sections.map((section) => section.id))
    assert(
      tradesSectionOrder.join(',') ===
        'current-value,holdings,valuations,trades,inbox',
      `交易与持仓页模块顺序不正确：${tradesSectionOrder.join(',')}`,
    )
    const currentValuationPanel =
      (await page.locator('#current-value').textContent()) ?? ''
    assert(
      currentValuationPanel.includes('¥3,002.02') &&
        currentValuationPanel.includes('银行对照') &&
        currentValuationPanel.includes('¥3,002.03') &&
        currentValuationPanel.includes('银行对照一致 ±¥0.01'),
      `持仓净值派生或银行对照不正确：${currentValuationPanel}`,
    )
    assert(
      (await page.locator('.back-to-top').count()) === 0,
      '页面顶部不应提前显示回到顶部悬浮球',
    )
    await assertFontFloor(
      page,
      '#current-value',
      '当前已确认持仓净值桌面端',
    )
    await page.evaluate(() => window.scrollTo({ top: 720, behavior: 'instant' }))
    await page.waitForSelector('.back-to-top')
    await page.locator('.back-to-top').click()
    await page.waitForFunction(() => window.scrollY < 2)
    assert(
      (await page.locator('#inbox .rw-dropzone').count()) === 1,
      '交易收件箱拖拽区没有渲染',
    )
    assert(
      (await page.locator('#holdings .rw-bucket').count()) >= 4,
      '持仓期限桶没有渲染',
    )
    const holdingsTerminology =
      (await page.locator('#holdings').textContent()) || ''
    assert(
      holdingsTerminology.includes('未赎回成本本金') &&
        !holdingsTerminology.includes('剩余本金'),
      '持仓页仍在使用有歧义的“剩余本金”名称',
    )
    assert(
      holdingsTerminology.includes('仅展示当前持仓状态') &&
        !holdingsTerminology.includes('参考上限 50%'),
      '发行方占比仍在持仓页显示限制或警示口径',
    )
    assert(
      (await page
        .locator('#holdings .rw-subpanel')
        .filter({ hasText: '发行方成本占比' })
        .locator('.rw-bar-fill.is-warn')
        .count()) === 0,
      '发行方占比仍被标记为警告色',
    )
    const tradesTerminology = (await page.locator('#trades').textContent()) || ''
    assert(
      tradesTerminology.includes('累计已实现盈亏') &&
        !tradesTerminology.includes('已实现收益'),
      '交易流水仍在使用有歧义的“已实现收益”名称',
    )
    assert(
      (await page.locator('.product-valuation-panel .pv-card').count()) === 2,
      '逐产品收益档案没有渲染两张产品卡',
    )
    await page.locator('.product-valuation-panel .pv-card').first().click()
    await page.waitForSelector('.product-valuation-panel .pv-table')
    assert(
      (await page.locator('.product-valuation-panel .pv-table tbody tr').count()) ===
        1,
      '逐产品收益详情没有渲染逐日记录',
    )
    await page
      .locator('.product-valuation-panel')
      .getByRole('button', { name: '补录一天' })
      .click()
    const valuationForm = page.locator('.product-valuation-panel .pv-form')
    await valuationForm.getByLabel('收益归属日').fill('2026-10-19')
    await valuationForm.getByLabel('到账/可见日').fill('2026-10-19')
    await valuationForm.getByLabel('持仓金额').fill('2000')
    await valuationForm.getByLabel('当日收益').fill('0.25')
    await valuationForm.getByLabel('修正原因（写入审计）').fill('E2E 手工补录')
    await valuationForm.getByRole('button', { name: '补录收益' }).click()
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '.product-valuation-panel .pv-table tbody tr',
        ).length === 2,
    )
    assert(
      (await page.locator('.product-valuation-panel .pv-audit').textContent())?.includes(
        'E2E 手工补录',
      ),
      '产品收益手工补录没有显示审计留痕',
    )
    await page
      .locator('.product-valuation-panel .pv-table')
      .getByRole('button', { name: '来源', exact: true })
      .first()
      .click()
    await page.waitForSelector('.dt-dialog')
    await assertNoLargeLightSurface(page, '.dt-dialog', '来源与修订深色主题')
    const traceDialogText = (await page.locator('.dt-dialog').textContent()) ?? ''
    assert(
      traceDialogText.includes('事实修订历史'),
      '产品收益来源面板没有显示事实修订历史',
    )
    assert(
      traceDialogText.includes('证据不完整'),
      '无匹配原始截图的产品收益没有显示证据不完整',
    )
    await assertFontFloor(page, '.dt-dialog', '来源与修订桌面端')
    await page.setViewportSize({ width: 390, height: 844 })
    await assertNoLargeLightSurface(
      page,
      '.dt-dialog',
      '来源与修订移动深色主题',
    )
    await assertFontFloor(page, '.dt-dialog', '来源与修订移动端')
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      '来源与修订移动端出现横向溢出',
    )
    await page.locator('.dt-dialog .dt-close').click()
    await page.waitForSelector('.dt-dialog', { state: 'detached' })
    await page.setViewportSize({ width: 1280, height: 900 })
    await assertFontFloor(page, '.product-valuation-panel', '逐产品收益档案桌面端')
    await page.getByRole('button', { name: '记一笔交易', exact: true }).click()
    await page.getByLabel('产品代码').fill('120026A')
    await page.getByLabel('产品名称').fill('招银理财14天')
    await page.getByLabel('买入金额').fill('5000')
    await page.getByLabel('期限（天，0 = 日开）').fill('14')
    await page
      .getByLabel('交易前决策理由')
      .fill('14 天期限与用钱安排匹配，完成买入前规则核对')
    await page
      .getByLabel('收益 / 流动性 / 风险预期')
      .fill('持有到期达到短期限 hurdle，并满足 14 天后流动性需求')
    await page
      .getByLabel('失效条件')
      .fill('实际收益低于 hurdle、规则变化或用钱日期提前时重新评估')
    await page.setViewportSize({ width: 390, height: 844 })
    await assertFontFloor(page, '#trades .rw-form', '交易前决策表单移动端')
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      '交易前决策表单移动端出现横向溢出',
    )
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.getByRole('button', { name: '保存交易' }).click()
    await page.waitForSelector('.rw-trade-status.is-pending')
    assert(
      (
        await page
          .locator('#trades .rw-stat-chip')
          .filter({ hasText: '待确认 1 笔' })
          .first()
          .textContent()
      )?.includes('5,000'),
      '待确认金额没有正确显示',
    )

    repository.decisionProposalStore.sync({
      meta: {
        today: '2026-10-22',
        product_snapshot_date: '2026-10-21',
      },
      workspace: { holding_reviews: [] },
      products: {
        allocation: { available_cash: 1800 },
        watchlist: [
          {
            code: 'E2E-CASH',
            name: 'E2E 资金冗余产品',
            selected: true,
            target_amount: 1800,
            target_pct: 6,
            allocation_bucket: 'short',
            allocation_reason: 'E2E 短期桶目标不足',
            selection_score: 80,
            quota_status: 'verified',
            quota_available: 3000,
            quota_verified_at: '2026-10-22',
          },
        ],
      },
    })
    const projectionRefresh = await fetch(`${base}/api/dashboard/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert(
      projectionRefresh.status === 200,
      '显式 Dashboard 状态投影应成功',
    )
    await page.goto(`${base}/ledger/inbox`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.inbox-page')
    await assertNoLargeLightSurface(page, '.app-main', '消息中心深色主题')
    await assertFontFloor(page, '.inbox-page', '消息中心桌面端')
    assert(
      (await page.locator('.inbox-message').count()) > 0,
      '消息中心没有聚合待处理交易或产品事件',
    )
    assert(
      (await page.locator('.inbox-source-group').count()) >= 2,
      '消息中心没有按来源分组',
    )
    const proposalMessage = page
      .locator('.inbox-message')
      .filter({ hasText: 'E2E 资金冗余产品' })
      .first()
    await proposalMessage.waitFor()
    page.once('dialog', (dialog) => void dialog.accept())
    await proposalMessage.getByRole('button', { name: '采纳提案' }).click()
    await page.waitForFunction(
      () => document.querySelector('.toast')?.textContent?.includes('提案已采纳'),
      null,
      { timeout: 5000 },
    )
    await page.getByRole('tab', { name: /提醒/ }).click()
    assert(
      ((await page.locator('.inbox-page').textContent()) ?? '').includes(
        '决策已采纳，待执行',
      ),
      '采纳后的提案没有进入待执行提醒',
    )
    await page.getByRole('tab', { name: /待处理/ }).click()
    const unreadBefore = await page.locator('.inbox-message.is-unread').count()
    assert(unreadBefore > 0, '消息中心没有显示未读状态')
    await page.getByRole('button', { name: /全部已读/ }).click()
    await page.waitForTimeout(300)
    assert(
      (await page.locator('.inbox-message.is-unread').count()) === 0,
      '全部已读后仍有未读消息',
    )

    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${base}/ledger/daily`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.income-capture-layout')
    const mobileThemeToggle = page.locator('.mobile-topbar .theme-toggle')
    assert(
      (await page.evaluate(
        () => document.documentElement.dataset.themePreference,
      )) === 'dark',
      '移动端没有保持桌面选择的深色主题',
    )
    await assertNoLargeLightSurface(page, '.app-main', '每日记账移动深色主题')
    await mobileThemeToggle.click()
    await page.waitForSelector('.theme-mode-menu')
    await assertFontFloor(page, '.theme-mode-menu', '移动端主题模式菜单')
    await page
      .getByRole('menuitemradio', { name: /浅色/ })
      .click()
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === 'light',
    )
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('.income-capture-layout')
    assert(
      (await page.evaluate(
        () => document.documentElement.dataset.themePreference,
      )) === 'light',
      '移动端切换浅色主题后没有持久化',
    )
    await page.locator('.mobile-topbar .theme-toggle').click()
    await page
      .getByRole('menuitemradio', { name: /深色/ })
      .click()
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === 'dark',
    )
    await page.locator('.income-history > summary').click()
    await page.waitForFunction(
      () => document.querySelectorAll('.income-history-card').length === 4,
    )
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      '移动端每日记账出现横向溢出',
    )
    await assertFontFloor(page, '.rw-quick', '每日记账移动端')
    await assertFontFloor(page, '.income-history', '收益截图历史移动端')
    await page.goto(`${base}/ledger/inbox`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.inbox-page')
    await assertNoLargeLightSurface(page, '.app-main', '消息中心移动深色主题')
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      '移动端消息中心出现横向溢出',
    )
    await assertFontFloor(page, '.inbox-page', '消息中心移动端')
    await page.goto(`${base}/ledger/trades`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.product-valuation-panel .pv-card')
    await assertNoLargeLightSurface(page, '.app-main', '交易与持仓移动深色主题')
    await assertFontFloor(
      page,
      '#current-value',
      '当前已确认持仓净值移动端',
    )
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      '移动端当前持仓净值出现横向溢出',
    )
    await page.evaluate(() => window.scrollTo({ top: 720, behavior: 'instant' }))
    await page.waitForSelector('.back-to-top')
    const mobileBackToTop = await page.locator('.back-to-top').evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    })
    assert(
      mobileBackToTop.width >= 40 && mobileBackToTop.height >= 40,
      '移动端回到顶部悬浮球触控区域过小',
    )
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      '移动端逐产品收益档案出现横向溢出',
    )
    await assertFontFloor(page, '.product-valuation-panel', '逐产品收益档案移动端')
    await page.setViewportSize({ width: 1280, height: 900 })

    await page.goto(`${base}/ledger/products`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.allocation-bucket')
    await assertNoLargeLightSurface(page, '.app-main', '产品与配置深色主题')
    const productSectionOrder = await page
      .locator('.r2-stack > section')
      .evaluateAll((sections) => sections.map((section) => section.id))
    assert(
      productSectionOrder.join(',') === 'holding-reviews,products,events',
      `产品与配置页模块顺序不正确：${productSectionOrder.join(',')}`,
    )
    assert(
      (await page.locator('.allocation-bucket').count()) === 3,
      '产品区没有渲染三个期限桶的分配结果',
    )
    assert(
      (await page.locator('.allocation-target').count()) >= 1,
      '产品区没有渲染目标金额',
    )
    assert(
      (await page.locator('.product-module-card').count()) >= 4,
      '产品页应有配置、目标产品、观察名单和风险边界模块卡',
    )
    await page.getByRole('button', { name: '调整假设', exact: true }).click()
    await page.waitForSelector('#assumptionsCardTitle')
    await assertNoLargeLightSurface(page, '.app-main', '配置假设深色主题')
    const assumptionsText =
      (await page
        .locator('section[aria-labelledby="assumptionsCardTitle"]')
        .textContent()) || ''
    assert(
      !assumptionsText.includes('单发行方上限'),
      '产品配置仍在显示单发行方上限设置',
    )
    await page.getByRole('button', { name: '收起', exact: true }).click()
    await page.waitForSelector('#holding-reviews .hr-card')
    const holdingReviewCards = page.locator('#holding-reviews .hr-card')
    const holdingReviewCount = await holdingReviewCards.count()
    const holdingSearch = page.getByLabel('搜索持仓')
    await holdingSearch.click()
    await page.waitForSelector('#holding-review-search-options')
    const searchOptions = page.locator('#holding-review-search-options .hr-search-option')
    assert((await searchOptions.count()) > 0, '点击持仓搜索框没有展开持仓下拉')
    const suggestedCode = await searchOptions.first().getAttribute('data-review-code')
    assert(suggestedCode, '持仓搜索下拉缺少产品代码')
    await searchOptions.first().click()
    assert(
      (await holdingSearch.inputValue()) === suggestedCode,
      '点击持仓搜索下拉后没有带入产品代码',
    )
    assert(
      (await page.locator('#holding-review-search-options').count()) === 0,
      '选择持仓下拉项后没有收起下拉',
    )
    await holdingSearch.fill('')
    const firstHoldingCode = (
      (await holdingReviewCards.first().locator('.hr-card-title small').textContent()) ?? ''
    )
      .split('·')[0]
      .trim()
    assert(firstHoldingCode, '持仓复核卡片没有产品代码')
    await holdingSearch.fill(firstHoldingCode)
    await holdingSearch.press('Escape')
    await page.waitForFunction(
      (code) =>
        Array.from(document.querySelectorAll('#holding-reviews .hr-card')).every(
          (card) => card.textContent?.includes(code),
        ),
      firstHoldingCode,
    )
    assert(
      (await holdingReviewCards.count()) > 0,
      '按产品代码搜索持仓没有结果',
    )
    await holdingSearch.fill('不存在的持仓代码')
    await page.waitForSelector('#holding-review-search-options')
    assert(
      (
        await page
          .locator('#holding-review-search-options .hr-search-menu-empty')
          .textContent()
      )?.includes('没有匹配的持仓'),
      '持仓搜索下拉没有显示无结果状态',
    )
    await holdingSearch.press('Escape')
    await page.waitForSelector('#holding-reviews .hr-filter-empty')
    await page
      .locator('#holding-reviews .hr-filter-empty')
      .getByRole('button', { name: '清除筛选' })
      .click()
    assert(
      (await holdingReviewCards.count()) === holdingReviewCount,
      '清除搜索后没有恢复全部持仓',
    )
    const firstVerdict = await holdingReviewCards.first().getAttribute('data-verdict')
    assert(firstVerdict, '持仓复核卡片缺少复核结论')
    await page
      .locator(`#holding-reviews [data-filter="${firstVerdict}"]`)
      .click()
    await page.waitForFunction(
      (verdict) => {
        const cards = Array.from(
          document.querySelectorAll('#holding-reviews .hr-card'),
        )
        return (
          cards.length > 0 &&
          cards.every((card) => card.getAttribute('data-verdict') === verdict)
        )
      },
      firstVerdict,
    )
    await page
      .locator('#holding-reviews .hr-filter-meta')
      .getByRole('button', { name: '清除筛选' })
      .click()
    assert(
      (await holdingReviewCards.count()) === holdingReviewCount,
      '清除结论筛选后没有恢复全部持仓',
    )
    await assertFontFloor(page, '#holding-reviews', '当前持仓与同桶候选桌面端')
    await page.setViewportSize({ width: 390, height: 844 })
    await holdingSearch.scrollIntoViewIfNeeded()
    await holdingSearch.click()
    await page.waitForSelector('#holding-review-search-options')
    const mobileSearchMenuVisible = await page
      .locator('#holding-review-search-options')
      .evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return rect.top >= 0 && rect.bottom <= window.innerHeight
      })
    assert(
      mobileSearchMenuVisible,
      '移动端持仓搜索下拉超出可视区域',
    )
    await holdingSearch.press('Escape')
    await page.setViewportSize({ width: 1280, height: 900 })

    await page.getByRole('button', { name: '查看全部产品' }).click()
    const poolDialog = page.locator(
      '.product-dialog:not(.product-detail-dialog)[open]',
    )
    await poolDialog.waitFor()
    await assertNoLargeLightSurface(page, '.product-dialog[open]', '候选池弹窗深色主题')
    assert(
      (await page.locator('dialog[open]').count()) === 1,
      '打开候选池时不应同时存在其他弹窗',
    )
    const poolHeaders = await poolDialog.locator('thead th').allTextContents()
    assert(
      poolHeaders.some((text) => text.includes('加权年化')),
      '候选池缺少加权年化列',
    )
    await poolDialog.getByRole('button', { name: /加权年化/ }).click()
    const weightedSortState =
      (await poolDialog.locator('.dialog-sort-bar strong').textContent())?.trim() ?? ''
    assert(
      weightedSortState.includes('加权年化') &&
        weightedSortState.includes('降序'),
      `加权年化排序状态不正确：${weightedSortState}`,
    )
    await poolDialog.getByRole('button', { name: '短期 7–30 天' }).click()
    await poolDialog.locator('th.sortable').first().click()
    const poolFilterBefore = (
      (await poolDialog.locator('.dialog-filter-bar').textContent()) ?? ''
    )
      .replace(/\s+/g, ' ')
      .trim()
    const poolSortBefore =
      (await poolDialog.locator('.dialog-sort-bar strong').textContent())?.trim() ?? ''
    assert(
      poolSortBefore.includes('按期限') && poolSortBefore.includes('短到长'),
      `候选池排序状态不符合预期：${poolSortBefore}`,
    )
    const poolScrollBefore = await poolDialog.evaluate((element) => {
      const available = element.scrollHeight - element.clientHeight
      element.scrollTop = Math.min(320, available)
      return element.scrollTop
    })
    assert(poolScrollBefore > 0, '候选池没有可滚动内容，无法验证滚动恢复')
    const rowTarget = await poolDialog.evaluate((element) => {
      const dialogRect = element.getBoundingClientRect()
      const buttons = Array.from(element.querySelectorAll('.product-name-button'))
      for (const button of buttons) {
        const box = button.getBoundingClientRect()
        if (box.top > dialogRect.top + 150 && box.bottom < dialogRect.bottom - 140) {
          return {
            code: button.dataset.productCode || '',
            name: button.querySelector('strong')?.textContent?.trim() || '',
            x: box.left + 12,
            y: box.top + box.height / 2,
          }
        }
      }
      return null
    })
    assert(rowTarget?.name, '候选池没有找到可见的产品详情入口')
    await page.mouse.click(rowTarget.x, rowTarget.y)
    const detailDialog = page.locator('.product-detail-dialog[open]')
    await detailDialog.waitFor()
    await assertNoLargeLightSurface(
      page,
      '.product-detail-dialog[open]',
      '产品详情深色主题',
    )
    assert(
      (await page.locator('dialog[open]').count()) === 1,
      '候选池行详情不应与候选池弹窗叠层',
    )
    assert(
      ((await detailDialog.locator('h2').first().textContent()) ?? '').trim() ===
        rowTarget.name,
      '候选池行详情显示了错误的产品名称',
    )
    const detailText = (await detailDialog.textContent()) ?? ''
    assert(detailText.includes(rowTarget.code), '产品详情没有显示产品代码')
    for (const section of ['收益快照', '产品信息', '研究评分', '当前配置', '可用额度']) {
      assert(detailText.includes(section), `产品详情缺少“${section}”内容`)
    }
    assert(
      (await detailDialog.locator('.detail-item').count()) >= 20,
      '产品详情字段数量不足',
    )

    await detailDialog.locator('.dialog-head .icon-button').click()
    await page.waitForSelector('.product-detail-dialog[open]', { state: 'detached' })
    await poolDialog.waitFor()
    await page.waitForFunction(
      (expected) => {
        const dialog = document.querySelector(
          '.product-dialog:not(.product-detail-dialog)[open]',
        )
        return dialog && Math.abs(dialog.scrollTop - expected) <= 1
      },
      poolScrollBefore,
      { timeout: 3000 },
    )
    const poolFilterAfter = (
      (await poolDialog.locator('.dialog-filter-bar').textContent()) ?? ''
    )
      .replace(/\s+/g, ' ')
      .trim()
    const poolSortAfter =
      (await poolDialog.locator('.dialog-sort-bar strong').textContent())?.trim() ?? ''
    assert(
      (await poolDialog.locator('.term-filter button.is-active').textContent())?.trim() ===
        '短期 7–30 天',
      '关闭详情后候选池期限筛选没有保留',
    )
    assert(poolFilterAfter === poolFilterBefore, '关闭详情后候选池筛选结果发生变化')
    assert(poolSortAfter === poolSortBefore, '关闭详情后候选池排序发生变化')
    assert(
      (await page.evaluate(() =>
        document.activeElement?.getAttribute('data-product-code'),
      )) === rowTarget.code,
      '关闭详情后焦点没有回到原产品入口',
    )
    await page.setViewportSize({ width: 390, height: 844 })
    await assertFontFloor(
      page,
      '.product-dialog:not(.product-detail-dialog)[open]',
      '普通可买候选池移动端',
    )
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      '普通可买候选池移动端出现页面级横向溢出',
    )
    await page.setViewportSize({ width: 1280, height: 900 })
    await poolDialog.locator('.dialog-head .icon-button').click()
    await page.waitForSelector('.product-dialog:not(.product-detail-dialog)[open]', {
      state: 'detached',
    })

    const observationCards = page.locator('.observation-card')
    assert((await observationCards.count()) > 0, '观察名单没有可点击产品')
    await observationCards.first().click()
    await page.waitForSelector('.product-detail-dialog[open]')
    assert(
      ((await page.locator('.product-detail-dialog h2').first().textContent()) ?? '').trim()
        .length > 0,
      '产品详情弹窗没有显示产品名称',
    )
    await page.locator('.product-detail-dialog .icon-button').first().click()
    const eventChip = page
      .locator('#events .rw-stat-chip')
      .filter({ hasText: '待复核' })
      .first()
    assert(
      ((await eventChip.textContent()) ?? '').replace(/\s+/g, '').includes('待复核1'),
      '特殊事项没有进入待复核',
    )

    await fetch(`${base}/api/trades`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trade_date: '2026-10-19',
        confirm_date: '2026-10-20',
        trade_type: 'buy',
        status: 'confirmed',
        product_code: '120056A',
        product_name: '招银理财招睿添金90天持有期6号A',
        issuer: '招银理财',
        risk_level: 'R2',
        amount: 5000,
        term_days: 90,
        maturity_date: null,
        notes: 'e2e holding review',
      }),
    })
    await page.goto(`${base}/ledger/products`, { waitUntil: 'networkidle' })
    await page.waitForSelector('#holding-reviews .hr-card')
    const reviewCard = page.locator('#holding-reviews .hr-card').first()
    assert(
      ((await page.locator('#holding-reviews .rw-toolbar .rw-panel-title').textContent()) ?? '').includes(
        '当前持仓 vs 同桶候选',
      ),
      '持仓复核卡片没有渲染',
    )
    await reviewCard.locator('.hr-actions button').click()
    await page.waitForSelector('#holding-reviews .hr-candidate')
    await assertNoLargeLightSurface(
      page,
      '#holding-reviews',
      '展开候选深色主题',
    )
    await page.setViewportSize({ width: 390, height: 844 })
    await assertNoLargeLightSurface(
      page,
      '#holding-reviews',
      '持仓复核移动深色主题',
    )
    await assertFontFloor(page, '#holding-reviews', '当前持仓与同桶候选移动端')
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      '持仓复核移动端出现横向溢出',
    )
    await page.setViewportSize({ width: 1280, height: 900 })
    assert(
      (await reviewCard.locator('.hr-candidate').count()) === 3,
      '持仓复核默认应只展开前 3 个候选',
    )
    assert(
      (await reviewCard.locator('.hr-compare').count()) === 1,
      '持仓复核没有渲染首选候选并排对比',
    )
    assert(
      (await reviewCard.locator('.hr-compare-col.is-current').count()) === 1 &&
        (await reviewCard.locator('.hr-compare-col.is-candidate').count()) === 1,
      '并排对比没有同时渲染当前持仓和首选候选',
    )
    assert(
      ((await reviewCard.locator('.hr-compare-result').textContent()) ?? '').includes(
        '预计多赚',
      ),
      '并排对比没有显示预计多赚结果',
    )
    assert(
      (await reviewCard.locator('.hr-candidate').count()) > 0,
      '持仓复核没有渲染同桶候选',
    )
    assert(
      ((await reviewCard.locator('.hr-metrics').textContent()) ?? '').includes(
        '估算 T+1 / T+0',
      ),
      '未核验的当前产品 T+N 没有显示估算标识',
    )
    await reviewCard.getByLabel('赎回确认 T+N').fill('1')
    await reviewCard.getByLabel('赎回到账 T+N').fill('1')
    await reviewCard.getByLabel('口径核验日期').fill('2026-10-20')
    await reviewCard.getByRole('button', { name: '保存并重算' }).click()
    await page.waitForFunction(
      () =>
        document.querySelector('#holding-reviews')?.textContent?.includes('T+1 / 到账 T+1'),
      null,
      { timeout: 5000 },
    )
    await reviewCard.getByRole('button', { name: '核验 T+1' }).first().click()
    await page.waitForFunction(
      () =>
        document.querySelector('#holding-reviews .hr-compare')?.textContent?.includes(
          '已核验',
        ),
      null,
      { timeout: 5000 },
    )
    const planButton = reviewCard.getByRole('button', { name: '记录到期计划' })
    const replaceButton = reviewCard.getByRole('button', { name: '记录替换决策' })
    const actionButton =
      (await planButton.count()) > 0 ? planButton.first() : replaceButton.first()
    if ((await planButton.count()) > 0 || (await replaceButton.count()) > 0) {
      await actionButton.click()
      await reviewCard.locator('.hr-decision-form').waitFor()
      await reviewCard.getByRole('button', { name: '写入决策日志' }).click()
      await page.waitForFunction(
        () =>
          document.querySelector('.toast')?.textContent?.includes('已写入决策日志'),
        null,
        { timeout: 5000 },
      )
    }

    await page.goto(`${base}/ledger/evaluation`, { waitUntil: 'networkidle' })
    await page.waitForSelector('#automation .rw-automation-grid')
    await assertNoLargeLightSurface(page, '.app-main', '决策与评估深色主题')
    const evaluationSectionOrder = await page
      .locator('.r2-stack > section')
      .evaluateAll((sections) => sections.map((section) => section.id))
    assert(
      evaluationSectionOrder.join(',') ===
        'proposals,decisions,calibration,automation',
      `决策与评估页模块顺序不正确：${evaluationSectionOrder.join(',')}`,
    )
    assert(
      ((await page.locator('#proposals .rw-panel-body').textContent()) ?? '').includes(
        'E2E 资金冗余产品',
      ),
      '决策与评估页没有展示已采纳提案',
    )
    await page.setViewportSize({ width: 390, height: 844 })
    await assertFontFloor(page, '#proposals', '决策提案移动端')
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      '决策提案移动端出现横向溢出',
    )
    await page.setViewportSize({ width: 1280, height: 900 })
    assert(
      (await page.locator('#calibration .calibration-panel').count()) === 1,
      '预测校准面板没有渲染',
    )
    await assertFontFloor(page, '#calibration', '预测校准桌面端')
    await page.setViewportSize({ width: 390, height: 844 })
    await assertFontFloor(page, '#calibration', '预测校准移动端')
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      '预测校准移动端出现横向溢出',
    )
    await page.setViewportSize({ width: 1280, height: 900 })
    assert(
      (await page.getByRole('button', { name: '立即运行自动化' }).count()) === 1,
      '自动评估面板没有运行入口',
    )
    assert(
      (await page.locator('#decisions .rw-panel-body').count()) === 1,
      '决策日志没有渲染',
    )
    assert(
      ((await page.locator('#decisions .rw-panel-body').textContent()) ?? '').includes(
        '切换等待',
      ),
      '替换决策没有展示切换等待与核验状态',
    )
    const decisionText =
      (await page.locator('#decisions .rw-panel-body').textContent()) ?? ''
    assert(decisionText.includes('证据完整'), '决策日志没有显示完整证据状态')
    assert(decisionText.includes('待补证据'), '决策日志没有显示待补证据状态')
    assert(
      ((await page.locator('#automation .rw-panel-body').textContent()) ?? '').includes(
        '补充决策证据',
      ),
      '自动评估没有给出决策补证入口',
    )
    assert(
      ((await page.locator('#automation .rw-panel-body').textContent()) ?? '').includes(
        '等待交易或结果证据',
      ),
      '未知评估仍显示可空确认状态',
    )
    const automationText =
      (await page.locator('#automation .rw-panel-body').textContent()) ?? ''
    assert(
      automationText.includes('当前评估结论'),
      '自动评估没有区分当前结论与审计历史',
    )
    assert(
      automationText.includes('下次更新'),
      '自动评估没有说明结论更新时间',
    )

    const errorPage = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await errorPage.route('**/api/dashboard', (route) => route.abort())
    await errorPage.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
    await errorPage.waitForSelector('.dashboard-error-state')
    assert(
      (await errorPage.getByRole('button', { name: '重新加载' }).count()) === 1,
      '加载失败时没有重试入口',
    )
    await errorPage.close()

    assert(
      consoleErrors.length === 0,
      `控制台出现错误：\n${consoleErrors.join('\n')}`,
    )
    console.log(
      `E2E 通过：正文检索 ${hits} 条命中、报告直达无 iframe、左侧目录 ${outlineItems} 项、搜索切换、键盘切换、样式卸载、侧边栏七入口、双截图入口、消息中心、决策提案采纳、复盘模块卡与跨页补记、逐产品收益档案、产品配置、持仓复核与替换决策、候选池逐只详情与筛选/滚动恢复、交易流水、收件箱、自动评估、确认弹窗、错误兜底。`,
    )
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
