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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { createServer } = require('../server.js')
const { openDatabase } = require('../lib/db.js')
const { resolveProductCsv } = require('../server.js')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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
    return Array.from(root.querySelectorAll('*'))
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

    await page.goto(`${base}/ledger/daily`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.ledger-panel')
    assert(
      (await page.locator('.rw-quick-card').count()) === 2,
      '每日记账应只保留交易截图和收益截图两个主入口',
    )
    assert(
      (await page.locator('.ledger-table tbody tr').count()) === 1,
      '每日记账没有渲染历史记录',
    )

    await page.locator('.capture-manual > summary').click()
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
    await valuationForm.getByLabel('收益日期').fill('2026-10-19')
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
    await assertFontFloor(page, '.product-valuation-panel', '逐产品收益档案桌面端')
    await page.getByRole('button', { name: '记一笔交易', exact: true }).click()
    await page.getByLabel('产品代码').fill('120026A')
    await page.getByLabel('产品名称').fill('招银理财14天')
    await page.getByLabel('买入金额').fill('5000')
    await page.getByLabel('期限（天，0 = 日开）').fill('14')
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

    await page.goto(`${base}/ledger/inbox`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.inbox-page')
    await assertFontFloor(page, '.inbox-page', '消息中心桌面端')
    assert(
      (await page.locator('.inbox-message').count()) > 0,
      '消息中心没有聚合待处理交易或产品事件',
    )
    assert(
      (await page.locator('.inbox-source-group').count()) >= 2,
      '消息中心没有按来源分组',
    )
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
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      '移动端每日记账出现横向溢出',
    )
    await assertFontFloor(page, '.rw-quick', '每日记账移动端')
    await page.goto(`${base}/ledger/inbox`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.inbox-page')
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      '移动端消息中心出现横向溢出',
    )
    await assertFontFloor(page, '.inbox-page', '消息中心移动端')
    await page.goto(`${base}/ledger/trades`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.product-valuation-panel .pv-card')
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

    await page.getByRole('button', { name: '查看全部产品' }).click()
    const poolDialog = page.locator(
      '.product-dialog:not(.product-detail-dialog)[open]',
    )
    await poolDialog.waitFor()
    assert(
      (await page.locator('dialog[open]').count()) === 1,
      '打开候选池时不应同时存在其他弹窗',
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
        '当前持仓 vs 同期限候选',
      ),
      '持仓复核卡片没有渲染',
    )
    await reviewCard.locator('.hr-actions button').click()
    await page.waitForSelector('#holding-reviews .hr-candidate')
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
      '持仓复核没有渲染同期限候选',
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
    assert(
      (await page.getByRole('button', { name: '立即运行自动化' }).count()) === 1,
      '自动评估面板没有运行入口',
    )
    assert(
      (await page.locator('#decisions .rw-panel-body').count()) === 1,
      '决策日志没有渲染',
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
      `E2E 通过：正文检索 ${hits} 条命中、报告直达无 iframe、左侧目录 ${outlineItems} 项、搜索切换、键盘切换、样式卸载、侧边栏七入口、双截图入口、消息中心、复盘模块卡与跨页补记、逐产品收益档案、产品配置、持仓复核与替换决策、候选池逐只详情与筛选/滚动恢复、交易流水、收件箱、自动评估、确认弹窗、错误兜底。`,
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
