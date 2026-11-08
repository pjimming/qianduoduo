#!/usr/bin/env node
/**
 * R2 v9 工作区端到端检查（Stream C）。
 *
 * 覆盖：
 * - 选品与配置三分区（screening / allocation / holdings）
 * - 决策与评估三分区（proposals / decisions / results）
 * - 旧深链与旧初筛参数迁移（#holding-reviews、#events、#automation、#calibration）
 * - 无效 section 的 notice 与 replace 规范化
 * - 提案采纳/拒绝弹窗取消时零 POST，且不触发原生 confirm/prompt
 *
 * 前置：先构建前端产物（npx vite build）。本脚本不负责构建。
 * 运行：node scripts/e2e-r2-strategy.mjs
 */

import { chromium } from 'playwright-core'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { openDatabase } = require('../lib/db.js')
const { openScreeningRepository } = require('../server/modules/r2-screening/repository.js')
const { createScreeningService } = require('../server/modules/r2-screening/service.js')
const screeningFixture = require('../test/fixtures/r2-screening/2026-11-07.json')
const { todayShanghai } = require('../lib/metrics.js')

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

function query(url) {
  return new URL(url).searchParams
}

const proposalFixture = {
  id: 900001,
  dedupe_key: 'e2e-cancel-proposal',
  group_key: 'e2e-cancel-group',
  proposal_type: 'holding_switch',
  title: 'E2E 取消验证提案',
  summary: '用于验证取消确认时不会发出任何写请求。',
  action: '切换',
  product_name: '测试产品 A',
  product_code: 'E2E001',
  target_product_code: 'E2E002',
  target_product_name: '测试产品 B',
  amount: 10000,
  evidence_date: '2026-11-07',
  expires_at: '2026-11-14',
  verify_date: '2026-12-07',
  confidence: 82,
  status: 'pending',
  decision_id: null,
  yield_policy_version: null,
  payload: {},
  created_at: '2026-11-08T00:00:00+08:00',
  updated_at: '2026-11-08T00:00:00+08:00',
  accepted_at: null,
  rejected_at: null,
  reject_reason: '',
  executed_at: null,
}

async function waitForSection(page, section) {
  await page.waitForFunction(
    (expected) => new URL(location.href).searchParams.get('section') === expected,
    section,
  )
}

async function gotoSection(page, base, path, section) {
  await page.goto(base + path, { waitUntil: 'domcontentloaded' })
  await waitForSection(page, section)
}

async function main() {
  process.env.R2_OCR = '0'
  const distDir = process.env.E2E_DIST
    ? path.resolve(process.env.E2E_DIST)
    : path.join(root, 'dist')
  if (!existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(`缺少 ${distDir}/index.html，请先构建前端产物`)
  }
  if (!executablePath) {
    throw new Error('没有找到 Chrome/Edge，可设置 CHROME_PATH 后重试')
  }
  // 允许 E2E 使用临时构建目录，而不改动工作区 dist。
  const serverConfig = require('../server/config.js')
  serverConfig.STATIC_DIR = distDir
  const { createServer, resolveProductCsv } = require('../server.js')

  const directory = mkdtempSync(path.join(os.tmpdir(), 'r2-e2e-strategy-'))
  const repository = openDatabase({
    dbPath: path.join(directory, 'e2e.sqlite'),
    productCsvPath: resolveProductCsv(root, { includeUnopened: true }),
    logger: { warn() {} },
  })
  const screeningStore = openScreeningRepository(path.join(directory, 'screening.sqlite'), {
    ledgerPath: repository.dbPath,
    initialize: true,
  })
  const screening = createScreeningService({
    repository: screeningStore,
    enabled: true,
    schedule: false,
    collector: async () => screeningFixture,
    clock: () => new Date('2026-11-07T04:26:00Z'),
  })
  const { applyMigration } = await import('./migrate-r2-strategy.mjs')
  applyMigration({ dbPath: repository.dbPath, screeningPath: path.join(directory, 'screening.sqlite'), backupDir: path.join(directory, 'backups') })
  const { createStrategyRepository } = require('../server/modules/r2-strategy/repository.js')
  const strategyStore = createStrategyRepository(repository.db, { transactionManager: repository.transactionManager })
  const server = createServer({ repository, screening })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  const browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    window.__nativeDialogs = []
    window.confirm = () => {
      window.__nativeDialogs.push('confirm')
      return false
    }
    window.prompt = () => {
      window.__nativeDialogs.push('prompt')
      return null
    }
  })

  try {
    // 1. 三个分区与导航
    await gotoSection(page, base, '/ledger/products?section=screening', 'screening')
    await page.locator('#screening').waitFor()
    assert(
      (await page.locator('.workspace-nav [data-section="screening"][aria-current="page"]').count()) === 1,
      '候选初筛分区导航未高亮',
    )
    assert(
      (await page.locator('#screening .screening').count()) === 1,
      '候选初筛未嵌入公开初筛视图',
    )
    assert(
      (await page.locator('a[href="/ledger/screening"], a[href^="/ledger/screening?"]').count()) === 0,
      '页面仍存在指向 /ledger/screening 的循环链接',
    )

    await gotoSection(page, base, '/ledger/products?section=allocation', 'allocation')
    await page.locator('#allocation').waitFor()
    await page.locator('#allocationCardTitle').waitFor()
    assert(
      (await page.locator('.workspace-nav [data-section="allocation"][aria-current="page"]').count()) === 1,
      '资金配置分区导航未高亮',
    )
    assert(
      (await page.locator('#strategy-review').count()) === 1,
      '资金配置缺少交易前复核面板',
    )

    await gotoSection(page, base, '/ledger/products?section=holdings', 'holdings')
    await page.locator('#holding-reviews').waitFor()
    assert(
      (await page.locator('.workspace-nav [data-section="holdings"][aria-current="page"]').count()) === 1,
      '持仓复核分区导航未高亮',
    )
    assert(
      (await page.locator('.holding-view-switch').count()) === 1,
      '持仓复核缺少查看方式切换',
    )

    // 2. 旧初筛参数迁移与去循环链接
    await page.goto(base + '/ledger/screening?tab=history&page=2&term=90', {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(() => location.pathname === '/ledger/products')
    await waitForSection(page, 'screening')
    const legacy = query(page.url())
    assert(legacy.get('tab') === 'history', '旧初筛 tab 参数未保留')
    assert(legacy.get('page') === '2', '旧初筛 page 参数未保留')
    assert(legacy.get('term') === '90', '旧初筛 term 参数未保留')

    // 3. 持仓旧锚点
    await gotoSection(page, base, '/ledger/products#holding-reviews', 'holdings')
    assert(new URL(page.url()).hash === '#holding-reviews', '持仓锚点被丢弃')

    await gotoSection(page, base, '/ledger/products?view=performance#holding-reviews', 'holdings')
    assert(query(page.url()).get('view') === 'performance', '收益排行 view 参数未保留')
    assert(
      (await page
        .locator('.holding-view-switch .r2-index-link[aria-current="true"]')
        .innerText()).includes('收益排行'),
      '收益排行未选中',
    )

    await gotoSection(page, base, '/ledger/products?section=holdings#events', 'holdings')
    await page.locator('#events').waitFor()
    assert(
      (await page
        .locator('.holding-view-switch .r2-index-link[aria-current="true"]')
        .innerText()).includes('产品事件'),
      '产品事件未选中',
    )

    // 显式 section 优先于旧锚点
    await gotoSection(page, base, '/ledger/products?section=allocation#events', 'allocation')
    assert((await page.locator('#events').count()) === 0, '显式分区未覆盖旧锚点')

    // 4. 决策与评估三分区与旧锚点
    await gotoSection(page, base, '/ledger/evaluation?section=proposals', 'proposals')
    await page.locator('#proposals').waitFor()

    await gotoSection(page, base, '/ledger/evaluation#decisions', 'decisions')
    await page.locator('#decisions').waitFor()

    await gotoSection(page, base, '/ledger/evaluation#automation', 'results')
    await page.locator('#automation').waitFor()
    assert(query(page.url()).get('view') === 'evaluations', '#automation 未落到结果评价')

    await gotoSection(page, base, '/ledger/evaluation#calibration', 'results')
    await page.locator('#calibration').waitFor()
    assert(query(page.url()).get('view') === 'calibration', '#calibration 未落到评价校准')

    await gotoSection(page, base, '/ledger/evaluation?section=results&view=calibration', 'results')
    assert(
      (await page
        .locator('.results-view-switch .r2-index-link[aria-current="true"]')
        .innerText()).includes('评价校准'),
      '结果区未选中评价校准',
    )

    // 5. 无效 section
    await page.goto(base + '/ledger/products?section=bogus', { waitUntil: 'domcontentloaded' })
    await waitForSection(page, 'allocation')
    assert(query(page.url()).get('notice') === 'invalid-section', '无效分区未写入 notice')
    await page.locator('.r2-inline-notice').waitFor()
    await page.getByRole('button', { name: '知道了' }).click()
    await page.waitForFunction(
      () => !new URL(location.href).searchParams.has('notice'),
    )

    await page.goto(base + '/ledger/evaluation?section=bogus&view=calibration', {
      waitUntil: 'domcontentloaded',
    })
    await waitForSection(page, 'proposals')
    assert(query(page.url()).get('notice') === 'invalid-section', '无效评估分区未写入 notice')

    // 6. 取消提案确认 = 零 POST，且不触发原生弹窗
    await page.route('**/api/dashboard/sections**', async (route) => {
      const response = await route.fetch()
      const payload = await response.json()
      payload.decision_proposals = {
        generated_for: todayShanghai(),
        proposals: [proposalFixture],
        pending: [proposalFixture],
        accepted: [],
        executed: [],
        history: [],
        summary: { pending: 1, accepted: 0, executed: 0, rejected: 0, expired: 0 },
      }
      await route.fulfill({ response, json: payload })
    })
    const writes = []
    page.on('request', (request) => {
      if (
        request.method() !== 'GET' &&
        request.url().includes('/api/decision-proposals/')
      ) {
        writes.push(`${request.method()} ${request.url()}`)
      }
    })

    await page.goto(base + '/ledger/evaluation?section=proposals', {
      waitUntil: 'networkidle',
    })
    await page.locator('[data-testid="proposal-adopt"]').waitFor()

    await page.locator('[data-testid="proposal-reject"]').click()
    await page.locator('.confirm-dialog').waitFor()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.locator('.confirm-dialog').waitFor({ state: 'detached' })
    assert(writes.length === 0, `取消拒绝产生了写请求：${writes.join(', ')}`)

    await page.locator('[data-testid="proposal-adopt"]').click()
    await page.locator('.confirm-dialog').waitFor()
    await page.keyboard.press('Escape')
    await page.locator('.confirm-dialog').waitFor({ state: 'detached' })
    assert(writes.length === 0, `Esc 取消采纳产生了写请求：${writes.join(', ')}`)

    const nativeDialogs = await page.evaluate(() => window.__nativeDialogs)
    assert(
      Array.isArray(nativeDialogs) && nativeDialogs.length === 0,
      `提案弹窗仍调用原生 confirm/prompt：${JSON.stringify(nativeDialogs)}`,
    )

    // 7. 基础可读性与横向溢出（1280 宽）
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    assert(overflow <= 1, `1280 宽出现横向溢出：${overflow}px`)
    const tiny = await page.locator('.workspace-nav').evaluate((root) => {
      return [root, ...root.querySelectorAll('*')]
        .filter((element) => {
          const style = getComputedStyle(element)
          const hasText = Array.from(element.childNodes).some(
            (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
          )
          return hasText && Number.parseFloat(style.fontSize) < 12
        })
        .map((element) => element.textContent?.trim().slice(0, 30))
    })
    assert(tiny.length === 0, `分区导航存在低于 12px 的文字：${tiny.join(' / ')}`)

    // 8. 真正调用策略写接口，防止前端回传服务端只读字段导致保存被拒绝。
    strategyStore.transition({ operationKey: 'e2e-activate', expectedSeq: 0, mode: 'v9' })
    await page.goto(base + '/ledger/products?section=allocation&channel=TEST&code=E2E001', { waitUntil: 'networkidle' })
    await page.locator('[data-testid="strategy-workspace"]').waitFor()
    assert(await page.locator('#allocationCardTitle').count() === 0, 'v9 仍展示旧策略配置金额')
    await page.locator('input[name="mappingproduct"]').fill('E2E001')
    let saved = page.waitForResponse(response => response.url().endsWith('/api/r2-strategy/mappings') && response.request().method() === 'POST')
    await page.locator('[data-testid="strategy-mapping-save"]').click()
    assert((await saved).status() === 200, '首次映射保存失败')
    await page.locator('[data-testid="strategy-mapping-save"]').waitFor()
    // 已存在映射的重复保存不能携带 id/verified_at 等只读字段。
    saved = page.waitForResponse(response => response.url().endsWith('/api/r2-strategy/mappings') && response.request().method() === 'POST')
    await page.locator('[data-testid="strategy-mapping-save"]').click()
    assert((await saved).status() === 200, '已存在映射保存失败')
    await page.locator('[data-testid="strategy-check-save"]').waitFor()
    saved = page.waitForResponse(response => response.url().endsWith('/api/r2-strategy/checks') && response.request().method() === 'POST')
    await page.locator('[data-testid="strategy-check-save"]').click()
    assert((await saved).status() === 200, '交易前检查保存失败')
    await page.locator('[data-testid="strategy-check-save"]').waitFor()
    assert(repository.db.prepare('SELECT COUNT(*) n FROM r2_pretrade_checks').get().n === 1, 'UI 没有保存检查版本')
    assert(repository.db.prepare('SELECT COUNT(*) n FROM r2_share_mappings').get().n === 1, '重复映射不幂等')
    await page.getByRole('button', { name: '重算当前策略', exact: true }).click()
    await page.waitForResponse(response => response.url().endsWith('/api/r2-strategy/recompute'))
    await page.getByText('组合本金', { exact: true }).waitFor()
    const captures = path.join(root, 'run', 'acceptance-ui')
    mkdirSync(captures, { recursive: true })
    for (const width of [1280, 1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
        await page.waitForTimeout(350)
        const contrasts = await page.locator('#allocation button:not(:disabled), .r2-head-actions .button').evaluateAll(elements => {
          const rgb = value => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number)
          const light = values => values.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((a, v, i) => a + v * [.2126, .7152, .0722][i], 0)
          return elements.filter(e => e.getClientRects().length).map(e => {
            const style = getComputedStyle(e)
            let parent = e, bg = style.backgroundColor
            while (/rgba.*0\)$/.test(bg) && parent.parentElement) { parent = parent.parentElement; bg = getComputedStyle(parent).backgroundColor }
            const a = light(rgb(style.color)), b = light(rgb(bg))
            return { text: e.textContent.trim().slice(0, 25), color: style.color, background: bg, ratio: (Math.max(a,b)+.05)/(Math.min(a,b)+.05) }
          })
        })
        assert(contrasts.every(item => item.ratio >= 4.5), '按钮对比不足 ' + theme + ': ' + JSON.stringify(contrasts.filter(item => item.ratio < 4.5)))
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
        assert(overflow <= 1, '策略工作区横向溢出 ' + width + ' ' + theme + ': ' + overflow)
        const tiny = await page.locator('#allocation').evaluate(root => [...root.querySelectorAll('*')].filter(element => {
          const style = getComputedStyle(element)
          return element.getClientRects().length && [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) && parseFloat(style.fontSize) < 12
        }).map(element => element.textContent?.slice(0, 30)))
        assert(tiny.length === 0, '策略工作区存在小字 ' + tiny.join(' / '))
        await page.screenshot({ path: path.join(captures, 'allocation-' + width + '-' + theme + '.png'), fullPage: true })
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    await gotoSection(page, base, '/ledger/products?section=holdings', 'holdings')
    await page.locator('[data-testid="strategy-workspace"]').waitFor()
    assert(await page.getByText('当前策略逐批次复核', { exact: true }).count() === 1, '持仓没有使用 v9 策略监控')

    // 9. 11 个合成持仓批次覆盖退出、待核、锁定和持有，验证可处理入口。
    await page.route('**/api/r2-strategy/workspace', async route => {
      const response = await route.fetch(); const payload = await response.json()
      payload.stale = false
      payload.result.monitoring.rows = Array.from({length: 11}, (_, i) => ({ lot_id: 'synthetic-lot-' + i, product_code: 'E2E' + i, identity: i === 10 ? null : {source:'cmb',channel:'TEST',code:'E2E' + i}, state: ['exit_required','exit_at_open','exit_rules_pending','evidence_pending','hold'][i % 5], action:'观察',planned_action:'verify_holding',yield_1m: i % 2 ? '2.50' : '2.10',performance_date:'2026-11-07',next_verify_date:'2026-11-09',summary:'合成验收数据：此批次用于检查交互，不是银行事实。',requires_user_action:true,fingerprint:'synthetic' }))
      await route.fulfill({response,json:payload})
    })
    await page.goto(base + '/ledger/products?section=holdings', {waitUntil:'networkidle'})
    assert(await page.locator('.strategy-table-wrap tbody tr').count() === 11, '持仓批次未完整显示')
    for (const theme of ['light','dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
      await page.waitForTimeout(350)
      await page.screenshot({path:path.join(captures,'holdings-11-1280-' + theme + '.png'),fullPage:true})
    }
    await page.route('**/api/r2-strategy/proposals', async route => route.fulfill({json:{created:[],blockers:['fees_unverified']}}))
    await page.getByRole('button',{name:'生成退出提案',exact:true}).first().click()
    await page.getByText('退出提案暂不可生成：费用待核', {exact:true}).waitFor()
    const lotLink = page.getByRole('link',{name:'核验此批次',exact:true}).first()
    const href = await lotLink.getAttribute('href')
    assert(href.includes('lot=synthetic-lot-0') && href.includes('code=E2E0'), '逐批次复核没有携带真实身份与lot')
    const unmapped = page.getByRole('link',{name:'先核实同份额映射',exact:true})
    assert((await unmapped.getAttribute('href')).includes('product_code=E2E10'), '未映射批次没有带入账本产品')

    assert(errors.length === 0, `页面运行出错：${errors.join(' / ')}`)
    console.log('e2e-r2-strategy: 全部通过')
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
    screeningStore.close?.()
    repository.close()
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch (error) {
      // Windows 可能在 SQLite/浏览器句柄释放前短暂锁定临时目录；断言已全部
      // 完成后，清理失败不应把通过的 E2E 改判为失败。
      if (!['EPERM', 'EBUSY'].includes(error.code)) throw error
      console.warn(`e2e-r2-strategy: 临时目录清理失败（${error.code}）：${directory}`)
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
