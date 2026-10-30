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
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { createServer } = require('../server.js')
const { openDatabase } = require('../lib/db.js')
const { shiftDate, todayShanghai } = require('../lib/metrics.js')
const { resolveProductCsv } = require('../server.js')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const e2eToday = todayShanghai()
const waitingYieldDate = shiftDate(e2eToday, -1)
const waitingFinalDate = shiftDate(e2eToday, 1)
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

async function assertResponsiveHomeLink(page, selector, expectedHref, label) {
  const link = page.locator(selector)
  assert((await link.count()) === 1, `${label}应有且仅有一个首页链接`)
  assert(await link.isVisible(), `${label}的首页链接不可见`)
  assert(
    (await link.getAttribute('href')) === expectedHref,
    `${label}的首页链接路径不正确`,
  )

  await link.focus()
  const state = await link.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      focused: document.activeElement === element,
      fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      insideViewport:
        rect.left >= -1 &&
        rect.top >= -1 &&
        rect.right <= window.innerWidth + 1 &&
        rect.bottom <= window.innerHeight + 1,
    }
  })
  assert(state.focused, `${label}的首页链接不可键盘聚焦`)
  assert(state.fontSize >= 12, `${label}的首页链接字号低于 12px`)
  assert(state.insideViewport, `${label}的首页链接超出当前视口`)

  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
    `${label}出现横向溢出`,
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
  const briefDates = readdirSync(path.join(root, 'market-briefs'))
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(file))
    .map((file) => file.slice(0, -3))
    .sort((left, right) => right.localeCompare(left))

  const browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))

  try {
    await page.goto(`${base}/investment/briefs`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.briefs-page')
    assert(
      (await page.locator('#nav-group-investment .sidebar-link').count()) === 3,
      '侧边栏投资分区应有 3 个入口',
    )
    assert(
      (await page
        .locator('#nav-group-investment .sidebar-link')
        .first()
        .innerText()).includes('每日简报'),
      '投资菜单第一项应为“每日简报”',
    )
    assert(
      (await page.title()).includes('每日市场简报'),
      '每日简报页面标题不正确',
    )
    if (!briefDates.length) {
      await page.waitForSelector('.briefs-message')
      const emptyText = (await page.locator('.briefs-message').innerText()) ?? ''
      assert(
        emptyText.includes('还没有每日简报') &&
          emptyText.includes('YYYY-MM-DD.md'),
        '空简报目录没有显示正确的引导状态',
      )
      assert(
        (await page.locator('.briefs-date-picker').count()) === 0,
        '空简报目录不应显示日期选择器',
      )
      await assertFontFloor(page, '.briefs-page', '每日简报空状态桌面端')
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        '每日简报空状态桌面端出现横向溢出',
      )
      await page.setViewportSize({ width: 390, height: 844 })
      await assertFontFloor(page, '.briefs-page', '每日简报空状态移动端')
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        '每日简报空状态移动端出现横向溢出',
      )
      await page.setViewportSize({ width: 1280, height: 900 })
    } else {
      assert(
        new URL(page.url()).searchParams.get('date') === briefDates[0],
        '每日简报未默认打开最新日期',
      )
      assert(
        (await page.locator('.briefs-date-picker option').count()) ===
          briefDates.length,
        '日期选择器没有只列出实际存在的 Markdown 简报',
      )
      const renderedTableCount = await page
        .locator('.brief-markdown table')
        .count()
      const wrappedTableCount = await page
        .locator('.brief-markdown .brief-table-scroll table')
        .count()
      assert(
        renderedTableCount === wrappedTableCount,
        'Markdown 表格没有全部放入独立滚动容器',
      )
      const latestBriefText =
        (await page.locator('.brief-markdown').innerText()) ?? ''
      assert(
        latestBriefText.includes('市场概览') &&
          latestBriefText.includes('一句话结论') &&
          (await page.locator('.briefs-heading h1').innerText()).includes(
            briefDates[0],
          ),
        '最新 Markdown 简报正文没有完整渲染',
      )
      await assertFontFloor(page, '.briefs-page', '每日简报桌面端')
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        '每日简报桌面端出现横向溢出',
      )

      if (briefDates[1]) {
        await page
          .locator('.briefs-date-picker select')
          .selectOption(briefDates[1])
        await page.waitForFunction(
          (date) =>
            new URL(window.location.href).searchParams.get('date') === date,
          briefDates[1],
        )
        await page.waitForFunction(
          (date) =>
            document
              .querySelector('.briefs-heading h1')
              ?.textContent?.includes(date),
          briefDates[1],
        )
        assert(
          (await page.locator('.briefs-heading h1').innerText()).includes(
            briefDates[1],
          ),
          '切换日期后没有渲染指定日期的 Markdown',
        )
      }

      await page.setViewportSize({ width: 390, height: 844 })
      await assertFontFloor(page, '.briefs-page', '每日简报移动端')
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        '每日简报移动端出现横向溢出',
      )
      await page.setViewportSize({ width: 1280, height: 900 })
    }

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
    const legacyReport = await fetch(
      `${base}/research/stocks/${encodeURIComponent(reportManifest.reports[0].file)}`,
    )
    assert(legacyReport.status === 404, '旧静态报告地址仍然可访问')
    const legacyNav = await fetch(`${base}/research/scripts/report-nav.js`)
    assert(legacyNav.status === 404, '旧静态报告导航仍然可访问')

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
    assert(
      (await page.locator('.rp-doc [data-report-page-home]').count()) === 0,
      '应用内报告正文重复显示静态首页链接',
    )
    assert(
      (await page
        .locator('.reader-topbar-actions a[href*="/research/stocks/"]')
        .count()) === 0,
      '报告阅读页仍存在静态原文入口',
    )
    assert(
      !(await page.locator('.reader-topbar-actions').innerText()).includes('原文'),
      '报告顶部操作区仍显示“原文”',
    )

    const reportMobilePage = await browser.newPage({
      viewport: { width: 390, height: 844 },
    })
    reportMobilePage.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    reportMobilePage.on('pageerror', (error) => consoleErrors.push(error.message))
    try {
      await reportMobilePage.goto(page.url(), { waitUntil: 'networkidle' })
      await reportMobilePage.waitForSelector('.rp-doc')
      assert(
        (await reportMobilePage
          .locator('.reader-topbar-actions a[href*="/research/stocks/"]')
          .count()) === 0,
        '移动端报告阅读页仍存在静态原文入口',
      )
      await assertFontFloor(reportMobilePage, '.reader-topbar', '报告阅读页移动端')
      assert(
        await reportMobilePage.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        '报告阅读页移动端出现横向溢出',
      )
    } finally {
      await reportMobilePage.close()
    }

    const staticReportPage = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    })
    staticReportPage.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    staticReportPage.on('pageerror', (error) => consoleErrors.push(error.message))
    try {
      const staticReportUrl = pathToFileURL(
        path.join(root, 'report', reportManifest.reports[0].file),
      ).href
      await staticReportPage.goto(staticReportUrl, { waitUntil: 'load' })
      await assertResponsiveHomeLink(
        staticReportPage,
        '[data-report-page-home]',
        '../research/index.html',
        '桌面端静态报告',
      )
      await staticReportPage.setViewportSize({ width: 390, height: 844 })
      await staticReportPage.reload({ waitUntil: 'load' })
      await assertResponsiveHomeLink(
        staticReportPage,
        '[data-report-page-home]',
        '../research/index.html',
        '移动端静态报告',
      )
      await Promise.all([
        staticReportPage.waitForURL(/\/research\/index\.html$/u),
        staticReportPage.locator('[data-report-page-home]').click(),
      ])
      await staticReportPage.waitForSelector('.grid')
      assert(
        (await staticReportPage.title()).includes('股票调研报告库'),
        '静态报告返回首页后没有进入独立报告库',
      )
    } finally {
      await staticReportPage.close()
    }

    const techMapPage = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    })
    techMapPage.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    techMapPage.on('pageerror', (error) => consoleErrors.push(error.message))
    try {
      for (const viewport of [
        { width: 1280, height: 900, label: '桌面端' },
        { width: 390, height: 844, label: '移动端' },
      ]) {
        await techMapPage.setViewportSize(viewport)
        for (const view of ['index.html', 'tree.html', 'table.html']) {
          await techMapPage.goto(
            pathToFileURL(
              path.join(root, 'public', 'research', 'techmap', view),
            ).href,
            { waitUntil: 'load' },
          )
          await techMapPage.waitForSelector('#vn')
          await assertResponsiveHomeLink(
            techMapPage,
            '#vn [data-research-home]',
            '../../../research/index.html',
            `${viewport.label}科技图谱 ${view}`,
          )
          assert(
            (await techMapPage
              .locator('#vn a:not([data-research-home])')
              .count()) === 3,
            `${viewport.label}科技图谱 ${view} 的版本切换不完整`,
          )
          assert(
            (await techMapPage.locator('#vn a[aria-current="page"]').count()) === 1,
            `${viewport.label}科技图谱 ${view} 缺少当前版本标记`,
          )
          await assertFontFloor(techMapPage, '#vn', `科技图谱 ${view}`)
        }
      }

      await techMapPage.goto(
        pathToFileURL(
          path.join(root, 'public', 'research', 'techmap', 'index.html'),
        ).href,
        { waitUntil: 'load' },
      )
      await Promise.all([
        techMapPage.waitForURL(/\/research\/index\.html$/u),
        techMapPage.locator('#vn [data-research-home]').click(),
      ])
      await techMapPage.waitForSelector('.grid')
      assert(
        (await techMapPage.title()).includes('股票调研报告库'),
        '科技图谱返回首页后没有进入独立报告库',
      )
    } finally {
      await techMapPage.close()
    }

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
    repository.productValuationStore.saveYieldSetting('120026A', {
      yield_lag_days: 2,
      source: 'app-rule',
      notes: 'E2E 产品收益 T+2 披露',
      verified_at: '2026-10-24',
    })
    repository.holdingValuationStore.createSnapshot(
      {
        as_of_date: '2026-10-24',
        total_value: 3103.03,
        source: 'user-confirmed',
        notes: 'E2E 已退役银行对照市值',
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
      dailyPnl = 5,
    }) => {
      const storedName = `e2e-income-${key}.png`
      writeFileSync(
        path.join(repository.incomeInboxDir, storedName),
        Buffer.from(ONE_PIXEL_PNG, 'base64'),
      )
      const parsed = {
        date: recordDate,
        daily_pnl: dailyPnl,
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
    addIncomeHistory({
      key: 'product-only',
      name: 'e2e-product-only.png',
      status: 'pending',
      recordDate: waitingYieldDate,
      appliedAt: null,
      productCode: '120026A',
      notes: 'E2E 产品-only 归档截图',
      warning: '未明确识别银行账户总收益，将按产品明细自动汇总',
      dailyPnl: null,
    })

    await page.goto(`${base}/`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.stats-grid')
    assert(
      !(await page.locator('.stats-grid').innerText()).includes('银行对照'),
      '收益概览仍显示已退役的银行对照告警',
    )
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
    const darkSemanticColors = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return {
        accent: style.getPropertyValue('--green').trim(),
        gain: style.getPropertyValue('--gain').trim(),
        loss: style.getPropertyValue('--loss').trim(),
      }
    })
    assert(
      darkSemanticColors.accent === '#91d5d5' &&
        darkSemanticColors.gain === '#78d7a4' &&
        darkSemanticColors.loss === '#ff8b81',
      `石墨青灰或涨跌色没有正确生效：${JSON.stringify(darkSemanticColors)}`,
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
    const lightSemanticColors = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return {
        gain: style.getPropertyValue('--gain').trim(),
        loss: style.getPropertyValue('--loss').trim(),
      }
    })
    assert(
      lightSemanticColors.gain === '#238b63' &&
        lightSemanticColors.loss === '#c24f43',
      `浅色主题涨跌色没有正确生效：${JSON.stringify(lightSemanticColors)}`,
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

    const currentValueCard = page.locator('.stat-primary')
    const currentValueCardText = (await currentValueCard.textContent()) ?? ''
    assert(
      currentValueCardText.includes('已确认持仓净值') &&
        currentValueCardText.includes('收益截至') &&
        currentValueCardText.includes('¥3,002.02') &&
        currentValueCardText.includes('本金') &&
        currentValueCardText.includes('产品收益') &&
        !currentValueCardText.includes('待确认') &&
        !currentValueCardText.includes('未计入'),
      `首页持仓净值卡展示不正确：${currentValueCardText}`,
    )
    const currentValueCardLayout = await currentValueCard.evaluate((card) => {
      const breakdown = card.querySelector('.stat-primary-breakdown')
      const chart = card.querySelector('.stat-spark')
      if (!breakdown) return null
      const cardRect = card.getBoundingClientRect()
      const breakdownRect = breakdown.getBoundingClientRect()
      const chartRect = chart?.getBoundingClientRect() ?? null
      return {
        noOverflow: card.scrollWidth <= card.clientWidth + 1,
        chartBelowBreakdown:
          !chartRect || breakdownRect.bottom <= chartRect.top + 0.5,
        chartInsideCard:
          !chartRect ||
          (chartRect.left >= cardRect.left - 0.5 &&
            chartRect.right <= cardRect.right + 0.5 &&
            chartRect.bottom <= cardRect.bottom + 0.5),
      }
    })
    assert(
      currentValueCardLayout?.noOverflow &&
        currentValueCardLayout.chartBelowBreakdown &&
        currentValueCardLayout.chartInsideCard,
      `首页持仓净值卡内容重叠或溢出：${JSON.stringify(currentValueCardLayout)}`,
    )
    await assertFontFloor(page, '.stats-grid', '收益概览桌面端')
    const assetRangeGroup = page.locator('[data-range-group="assets"]')
    const pnlRangeGroup = page.locator('[data-range-group="pnl"]')
    const activeRangeText = async (group) =>
      (
        (await group.locator('button[aria-pressed="true"]').textContent()) ??
        ''
      ).trim()
    assert(
      (await activeRangeText(assetRangeGroup)) === '30天' &&
        (await activeRangeText(pnlRangeGroup)) === '30天',
      '两张收益图初始时间范围没有保持一致',
    )
    await assetRangeGroup.getByRole('button', { name: '7天' }).click()
    assert(
      (await activeRangeText(assetRangeGroup)) === '7天' &&
        (await activeRangeText(pnlRangeGroup)) === '7天',
      '累计收益图切换时间范围后，每日收益图没有联动',
    )
    await pnlRangeGroup.getByRole('button', { name: '90天' }).click()
    assert(
      (await activeRangeText(assetRangeGroup)) === '90天' &&
        (await activeRangeText(pnlRangeGroup)) === '90天',
      '每日收益图切换时间范围后，累计收益图没有联动',
    )
    await pnlRangeGroup.getByRole('button', { name: '全部' }).click()
    assert(
      (await activeRangeText(assetRangeGroup)) === '全部' &&
        (await activeRangeText(pnlRangeGroup)) === '全部',
      '两张收益图没有同步切换到全部区间',
    )
    await assetRangeGroup.getByRole('button', { name: '30天' }).click()
    const pnlChart = page
      .locator('.chart-panel')
      .filter({ hasText: '每日收益与收益率' })
      .first()
    const axisZero = await pnlChart.locator('svg').evaluate((svg) => {
      const labels = Array.from(svg.querySelectorAll('text'))
      const leftZero = labels.find(
        (label) => label.textContent?.trim() === '0',
      )
      const rightZero = labels.find(
        (label) => label.textContent?.trim() === '0.000%',
      )
      const zeroLine = Array.from(svg.querySelectorAll('line')).find(
        (line) =>
          line.getAttribute('stroke') === 'var(--chart-zero)' &&
          line.getAttribute('y1') === line.getAttribute('y2'),
      )
      return {
        left: Number(leftZero?.getAttribute('y')),
        right: Number(rightZero?.getAttribute('y')),
        line: Number(zeroLine?.getAttribute('y1')),
      }
    })
    assert(
      Number.isFinite(axisZero.left) &&
        Math.abs(axisZero.left - axisZero.right) < 0.01 &&
        Math.abs(axisZero.left - axisZero.line) < 3.01,
      `收益与收益率零轴未对齐：${JSON.stringify(axisZero)}`,
    )
    const attributionPanel = page.locator('.return-attribution')
    await attributionPanel.waitFor()
    const overviewOrderAndGaps = await page.evaluate(() => {
      const charts = document.querySelector('.r2-overview-charts')
      const attribution = document.querySelector('.r2-overview-attribution')
      const shortcuts = document.querySelector('.r2-jump-grid')
      const chartPanels = Array.from(
        document.querySelectorAll('.r2-overview-charts .chart-panel'),
      )
      if (!charts || !attribution || !shortcuts || chartPanels.length < 2) {
        return null
      }
      const chartsRect = charts.getBoundingClientRect()
      const attributionRect = attribution.getBoundingClientRect()
      const shortcutsRect = shortcuts.getBoundingClientRect()
      const firstChartRect = chartPanels[0].getBoundingClientRect()
      const secondChartRect = chartPanels[1].getBoundingClientRect()
      return {
        order:
          charts.compareDocumentPosition(attribution) &
          Node.DOCUMENT_POSITION_FOLLOWING
            ? 'charts-before-attribution'
            : 'wrong-order',
        chartGap: secondChartRect.top - firstChartRect.bottom,
        attributionGap: attributionRect.top - chartsRect.bottom,
        shortcutGap: shortcutsRect.top - attributionRect.bottom,
      }
    })
    assert(
      overviewOrderAndGaps?.order === 'charts-before-attribution',
      '3% 目标差距归因没有放在收益图表之后',
    )
    assert(
      overviewOrderAndGaps.chartGap >= 17.5 &&
        overviewOrderAndGaps.attributionGap >= 17.5 &&
        overviewOrderAndGaps.shortcutGap >= 17.5,
      `收益概览卡片间距不足：${JSON.stringify(overviewOrderAndGaps)}`,
    )
    const attributionText = (await attributionPanel.textContent()) ?? ''
    assert(
      attributionText.includes('3% 目标差距归因') &&
        attributionText.includes('实际年化') &&
        attributionText.includes('目标差距') &&
        attributionText.includes('尺子一') &&
        attributionText.includes('尺子二') &&
        attributionText.includes('买入确认前等待') &&
        attributionText.includes('费用估算') &&
        attributionText.includes('账本实际收益') &&
        attributionText.includes('产品明细合计') &&
        attributionText.includes('实际 vs 期望收益') &&
        attributionText.includes('实际 vs 3%目标'),
      `收益概览没有渲染目标差距归因：${attributionText.slice(0, 240)}`,
    )
    assert(
      attributionText.includes('样本不足') &&
        attributionText.includes('账户收益始终以账本 daily_pnl 为准'),
      '样本不足时归因没有显示证据边界',
    )
    await attributionPanel.locator('.ra-products > summary').click()
    await attributionPanel
      .locator('.ra-product-table, .ra-empty-copy')
      .first()
      .waitFor()
    const attributionProductRows = attributionPanel.locator(
      '.ra-product-row:not(.is-head)',
    )
    if ((await attributionProductRows.count()) > 0) {
      const firstAttributionProduct = attributionProductRows.first()
      const referenceCell = firstAttributionProduct.locator(
        '[data-reference-status]',
      )
      assert(
        (await referenceCell.getAttribute('data-reference-policy-version')) ===
          'r2-term-yield-v1' &&
          ((await referenceCell.textContent()) ?? '').includes('可用窗口'),
        '收益归因产品行没有显示收益策略版本与可用窗口',
      )
      const firstAttributionText =
        (await firstAttributionProduct.textContent()) ?? ''
      assert(
        firstAttributionText.includes('当前持有') ||
          firstAttributionText.includes('已赎回'),
        '收益归因产品行没有显示当前持有或已赎回状态',
      )
      assert(
        firstAttributionText.includes('期望收益') &&
          firstAttributionText.includes('3%目标收益'),
        '收益归因产品行没有同时说明实际、期望收益与3%目标',
      )
      const comparisonAmounts = await firstAttributionProduct.evaluate(
        (row) => {
          const read = (selector) => {
            const attributeBySelector = {
              '[data-actual-pnl]': 'data-actual-pnl',
              '[data-expected-pnl]': 'data-expected-pnl',
              '[data-target-pnl]': 'data-target-pnl',
              '[data-actual-vs-reference-pnl]':
                'data-actual-vs-reference-pnl',
              '[data-actual-vs-target-pnl]': 'data-actual-vs-target-pnl',
            }
            const value = row
              .querySelector(selector)
              ?.getAttribute(attributeBySelector[selector])
            return value === null || value === undefined ? null : Number(value)
          }
          return {
            actual: read('[data-actual-pnl]'),
            expected: read('[data-expected-pnl]'),
            target: read('[data-target-pnl]'),
            actualVsExpected: read(
              '[data-actual-vs-reference-pnl]',
            ),
            actualVsTarget: read('[data-actual-vs-target-pnl]'),
          }
        },
      )
      if (
        Number.isFinite(comparisonAmounts.actual) &&
        Number.isFinite(comparisonAmounts.expected) &&
        Number.isFinite(comparisonAmounts.actualVsExpected)
      ) {
        assert(
          Math.abs(
            comparisonAmounts.actualVsExpected -
              (comparisonAmounts.actual - comparisonAmounts.expected),
          ) <= 0.011,
          `收益归因“实际 vs 期望收益”未按实际收益减期望收益：${JSON.stringify(comparisonAmounts)}`,
        )
      }
      if (
        Number.isFinite(comparisonAmounts.actual) &&
        Number.isFinite(comparisonAmounts.target) &&
        Number.isFinite(comparisonAmounts.actualVsTarget)
      ) {
        assert(
          Math.abs(
            comparisonAmounts.actualVsTarget -
              (comparisonAmounts.actual - comparisonAmounts.target),
          ) <= 0.011,
          `收益归因“实际 vs 3%目标”未按实际收益减目标收益：${JSON.stringify(comparisonAmounts)}`,
        )
      }
    }
    await assertFontFloor(page, '.return-attribution', '目标差距归因桌面端')
    await page.setViewportSize({ width: 390, height: 844 })
    const mobileCurrentValueCardLayout = await currentValueCard.evaluate(
      (card) => {
        const breakdown = card.querySelector('.stat-primary-breakdown')
        const chart = card.querySelector('.stat-spark')
        if (!breakdown) return null
        const cardRect = card.getBoundingClientRect()
        const breakdownRect = breakdown.getBoundingClientRect()
        const chartRect = chart?.getBoundingClientRect() ?? null
        return {
          noCardOverflow: card.scrollWidth <= card.clientWidth + 1,
          noPageOverflow:
            document.documentElement.scrollWidth <= window.innerWidth + 1,
          chartBelowBreakdown:
            !chartRect || breakdownRect.bottom <= chartRect.top + 0.5,
          chartInsideCard:
            !chartRect ||
            (chartRect.left >= cardRect.left - 0.5 &&
              chartRect.right <= cardRect.right + 0.5 &&
              chartRect.bottom <= cardRect.bottom + 0.5),
        }
      },
    )
    assert(
      mobileCurrentValueCardLayout?.noCardOverflow &&
        mobileCurrentValueCardLayout.noPageOverflow &&
        mobileCurrentValueCardLayout.chartBelowBreakdown &&
        mobileCurrentValueCardLayout.chartInsideCard,
      `移动端持仓净值卡内容重叠或溢出：${JSON.stringify(
        mobileCurrentValueCardLayout,
      )}`,
    )
    await assertFontFloor(page, '.stat-primary', '收益概览移动端持仓卡')
    await assertNoLargeLightSurface(
      page,
      '.return-attribution',
      '目标差距归因移动深色主题',
    )
    await assertFontFloor(page, '.return-attribution', '目标差距归因移动端')
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      '目标差距归因移动端出现横向溢出',
    )
    await page.setViewportSize({ width: 1280, height: 900 })

    const reasonOverviewPatch = await fetch(
      `${base}/api/dashboard/sections?include=overview`,
    ).then((response) => response.json())
    const reasonTemplate =
      reasonOverviewPatch.workspace.return_attribution.product_evidence
        .products[0]
    const reasonRows = [
      {
        reason: 'no_product_snapshot',
        code: 'E2E-NO-SNAPSHOT',
        label: '当前快照缺失',
        policy: null,
        holdingStatus: 'held',
      },
      {
        reason: 'unknown_term',
        code: 'E2E-UNKNOWN-TERM',
        label: '期限无法分桶',
        policy: 'r2-term-yield-v1',
        holdingStatus: 'redeemed',
      },
      {
        reason: 'no_available_horizons',
        code: 'E2E-NO-HORIZONS',
        label: '指定窗口均缺失',
        policy: 'r2-term-yield-v1',
        holdingStatus: 'held',
      },
    ]
    reasonOverviewPatch.workspace.return_attribution.product_evidence.products =
      reasonRows.map((row) => ({
        ...reasonTemplate,
        product_code: row.code,
        product_name: row.label,
        holding_status: row.holdingStatus,
        current_holding_amount: row.holdingStatus === 'held' ? 1000 : 0,
        reference_yield_pct: null,
        reference_yield_status: 'unavailable',
        reference_yield_reason: row.reason,
        reference_available_horizons: [],
        reference_normalized_weights: {},
        reference_yield_policy_version: row.policy,
        reference_data_date: null,
        reference_pnl: null,
        selection_estimate_pnl: null,
        actual_vs_reference_pnl: null,
        actual_vs_target_pnl: null,
        recorded_product_pnl: 0,
        recorded_days: 0,
      }))
    const reasonPage = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    })
    try {
      await reasonPage.route(
        '**/api/dashboard/sections?include=overview',
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(reasonOverviewPatch),
          })
        },
      )
      await reasonPage.goto(`${base}/ledger/overview`, {
        waitUntil: 'networkidle',
      })
      const reasonPanel = reasonPage.locator('.return-attribution')
      await reasonPanel.waitFor()
      await reasonPanel.locator('.ra-products > summary').click()
      const reasonCells = reasonPanel.locator('[data-reference-reason]')
      assert(
        (await reasonCells.count()) === 3,
        '收益归因三类不可计算原因没有全部渲染',
      )
      const renderedReasons = await reasonCells.evaluateAll((cells) =>
        cells.map((cell) => ({
          reason: cell.getAttribute('data-reference-reason'),
          policy: cell.getAttribute('data-reference-policy-version'),
          text: cell.textContent?.replace(/\s+/g, ' ').trim() || '',
        })),
      )
      for (const expected of reasonRows) {
        const rendered = renderedReasons.find(
          (item) => item.reason === expected.reason,
        )
        assert(
          rendered?.text.includes(expected.label),
          `收益归因原因码 ${expected.reason} 的文案不正确：${JSON.stringify(rendered)}`,
        )
        assert(
          rendered.policy === (expected.policy || ''),
          `收益归因原因码 ${expected.reason} 的策略版本不正确：${JSON.stringify(rendered)}`,
        )
      }
      const renderedHoldingStates = await reasonPanel
        .locator('.ra-holding-status')
        .allTextContents()
      assert(
        renderedHoldingStates.some((text) => text.includes('当前持有')) &&
          renderedHoldingStates.some((text) => text.includes('已赎回')),
        `收益归因未同时显示当前持有与已赎回状态：${renderedHoldingStates.join('、')}`,
      )
      await assertFontFloor(
        reasonPage,
        '.return-attribution',
        '收益归因原因码桌面端',
      )
      await reasonPage.setViewportSize({ width: 390, height: 844 })
      await assertFontFloor(
        reasonPage,
        '.return-attribution',
        '收益归因原因码移动端',
      )
      assert(
        await reasonPage.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        '收益归因原因码移动端出现横向溢出',
      )
    } finally {
      await reasonPage.close()
    }

    await page.goto(`${base}/investment/briefs`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.briefs-page')
    await assertNoLargeLightSurface(page, '.app-main', '每日简报深色主题')

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
    const ledgerHeaderText =
      (await page.locator('.ledger-table thead').textContent()) ?? ''
    const ledgerRowText =
      (await page.locator('.ledger-table tbody tr').first().textContent()) ?? ''
    assert(
      ledgerHeaderText.includes('持仓金额') &&
        !ledgerHeaderText.includes('R2 本金') &&
        ledgerRowText.includes('¥3,000.00') &&
        ledgerRowText.includes('0.0673%'),
      `账本没有按持仓金额展示收益率：${JSON.stringify(ledgerRowText)}`,
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
    const derivedDailyPnl = page.locator('#dailyPnl')
    assert(
      (await derivedDailyPnl.getAttribute('readonly')) !== null &&
        (await derivedDailyPnl.inputValue()) === '2.02',
      '每日收益仍可独立编辑或没有展示产品汇总值',
    )
    assert(
      ((await page.locator('#recordForm').textContent()) ?? '').includes(
        '账户总账来源：逐产品收益',
      ),
      '每日收益没有标明产品汇总来源',
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

    const productOnlyCard = page
      .locator('.income-correction-card')
      .filter({ hasText: 'e2e-product-only.png' })
    await productOnlyCard.waitFor()
    assert(
      ((await productOnlyCard.textContent()) ?? '').includes(
        '产品收益决定账户总账；这里只记录银行显示值用于差异核对',
      ),
      '产品-only 补正没有说明银行金额仅用于核对',
    )
    assert(
      (await productOnlyCard
        .getByLabel('银行账户总收益（仅核对，可选）')
        .inputValue()) === '',
      '产品-only 补正不应预填部分产品合计',
    )
    await productOnlyCard
      .getByRole('button', { name: '保存并汇总账户总账' })
      .click()
    await page.waitForFunction(
      () =>
        document
          .querySelector('.toast')
          ?.textContent?.includes('已按 1 只产品收益更新账户总账'),
      null,
      { timeout: 5000 },
    )
    const productOnlyHistory = page
      .locator('.income-history-card')
      .filter({ hasText: 'e2e-product-only.png' })
    await productOnlyHistory.waitFor()
    assert(
      ((await productOnlyHistory.textContent()) ?? '').includes(
        '产品汇总已入账',
      ),
      '产品-only 截图历史没有显示汇总入账状态',
    )
    assert(
      (await productOnlyHistory
        .getByRole('link', { name: '查看当日账户收益' })
        .count()) === 1,
      '产品-only 截图没有关联自动生成的账户总账',
    )

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
      (await page.locator('.ledger-table tbody tr').count()) === 2,
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
      currentValuationPanel.includes('¥3,003.02') &&
        currentValuationPanel.includes('按产品收益推算') &&
        !currentValuationPanel.includes('银行对照') &&
        !currentValuationPanel.includes('¥3,103.03') &&
        !currentValuationPanel.includes('查看银行原始证据'),
      `持仓净值派生或银行对照移除不完整：${currentValuationPanel}`,
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
      holdingsTerminology.includes('短 1–30 天') &&
        holdingsTerminology.includes('中 31–100 天') &&
        holdingsTerminology.includes('长 101 天+') &&
        holdingsTerminology.includes('短期流动性（7–30 天）'),
      '持仓页没有区分评分期限桶和 7–30 天流动性口径',
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
    const waitingNotice = page
      .locator('.pv-issues--waiting .pv-issue')
      .first()
    await waitingNotice.waitFor()
    const waitingNoticeText = (await waitingNotice.textContent()) ?? ''
    const waitingNoticeClass =
      (await waitingNotice.getAttribute('class')) ?? ''
    assert(
      waitingNoticeText.includes('等待到账') &&
        waitingNoticeText.includes(waitingFinalDate) &&
        waitingNoticeText.includes('最大 T+2') &&
        !waitingNoticeClass.includes('is-warn'),
      `等待到账没有使用中性状态或最终披露日错误：${waitingNoticeText}`,
    )
    assert(
      (await page
        .locator('.pv-issue.is-warn')
        .filter({ hasText: '最终差异' })
        .count()) === 0,
      '产品汇总驱动账户总账后仍出现独立总账差额告警',
    )
    const reconciliationSummaryText =
      (await page.locator('.pv-summary-chips').textContent()) ?? ''
    for (const label of ['等待到账', '最终差异', '待补产品', '核对一致']) {
      assert(
        reconciliationSummaryText.includes(label),
        `产品对账摘要缺少状态：${label}`,
      )
    }
    await page
      .locator('.product-valuation-panel .pv-card')
      .filter({ hasText: '120056A' })
      .click()
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

    const proposalToday = new Date().toISOString().slice(0, 10)
    repository.decisionProposalStore.sync({
      meta: {
        today: proposalToday,
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
            reference_yield_pct: 2.75,
            reference_yield_status: 'available',
            reference_yield_reason: 'complete_history',
            reference_available_horizons: ['1m', '3m', '6m'],
            reference_normalized_weights: {
              return_1m: 0.2,
              return_3m: 0.5,
              return_6m: 0.3,
            },
            yield_policy_version: 'r2-term-yield-v1',
            data_date: '2026-10-22',
            quota_status: 'verified',
            quota_available: 3000,
            quota_verified_at: proposalToday,
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
    const dashboardWithHoldings = await fetch(`${base}/api/dashboard`).then(
      (response) => response.json(),
    )
    const returnBaseRecord = dashboardWithHoldings.records.find(
      (record) => record.date === '2026-10-18',
    )
    assert(
      returnBaseRecord?.principal === 10000 &&
        returnBaseRecord?.holding_amount === 3000 &&
        Math.abs(
          returnBaseRecord.daily_return -
            returnBaseRecord.daily_pnl / returnBaseRecord.holding_amount,
        ) < 0.0000000001,
      `收益率没有按当日持仓金额计算：${JSON.stringify(returnBaseRecord)}`,
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
      () => document.querySelectorAll('.income-history-card').length === 5,
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
    const mobileValuationText =
      (await page.locator('.product-valuation-panel').textContent()) ?? ''
    assert(
      mobileValuationText.includes('等待到账') &&
        mobileValuationText.includes('最终差异') &&
        mobileValuationText.includes('其余产品到账后自动重算'),
      '移动端没有清晰区分等待到账与最终差异',
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
    const productGoalLocator = page.getByTestId('product-goal-text')
    const productGoalText = (await productGoalLocator.textContent()) ?? ''
    const productGoalMatch = productGoalText.match(
      /可评分\s+(\d+)\s+只（短\s*1–30\s*(\d+)\s*\/\s*中\s*31–100\s*(\d+)\s*\/\s*长\s*101\+\s*(\d+)）/,
    )
    assert(productGoalMatch, `产品池可评分统计缺失：${productGoalText}`)
    const [, scoreReady, scoreShort, scoreMedium, scoreLong] =
      productGoalMatch.map(Number)
    assert(
      scoreShort + scoreMedium + scoreLong === scoreReady,
      `产品池可评分总数与分桶数不一致：${productGoalText}`,
    )
    await assertFontFloor(page, '#products', '产品与配置桌面端')
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      '桌面端产品与配置页出现横向溢出',
    )
    await assertNoLargeLightSurface(page, '.app-main', '产品与配置深色主题')
    const productSectionOrder = await page
      .locator('.r2-stack > section')
      .evaluateAll((sections) => sections.map((section) => section.id))
    assert(
      productSectionOrder.join(',') === 'products,events',
      `产品与配置页模块顺序不正确：${productSectionOrder.join(',')}`,
    )
    const allocationTop = await page.locator('#allocationCardTitle').evaluate(
      (element) => element.getBoundingClientRect().top,
    )
    const holdingReviewTop = await page.locator('#holding-reviews').evaluate(
      (element) => element.getBoundingClientRect().top,
    )
    assert(
      allocationTop < holdingReviewTop,
      '配置目标与期限桶应位于当前持仓与同桶候选之前',
    )
    if ((await page.locator('#observationCardTitle').count()) > 0) {
      const observationTop = await page.locator('#observationCardTitle').evaluate(
        (element) => element.getBoundingClientRect().top,
      )
      assert(
        allocationTop < observationTop && observationTop < holdingReviewTop,
        '观察名单应位于配置目标与期限桶之后、当前持仓与同桶候选之前',
      )
    }
    const holdingReviewBottom = await page.locator('#holding-reviews').evaluate(
      (element) => element.getBoundingClientRect().bottom,
    )
    const riskCardTop = await page
      .locator('#riskCardTitle')
      .evaluate((element) => element.closest('.product-module-card')?.getBoundingClientRect().top ?? 0)
    assert(
      riskCardTop - holdingReviewBottom >= 24,
      `持仓复核与风险边界间距不足：${riskCardTop - holdingReviewBottom}px`,
    )
    if ((await page.locator('#observationCardTitle').count()) > 0) {
      const observationBottom = await page
        .locator('#observationCardTitle')
        .evaluate(
          (element) =>
            element.closest('.product-module-card')?.getBoundingClientRect().bottom ?? 0,
        )
      assert(
        holdingReviewTop - observationBottom >= 24,
        `观察名单与持仓复核间距不足：${holdingReviewTop - observationBottom}px`,
      )
    }
    assert(
      (await page.locator('.allocation-bucket').count()) === 3,
      '产品区没有渲染三个期限桶的分配结果',
    )
    assert(
      (await page.locator('#targetProductsCardTitle').count()) === 0,
      '目标产品模块应已删除',
    )
    assert(
      (await page.locator('.product-card').count()) === 0,
      '删除目标产品后不应再渲染目标产品卡片',
    )
    assert(
      (await page.locator('.product-module-card').count()) >= 3,
      '产品页应保留配置、额度/观察名单和风险边界模块卡',
    )
    if (
      (await page.locator('#quotaCardTitle').count()) > 0 &&
      (await page.locator('#observationCardTitle').count()) > 0
    ) {
      const observationTop = await page.locator('#observationCardTitle').evaluate(
        (element) => element.getBoundingClientRect().top,
      )
      const quotaTop = await page.locator('#quotaCardTitle').evaluate(
        (element) => element.getBoundingClientRect().top,
      )
      assert(
        observationTop < quotaTop,
        '观察名单应位于买入前额度核验之前',
      )
    }
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
    await productGoalLocator.scrollIntoViewIfNeeded()
    await assertFontFloor(page, '.product-goal-copy', '产品池统计移动端')
    await assertFontFloor(page, '#products', '产品与配置移动端')
    assert(
      await page.locator('.product-goal-copy').evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
      '移动端产品池统计出现横向溢出',
    )
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      '移动端产品与配置页出现横向溢出',
    )
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
      poolHeaders.some((text) => text.includes('参考年化')),
      '候选池缺少参考年化列',
    )
    const defaultReferenceSortState =
      (await poolDialog.locator('.dialog-sort-bar strong').textContent())?.trim() ?? ''
    assert(
      defaultReferenceSortState.includes('参考年化') &&
        defaultReferenceSortState.includes('降序'),
      `参考年化默认排序状态不正确：${defaultReferenceSortState}`,
    )
    await poolDialog.getByRole('button', { name: /参考年化/ }).click()
    const referenceAscendingState =
      (await poolDialog.locator('.dialog-sort-bar strong').textContent())?.trim() ?? ''
    assert(
      referenceAscendingState.includes('参考年化') &&
        referenceAscendingState.includes('升序'),
      `参考年化升序状态不正确：${referenceAscendingState}`,
    )
    await poolDialog.getByRole('button', { name: /参考年化/ }).click()
    const referenceDescendingState =
      (await poolDialog.locator('.dialog-sort-bar strong').textContent())?.trim() ?? ''
    assert(
      referenceDescendingState.includes('参考年化') &&
        referenceDescendingState.includes('降序'),
      `参考年化降序状态不正确：${referenceDescendingState}`,
    )
    const codeSearch = poolDialog.getByRole('combobox', {
      name: '按产品代码搜索',
    })
    await codeSearch.fill('13500')
    const matchingCodeLabels = await poolDialog
      .locator('[data-filter="code"] .option-menu-item strong')
      .allTextContents()
    assert(matchingCodeLabels.length > 0, '产品代码筛选没有返回匹配项')
    assert(
      matchingCodeLabels.every((label) => label.includes('13500')),
      '产品代码筛选混入了产品名称或期限中的数字',
    )
    await codeSearch.fill('040231')
    const zxRow = poolDialog.locator(
      '.product-name-button[data-product-code="ZX040231"]',
    )
    await zxRow.waitFor()
    const zxRowText = (await zxRow.textContent()) ?? ''
    assert(zxRowText.includes('ZX040231'), '产品代码模糊搜索没有命中 ZX040231')
    const zxOption = poolDialog
      .locator('[data-filter="code"] .option-menu-item')
      .filter({ hasText: 'ZX040231' })
      .first()
    await zxOption.waitFor()
    const codeCardsOverlap = await poolDialog
      .locator('[data-filter="code"] .option-menu-item')
      .evaluateAll((items) => {
        const boxes = items.map((item) => item.getBoundingClientRect())
        return boxes.some(
          (box, index) =>
            index > 0 && box.top < boxes[index - 1].bottom - 0.5,
        )
      })
    assert(!codeCardsOverlap, '产品代码选项卡片发生重叠')
    await zxOption.click()
    assert(
      ((await poolDialog.locator('[data-filter="code"] .option-control').textContent()) ??
        '').includes('ZX040231'),
      '产品代码下拉选择后没有保留选中项',
    )
    await poolDialog.locator('.filter-count').click()
    assert(
      (await codeSearch.inputValue()) === '',
      '完成产品代码筛选并收起下拉后搜索框仍残留原始搜索词',
    )
    await poolDialog
      .getByRole('button', { name: '移除产品代码 ZX040231' })
      .click()
    const codeOptions = poolDialog.locator(
      '[data-filter="code"] .option-menu-item',
    )
    await codeOptions.nth(0).click()
    await codeOptions.nth(1).click()
    assert(
      (await poolDialog.locator('[data-filter="code"] .option-chip:not(.option-chip-count)').count()) ===
        2,
      '产品代码下拉没有支持连续多选',
    )
    const selectAllCodes = poolDialog
      .locator('[data-filter="code"] .select-all-option')
      .first()
    await codeSearch.fill('0402')
    await selectAllCodes.click()
    assert(
      (await selectAllCodes.getAttribute('aria-pressed')) === 'true' &&
        ((await selectAllCodes.textContent()) ?? '').includes('取消全选'),
      '产品代码下拉没有全选当前筛选结果',
    )
    await selectAllCodes.click()
    assert(
      (await codeSearch.inputValue()) === '',
      '取消全选产品代码后搜索框仍残留关键词',
    )
    await poolDialog.locator('.dialog-sort-bar').click()
    assert(
      (await poolDialog.locator('[data-filter="code"] .option-menu').count()) === 0,
      '点击候选池空白处没有关闭产品代码下拉',
    )
    await poolDialog.getByRole('button', { name: '重置筛选' }).click()

    const nameSearch = poolDialog.getByRole('combobox', {
      name: '按产品名称搜索',
    })
    await nameSearch.fill('安盈象')
    await zxRow.waitFor()
    await nameSearch.fill('')

    const issuerSearch = poolDialog.getByRole('combobox', {
      name: '按发行方搜索',
    })
    await issuerSearch.fill('信银理财')
    await zxRow.waitFor()
    await issuerSearch.fill('')

    const termDropdown = poolDialog.locator('details[data-filter="term"]')
    await termDropdown.locator('summary').click()
    const selectAllTerms = termDropdown.locator('.select-all-option')
    await selectAllTerms.click()
    assert(
      (await termDropdown.getByRole('checkbox').count()) ===
        (await termDropdown.getByRole('checkbox').evaluateAll(
          (boxes) => boxes.filter((box) => box.checked).length,
        )),
      '期限下拉没有全选全部筛选项',
    )
    await selectAllTerms.click()
    assert(
      (await termDropdown.getByRole('checkbox').evaluateAll(
        (boxes) => boxes.filter((box) => box.checked).length,
      )) === 0,
      '期限下拉再次点击没有取消全选',
    )
    await termDropdown
      .getByRole('checkbox', { name: '短期 1–30 天' })
      .check()
    await termDropdown
      .getByRole('checkbox', { name: '中期 31–100 天' })
      .check()
    await poolDialog.locator('.dialog-sort-bar').click()
    assert(
      (await termDropdown.getAttribute('open')) === null,
      '点击候选池空白处没有关闭期限下拉',
    )
    const termSummaryText =
      (await termDropdown.locator('summary').textContent())?.trim() ?? ''
    assert(
      termSummaryText.includes('短期 1–30 天') &&
        termSummaryText.includes('中期 31–100 天'),
      `期限多选没有保留两个选项：${termSummaryText}`,
    )
    const hundredDayBadges = poolDialog.locator('[data-term-days="100"]')
    assert(
      (await hundredDayBadges.count()) > 0,
      '当前产品池没有可用于验证 100 天边界的样本',
    )
    assert(
      await hundredDayBadges.evaluateAll((badges) =>
        badges.every((badge) => badge.getAttribute('data-term-bucket') === 'medium'),
      ),
      '100 天产品没有归入中期 31–100 天筛选',
    )
    assert(
      (await termDropdown.locator('label').filter({ hasText: '长期 101 天+' }).count()) === 1,
      '期限筛选缺少长期 101 天+ 标签',
    )

    const evidenceDropdown = poolDialog.locator(
      'details[data-filter="evidence"]',
    )
    await evidenceDropdown.locator('summary').click()
    const selectAllEvidence = evidenceDropdown.locator('.select-all-option')
    await selectAllEvidence.click()
    assert(
      (await evidenceDropdown.getByRole('checkbox').count()) ===
        (await evidenceDropdown.getByRole('checkbox').evaluateAll(
          (boxes) => boxes.filter((box) => box.checked).length,
        )),
      '数据深度下拉没有全选全部筛选项',
    )
    await selectAllEvidence.click()
    await evidenceDropdown
      .getByRole('checkbox', { name: '仅 3M' })
      .check()
    await poolDialog.locator('.dialog-sort-bar').click()
    assert(
      (await evidenceDropdown.getAttribute('open')) === null,
      '点击候选池空白处没有关闭数据深度下拉',
    )
    assert(
      ((await evidenceDropdown.locator('summary').textContent()) ?? '').includes(
        '仅 3M',
      ),
      '候选池数据深度多选没有切换到仅 3M',
    )
    const lowConfidenceBadges = poolDialog.locator(
      '.status-pill[data-evidence-tier="three_month"]',
    )
    assert(
      (await lowConfidenceBadges.count()) > 0,
      '仅 3M 筛选后没有结果',
    )
    assert(
      (
        await lowConfidenceBadges.evaluateAll((badges) =>
          badges.every(
            (badge) =>
              badge.textContent?.includes('低置信') &&
              badge.classList.contains('is-single-window'),
          ),
        )
      ),
      '仅 3M 单一窗口高分缺少醒目的低置信标记',
    )
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
      ((await poolDialog.locator('details[data-filter="term"] summary').textContent()) ??
        '').includes('短期 1–30 天'),
      '关闭详情后候选池期限筛选没有保留',
    )
    assert(
      ((await poolDialog.locator('details[data-filter="evidence"] summary').textContent()) ??
        '').includes('仅 3M'),
      '关闭详情后候选池数据深度筛选没有保留',
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
    const mobileNameFilter = poolDialog.locator('[data-filter="name"]')
    await mobileNameFilter.getByRole('combobox').click()
    await mobileNameFilter.getByRole('combobox').fill('盈象')
    const mobileQuickMenuVisible = await mobileNameFilter
      .locator('.option-menu')
      .evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return (
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.right <= window.innerWidth + 1 &&
          rect.bottom <= window.innerHeight + 1
        )
      })
    assert(mobileQuickMenuVisible, '移动端产品筛选下拉超出可视区域')
    await poolDialog.locator('.dialog-head h2').click()
    assert(
      (await mobileNameFilter.locator('.option-menu').count()) === 0,
      '移动端点击空白处没有关闭产品筛选下拉',
    )
    const mobileEvidence = poolDialog.locator(
      'details[data-filter="evidence"]',
    )
    await mobileEvidence.locator('summary').click()
    const mobileMenuVisible = await mobileEvidence
      .locator('.multi-select-menu')
      .evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return (
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.right <= window.innerWidth + 1 &&
          rect.bottom <= window.innerHeight + 1
        )
      })
    assert(mobileMenuVisible, '移动端多选下拉超出可视区域')
    await mobileEvidence.locator('summary').click()
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

    const selectedLowConfidencePatch = await fetch(
      `${base}/api/dashboard/sections?include=summary,products`,
    ).then((response) => response.json())
    const threeMonthProduct =
      selectedLowConfidencePatch.products.all.find(
        (product) => product.evidence_tier === 'three_month',
      )
    assert(threeMonthProduct, '测试快照缺少仅 3M 产品')
    for (const product of selectedLowConfidencePatch.products.all) {
      product.selected = false;
      product.selection_rank = null;
      product.target_amount = 0;
      product.target_pct = 0;
    }
    Object.assign(threeMonthProduct, {
      selected: true,
      selection_rank: 1,
      target_amount: 1000,
      target_pct: 2,
      allocation_bucket: threeMonthProduct.bucket,
      allocation_mode: 'new',
      meaningful_min_amount: 1,
    })
    selectedLowConfidencePatch.products.watchlist = [threeMonthProduct]
    selectedLowConfidencePatch.products.stats.selected_count = 1
    selectedLowConfidencePatch.products.selection.selected_count = 1
    const selectedLowConfidencePage = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    })
    try {
      await selectedLowConfidencePage.route(
        /\/api\/dashboard\/sections\?include=summary(?:%2C|,)products$/,
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(selectedLowConfidencePatch),
          })
        },
      )
      await selectedLowConfidencePage.goto(`${base}/ledger/products`, {
        waitUntil: 'networkidle',
      })
      for (const scenario of [
        { theme: 'light', width: 1280, height: 900, label: '桌面浅色' },
        { theme: 'dark', width: 1280, height: 900, label: '桌面深色' },
        { theme: 'light', width: 390, height: 844, label: '移动浅色' },
        { theme: 'dark', width: 390, height: 844, label: '移动深色' },
      ]) {
        await selectedLowConfidencePage.setViewportSize({
          width: scenario.width,
          height: scenario.height,
        })
        await selectedLowConfidencePage.evaluate((theme) => {
          localStorage.setItem('qianduoduo:theme:v1', theme)
        }, scenario.theme)
        await selectedLowConfidencePage.reload({ waitUntil: 'networkidle' })
        await selectedLowConfidencePage.waitForSelector('.product-module-card')
        await selectedLowConfidencePage
          .getByRole('button', { name: '查看全部产品' })
          .click()
        const selectedDialog = selectedLowConfidencePage.locator(
          '.product-dialog:not(.product-detail-dialog)[open]',
        )
        await selectedDialog.waitFor()
        const selectedLowConfidenceBadge = selectedDialog.locator(
          '.status-pill[data-evidence-tier="three_month"].is-selected.is-single-window',
        )
        assert(
          (await selectedLowConfidenceBadge.count()) === 1,
          `${scenario.label}没有显示已选仅 3M 低置信徽标`,
        )
        const selectedBadgeData = await selectedLowConfidenceBadge.evaluate(
          (badge) => ({
            text: badge.textContent?.replace(/\s+/g, ' ').trim() || '',
            border: Number.parseFloat(getComputedStyle(badge).borderTopWidth),
          }),
        )
        assert(
          selectedBadgeData.text.includes('仅 3M · 低置信') &&
            selectedBadgeData.text.includes('精选') &&
            selectedBadgeData.border > 0,
          `${scenario.label}低置信精选徽标不醒目：${JSON.stringify(selectedBadgeData)}`,
        )
        await assertFontFloor(
          selectedLowConfidencePage,
          '.product-dialog:not(.product-detail-dialog)[open]',
          `仅 3M 精选徽标${scenario.label}`,
        )
        assert(
          await selectedLowConfidencePage.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              window.innerWidth + 1,
          ),
          `仅 3M 精选徽标${scenario.label}出现横向溢出`,
        )
      }
    } finally {
      await selectedLowConfidencePage.close()
    }

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
    assert(
      (await planButton.count()) > 0 || (await replaceButton.count()) > 0,
      '持仓复核没有可写入决策日志的入口',
    )
    const actionButton =
      (await planButton.count()) > 0 ? planButton.first() : replaceButton.first()
    await actionButton.click()
    await reviewCard.locator('.hr-decision-form').waitFor()
    await reviewCard.getByRole('button', { name: '写入决策日志' }).click()
    await page.waitForFunction(
      () =>
        document.querySelector('.toast')?.textContent?.includes('已写入决策日志'),
      null,
      { timeout: 5000 },
    )
    const reviewDecisionDashboard = await fetch(
      `${base}/api/dashboard/sections?include=evaluation`,
    ).then((response) => response.json())
    const savedReviewDecision =
      reviewDecisionDashboard.workspace.decisions.find(
        (item) =>
          item.review_meta?.holding_code === '120056A' &&
          item.review_meta?.yield_policy?.candidate,
      )
    assert(savedReviewDecision, '持仓复核决策没有保存冻结收益口径')
    const savedReviewMeta = savedReviewDecision.review_meta
    for (const role of ['current', 'candidate']) {
      const evidence = savedReviewMeta.yield_policy[role]
      assert(
        evidence?.yield_policy_version === 'r2-term-yield-v1' &&
          evidence?.status === 'available' &&
          Array.isArray(evidence.available_horizons) &&
          evidence.available_horizons.length > 0 &&
          Object.keys(evidence.normalized_weights || {}).length > 0,
        `持仓复核 ${role} 收益口径未完整落库：${JSON.stringify(evidence)}`,
      )
      assert(
        JSON.stringify(savedReviewMeta[`${role}_available_horizons`]) ===
          JSON.stringify(evidence.available_horizons),
        `持仓复核 ${role} 可用窗口兼容字段不一致：` +
          `${JSON.stringify(savedReviewMeta[`${role}_available_horizons`])} != ` +
          JSON.stringify(evidence.available_horizons),
      )
      assert(
        JSON.stringify(savedReviewMeta[`${role}_normalized_weights`]) ===
          JSON.stringify(evidence.normalized_weights),
        `持仓复核 ${role} 归一化权重兼容字段不一致：` +
          `${JSON.stringify(savedReviewMeta[`${role}_normalized_weights`])} != ` +
          JSON.stringify(evidence.normalized_weights),
      )
    }

    const legacyYieldDecision = await fetch(`${base}/api/review/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: '2026-10-20',
        product_name: '旧格式收益口径兼容测试',
        action: '观察',
        reason: '验证历史 review_meta 扁平收益字段仍可解释',
        expectation: '决策日志保留当前与候选收益证据',
        invalidation_condition: '收益策略或候选证据变化时重新复核',
        actual_result: '',
        strategy_version: 'r2-holding-review-v6',
        target_annualized: 3,
        bucket_plan: { short: 30, medium: 35, long: 35, max_single: 30 },
        evaluation_at: ['holding', 'maturity'],
        evidence_date: '2026-10-16',
        verify_date: '2026-11-19',
        review_meta: {
          yield_policy_version: 'r2-term-yield-v1',
          holding_code: '120026A',
          holding_name: '旧格式当前产品',
          candidate_code: '120056A',
          candidate_name: '旧格式候选产品',
          current_yield_pct: 2.4,
          current_yield_status: 'available',
          current_yield_reason: 'partial_history',
          current_available_horizons: ['3m', '6m'],
          current_normalized_weights: {
            return_3m: 0.625,
            return_6m: 0.375,
          },
          candidate_yield_pct: 2.9,
          candidate_yield_status: 'available',
          candidate_yield_reason: 'complete_history',
          candidate_available_horizons: ['3m', '6m', '1y'],
          candidate_normalized_weights: {
            return_3m: 0.5,
            return_6m: 0.3,
            return_1y: 0.2,
          },
          snapshot_date: '2026-10-16',
        },
        rating: '待评估',
      }),
    })
    assert(
      legacyYieldDecision.status === 201,
      `无法创建旧格式收益决策：${legacyYieldDecision.status}`,
    )

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
    const legacyYieldDecisionCard = page
      .locator('#decisions .rw-decision')
      .filter({ hasText: '旧格式收益口径兼容测试' })
    assert(
      (await legacyYieldDecisionCard.count()) === 1,
      '决策日志没有渲染旧格式收益口径决策',
    )
    const legacyYieldDecisionText =
      (await legacyYieldDecisionCard.textContent()) ?? ''
    assert(
      legacyYieldDecisionText.includes('当前收益') &&
        legacyYieldDecisionText.includes('候选收益') &&
        legacyYieldDecisionText.includes('部分历史') &&
        legacyYieldDecisionText.includes('3m + 6m') &&
        legacyYieldDecisionText.includes('r2-term-yield-v1'),
      `旧格式收益口径没有兼容展示：${legacyYieldDecisionText.slice(0, 240)}`,
    )
    assert(
      ((await page.locator('#proposals .rw-panel-body').textContent()) ?? '').includes(
        'E2E 资金冗余产品',
      ),
      '决策与评估页没有展示已采纳提案',
    )
    const proposalYieldPolicy = page
      .locator('#proposals .proposal-card')
      .filter({ hasText: 'E2E 资金冗余产品' })
      .getByTestId('proposal-yield-policy')
    assert(
      ((await proposalYieldPolicy.textContent()) ?? '').includes(
        'r2-term-yield-v1',
      ) &&
        ((await proposalYieldPolicy.textContent()) ?? '').includes('可用'),
      '提案卡没有显示生成时的收益策略与可用窗口',
    )
    assert(
      ((await page.locator('#decisions').textContent()) ?? '').includes(
        '收益口径',
      ) &&
        ((await page.locator('#decisions').textContent()) ?? '').includes(
          'r2-term-yield-v1',
        ),
      '采纳后的决策日志没有保留提案收益口径',
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

    const sectionPage = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    })
    const sectionRequests = []
    sectionPage.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname === '/api/dashboard/sections') {
        sectionRequests.push(url.searchParams.get('include'))
      }
      if (url.pathname === '/api/dashboard') {
        sectionRequests.push('FULL_DASHBOARD')
      }
    })
    const expectedPageSections = [
      ['/ledger/overview', 'overview'],
      ['/ledger/inbox', 'summary,inbox'],
      ['/ledger/daily', 'summary,ledger,trades,inbox'],
      ['/ledger/trades', 'summary,trades'],
      ['/ledger/products', 'summary,products'],
      ['/ledger/review', 'summary,ledger,trades,evaluation'],
      ['/ledger/evaluation', 'summary,trades,evaluation'],
    ]
    for (const [path, include] of expectedPageSections) {
      const start = sectionRequests.length
      await sectionPage.goto(`${base}${path}`, { waitUntil: 'networkidle' })
      await sectionPage.waitForSelector('.r2-page')
      assert(
        sectionRequests.slice(start).includes(include),
        `${path} 没有请求所需 Dashboard 分区：${include}`,
      )
    }
    assert(
      !sectionRequests.includes('FULL_DASHBOARD'),
      'R2 页面仍在请求完整 /api/dashboard',
    )
    await sectionPage.close()

    const errorPage = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await errorPage.route('**/api/dashboard/sections**', (route) =>
      route.abort(),
    )
    await errorPage.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
    await errorPage.waitForSelector('.dashboard-error-state')
    assert(
      (await errorPage.getByRole('button', { name: '重新加载' }).count()) === 1,
      '加载失败时没有重试入口',
    )
    await errorPage.close()

    for (const [index, date] of [
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
    ].entries()) {
      const response = await fetch(`${base}/api/capital/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_date: date,
          event_type: 'deposit',
          amount: 100 + index,
          note: `E2E 本金变动 ${index + 1}`,
        }),
      })
      assert(response.status === 201, `无法创建第 ${index + 1} 笔本金变动`)
    }

    for (const scenario of [
      { theme: 'light', width: 1280, height: 900, label: '桌面浅色' },
      { theme: 'dark', width: 1280, height: 900, label: '桌面深色' },
      { theme: 'light', width: 390, height: 844, label: '移动浅色' },
      { theme: 'dark', width: 390, height: 844, label: '移动深色' },
    ]) {
      await page.setViewportSize({
        width: scenario.width,
        height: scenario.height,
      })
      await page.evaluate((theme) => {
        localStorage.setItem('qianduoduo:theme:v1', theme)
      }, scenario.theme)
      await page.goto(`${base}/ledger/daily`, { waitUntil: 'networkidle' })
      await page.waitForSelector('#capitalEventList .capital-event-item')
      const capitalHistory = await page
        .locator('#capitalEventList')
        .evaluate((list) => {
          const listRect = list.getBoundingClientRect()
          const items = Array.from(
            list.querySelectorAll('.capital-event-item'),
          ).map((item) => {
            const rect = item.getBoundingClientRect()
            return {
              top: rect.top,
              bottom: rect.bottom,
            }
          })
          return {
            count: items.length,
            clientHeight: list.clientHeight,
            scrollHeight: list.scrollHeight,
            allItemsInside: items.every(
              (item) =>
                item.top >= listRect.top - 1 &&
                item.bottom <= listRect.bottom + 1,
            ),
          }
        })
      assert(
        capitalHistory.count === 4,
        `${scenario.label}本金变动数量不正确：${capitalHistory.count}`,
      )
      assert(
        capitalHistory.scrollHeight <= capitalHistory.clientHeight + 1 &&
          capitalHistory.allItemsInside,
        `${scenario.label}最近本金变动没有完整展示：${JSON.stringify(capitalHistory)}`,
      )
      await assertFontFloor(page, '#capitalPanel', `本金变动${scenario.label}`)
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        `本金变动${scenario.label}出现横向溢出`,
      )
    }

    assert(
      consoleErrors.length === 0,
      `控制台出现错误：\n${consoleErrors.join('\n')}`,
    )
    console.log(
      `E2E 通过：正文检索 ${hits} 条命中、报告直达无 iframe、静态原文入口退出、报告与科技图谱三版返回首页、桌面与移动报告页、左侧目录 ${outlineItems} 项、搜索切换、键盘切换、样式卸载、侧边栏七入口、双截图入口、消息中心、决策提案采纳、复盘模块卡与跨页补记、逐产品收益档案、产品配置、持仓复核与替换决策、候选池逐只详情与筛选/滚动恢复、交易流水、收件箱、自动评估、确认弹窗、错误兜底。`,
    )
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
    repository.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exitCode = 1
})
