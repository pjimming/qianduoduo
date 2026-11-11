import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { openDatabase } = require('../lib/db')
const { createServer } = require('../server')
const { productCsv } = require('../test/fixtures')
const directory = mkdtempSync(path.join(os.tmpdir(), 'qdd-capital-e2e-'))
const repository = openDatabase({ dbPath: path.join(directory, 'ledger.sqlite'), productCsvPath: productCsv,
  tradeInboxDir: path.join(directory, 'trades'), incomeInboxDir: path.join(directory, 'income'),
  holdingValuationEvidenceDir: path.join(directory, 'evidence'), logger: { warn() {}, info() {} } })
repository.initializeCapital(100, '2026-09-01')
const server = createServer({ repository })
let browser
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const json = async (url, method = 'GET', body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    assert.ok(response.ok, `${url}: ${response.status}`)
    return response.json()
  }
  const create = async body => (await json('/api/trades', 'POST', { trade_date: '2026-10-19',
    confirm_date: '2026-10-19', trade_type: 'buy', status: 'confirmed', product_code: '120056A',
    product_name: '合成测试产品', issuer: '合成机构', risk_level: 'R2', amount: 100, term_days: 90, ...body })).trade
  await create({})
  const redeem = await create({ trade_type: 'redeem', amount: 50, settlement_amount: 55, term_days: null })
  await create({ amount: 55 })
  const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find(existsSync)
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const load = async () => {
    await page.goto(base + '/ledger/daily?section=capital', { waitUntil: 'networkidle' })
    await page.locator('#capitalFundingBase').waitFor()
  }
  const money = async selector => Number((await page.locator(selector).innerText()).replace(/[^\d.-]/g, ''))
  await load()
  assert.equal(await money('#capitalCurrent'), 100)
  assert.equal(await money('#capitalRealized'), 0)
  assert.equal(await money('#capitalFundingBase'), 100)
  assert.match(await page.locator('#capitalFunding').innerText(), /到账或金额待核/)
  await json('/api/trades/' + redeem.id, 'PUT', { arrival_date: '2026-10-20' })
  await load()
  assert.equal(await money('#capitalRealized'), 5)
  assert.equal(await money('#capitalReinvested'), 5)
  assert.equal(await money('#capitalFundingBase'), 105)
  await json('/api/trades/' + redeem.id, 'PUT', { amount: 50.01, note: '合成截图更正成本' })
  await load()
  assert.equal(await money('#capitalCurrent'), 100)
  assert.equal(await money('#capitalRealized'), 4.99)
  assert.equal(await money('#capitalHoldingCost'), 104.99)
  assert.equal(await money('#capitalFundingBase'), 104.99)
  const output = path.resolve('run')
  mkdirSync(output, { recursive: true })
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { localStorage.setItem('qianduoduo:theme:v1', value) }, theme)
    await load()
    assert.match(await page.locator('#capitalFunding').innerText(), /不代表银行可用余额/)
    const layout = await page.locator('#capitalPanel').evaluate(root => {
      const visible = [root, ...root.querySelectorAll('*')].filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
      return { minFont: Math.min(...visible.map(el => parseFloat(getComputedStyle(el).fontSize))),
        overflow: document.documentElement.scrollWidth > innerWidth + 1 }
    })
    assert.ok(layout.minFont >= 12, `${theme}: font ${layout.minFont}`)
    assert.equal(layout.overflow, false)
    await page.locator('#capitalPanel').screenshot({ path: path.join(output, `capital-funding-e2e-${theme}.png`) })
  }
  assert.deepEqual(errors, [])
  console.log('本金联动 E2E 通过：到账前等待、到账收益复投、成本更正自动联动、净投入不变、1280px 双主题、12px 字号和无横向溢出。')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
  repository.close()
  rmSync(directory, { recursive: true, force: true })
}
