import assert from 'node:assert/strict'

const dates = ['2026-11-11', '2026-11-10']
const fixture = (date, type, unsafe = false) => ({
  analysis_type: type, title: '源站标题', published_at: `${date}T17:26:06+08:00`,
  content_markdown: `# ${date} ${type.replaceAll('_', '')}原文\n\n## 接口正文\n\n原文内容保持不变。\n\n| 指数 | 涨跌幅 |\n| --- | --- |\n| 上证指数 | 0.46% |\n\n${unsafe ? '<script>window.briefInjected=true</script><img src="https://invalid.example/pixel" onerror="window.briefInjected=true"><iframe src="https://invalid.example"></iframe>' : ''}\n\n[安全链接](https://example.com) [危险链接](javascript:alert(1))`,
})

export const briefFixtureService = {
  dates: async () => ({ dates, source: '投资科学' }),
  daily: async date => ({ trade_date: date, source: '投资科学', analyses: dates.includes(date)
    ? ['morning_brief', 'midday_brief', 'market_overview'].map(type => fixture(date, type)) : [] }),
}

export async function marketBriefSmoke(page, base, assertFontFloor) {
  await page.goto(`${base}/investment/briefs`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { level: 1, name: '2026-11-11 marketoverview原文' }).waitFor()
  assert.equal(new URL(page.url()).searchParams.get('date'), dates[0])
  assert.equal(await page.locator('#market-brief-date option').count(), 2)
  assert.equal(await page.locator('.briefs-periods button').count(), 3)
  assert.equal(await page.locator('#nav-group-investment .sidebar-link').count(), 3)
  assert.ok((await page.locator('.briefs-source').innerText()).includes('投资科学'))
  assert.equal(await page.locator('.brief-markdown table').count(), await page.locator('.brief-table-scroll table').count())
  assert.equal(await page.locator('.brief-markdown script,.brief-markdown img,.brief-markdown iframe').count(), 0)
  assert.equal(await page.evaluate(() => window.briefInjected), undefined)
  assert.equal(await page.locator('.brief-markdown a[href^="javascript:"]').count(), 0)
  assert.equal(await page.locator('.brief-markdown a[href="https://example.com"]').getAttribute('rel'), 'noopener noreferrer')

  for (const [label, type] of [['早盘分析', 'morning_brief'], ['午盘分析', 'midday_brief'], ['收盘分析', 'market_overview']]) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await page.getByRole('heading', { level: 1, name: `${dates[0]} ${type.replaceAll('_', '')}原文` }).waitFor()
    await page.waitForFunction(t => new URL(location.href).searchParams.get('period') === t, type)
    assert.equal(await page.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed'), 'true')
  }
  await page.selectOption('#market-brief-date', dates[1])
  await page.getByRole('heading', { level: 1, name: `${dates[1]} marketoverview原文` }).waitFor()
  await page.goto(`${base}/investment/briefs?date=${dates[1]}&period=midday_brief`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { level: 1, name: `${dates[1]} middaybrief原文` }).waitFor()
  await page.reload({ waitUntil: 'networkidle' })
  assert.equal(await page.title(), `${dates[1]} middaybrief原文 · 每日市场简报`)

  for (const theme of ['light', 'dark']) {
    await page.evaluate(t => { document.documentElement.dataset.theme = t }, theme)
    await assertFontFloor(page, '.briefs-page', `三时段简报 ${theme}`)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  }

  // 未发布时段不自动展示另一个时段或旧本地稿。
  await page.route('**/api/market-briefs/2026-11-11', route => route.fulfill({ json: {
    trade_date: dates[0], analyses: [fixture(dates[0], 'morning_brief')],
  } }))
  await page.goto(`${base}/investment/briefs?date=${dates[0]}`, { waitUntil: 'networkidle' })
  await page.getByText(`${dates[0]} 的收盘分析尚未发布`, { exact: true }).waitFor()
  await page.getByRole('button', { name: '早盘分析', exact: true }).click()
  await page.getByRole('heading', { level: 1, name: `${dates[0]} morningbrief原文` }).waitFor()
  await page.unroute('**/api/market-briefs/2026-11-11')

  // 故障与恶意内容使用独立测试页，避免预期502/CSP日志污染全站零错误检查。
  const safetyContext = await page.context().browser().newContext()
  const safetyPage = await safetyContext.newPage()
  try {
    await safetyPage.route('**/api/market-briefs/dates', route => route.fulfill({ status: 502, json: { error: '源站暂时不可用' } }))
    await safetyPage.goto(`${base}/investment/briefs`, { waitUntil: 'networkidle' })
    await safetyPage.getByRole('alert').getByText('源站暂时不可用').waitFor()
    await safetyPage.unroute('**/api/market-briefs/dates')
    await safetyPage.route('**/api/market-briefs/2026-11-11', route => route.fulfill({ json: {
      trade_date: dates[0], analyses: [fixture(dates[0], 'market_overview', true)],
    } }))
    await safetyPage.getByRole('button', { name: '重新读取', exact: true }).click()
    await safetyPage.getByRole('heading', { level: 1, name: `${dates[0]} marketoverview原文` }).waitFor()
    assert.equal(await safetyPage.locator('.brief-markdown script,.brief-markdown img,.brief-markdown iframe,.brief-markdown [onerror]').count(), 0)
    assert.equal(await safetyPage.evaluate(() => window.briefInjected), undefined)
  } finally { await safetyContext.close() }

  await page.goto(`${base}/investment/briefs?date=${dates[0]}`, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { level: 1, name: `${dates[0]} marketoverview原文` }).waitFor()

  // 日期并发切换时，较慢旧请求不能覆盖新日期。
  await page.route('**/api/market-briefs/2026-11-10', async route => {
    await new Promise(resolve => setTimeout(resolve, 150))
    await route.fulfill({ json: await briefFixtureService.daily(dates[1]) }).catch(() => {})
  })
  await page.selectOption('#market-brief-date', dates[1])
  await page.selectOption('#market-brief-date', dates[0])
  await page.getByRole('heading', { level: 1, name: `${dates[0]} marketoverview原文` }).waitFor()
  await page.waitForTimeout(200)
  assert.equal(await page.locator('.briefs-heading h1').innerText(), `${dates[0]} marketoverview原文`)
  await page.unroute('**/api/market-briefs/2026-11-10')

  await page.route('**/api/market-briefs/dates', route => route.fulfill({ json: { dates: [] } }))
  await page.goto(`${base}/investment/briefs`, { waitUntil: 'networkidle' })
  await page.getByText('暂时没有市场分析', { exact: true }).waitFor()
  assert.equal(await page.locator('.brief-markdown').count(), 0)
  await page.unroute('**/api/market-briefs/dates')
}
