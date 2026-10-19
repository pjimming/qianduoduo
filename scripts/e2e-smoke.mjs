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
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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

async function main() {
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
    assert(cards === 13, `报告库应有 13 张卡片，实际 ${cards}`)

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

    await page.goto(`${base}/`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.stats-grid')
    assert(
      new URL(page.url()).pathname === '/ledger/overview',
      '根路径应重定向到收益概览',
    )
    assert(
      (await page.locator('#nav-group-wealth .sidebar-link').count()) === 6,
      '侧边栏理财分区应有 6 个入口',
    )
    assert(
      (await page.locator('.r2-jump-card').count()) === 4,
      '收益概览应有 4 个待办入口',
    )

    await page.goto(`${base}/ledger/daily`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.ledger-panel')
    assert(
      (await page.locator('.rw-quick-card').count()) === 3,
      '每日记账应有 3 个提交入口',
    )
    assert(
      (await page.locator('.ledger-table tbody tr').count()) === 1,
      '每日记账没有渲染历史记录',
    )

    await page.getByLabel('发生了什么').fill('E2E 特殊事项：额度临时关闭')
    await page.getByRole('button', { name: '提交给 AI' }).click()
    await page.waitForFunction(
      () => document.querySelector('.toast')?.textContent?.includes('特殊事项已提交'),
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
      `E2E 通过：正文检索 ${hits} 条命中、报告直达无 iframe、左侧目录 ${outlineItems} 项、搜索切换、键盘切换、样式卸载、侧边栏六分区、每日记账、复盘模块卡与跨页补记、产品配置、候选池逐只详情与筛选/滚动恢复、交易流水、收件箱、自动评估、确认弹窗、错误兜底。`,
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
