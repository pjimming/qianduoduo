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
    await page.waitForSelector('.ledger-panel')
    assert((await page.locator('.stats-grid').count()) === 1, '首页统计区没有渲染')
    await page.waitForSelector('.review-workspace')
    assert(
      (await page.locator('.rw-tab').count()) === 5,
      '复盘工作台应有 5 个标签页',
    )
    assert(
      (await page.locator('.rw-node').count()) === 4,
      '复盘时间轴应有 4 个节点',
    )
    await page.getByRole('tab', { name: '持仓结构' }).click()
    await page.waitForSelector('.rw-bucket-grid')
    assert(
      (await page.locator('.rw-bucket').count()) >= 4,
      '期限桶没有渲染',
    )
    await page.getByRole('tab', { name: '月度五问' }).click()
    assert(
      (await page.locator('.rw-question:visible').count()) === 5,
      '月度五问应有 5 个问题',
    )

    await page.locator('.ledger-table .icon-button.is-danger').first().click()
    await page.waitForSelector('.confirm-dialog')
    await page.getByRole('button', { name: '取消' }).click()
    assert(
      (await page.locator('.ledger-table tbody tr').count()) === 1,
      '取消删除后记录不应消失',
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
      `E2E 通过：正文检索 ${hits} 条命中、报告直达无 iframe、左侧目录 ${outlineItems} 项、搜索切换、键盘切换、样式卸载、首页账本、确认弹窗、错误兜底。`,
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
