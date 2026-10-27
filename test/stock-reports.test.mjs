import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { scopeReportCss } from '../scripts/build-report-docs.mjs'

const library = JSON.parse(
  readFileSync(new URL('../src/data/stockReports.json', import.meta.url), 'utf8'),
)
const sourceRoot = new URL('../report/', import.meta.url)
const documentRoot = new URL('../src/data/reportDocs/', import.meta.url)
const searchIndex = JSON.parse(
  readFileSync(new URL('../src/data/reportSearch.json', import.meta.url), 'utf8'),
)

test('stock report manifest keeps unique, dated entries', () => {
  assert.ok(library.reports.length > 0)
  assert.equal(library.count, library.reports.length)

  const files = library.reports.map((report) => report.file)
  assert.equal(new Set(files).size, files.length)

  let previousPublishedAt = '9999-12-31 23:59'
  let previousDate = '9999-12-31'
  for (const report of library.reports) {
    assert.match(report.date, /^\d{4}-\d{2}-\d{2}$/)
    assert.match(report.publishedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    assert.ok(
      report.publishedAt <= previousPublishedAt,
      `${report.file} 未按发布时间倒序排列`,
    )
    if (report.publishedAt === previousPublishedAt) {
      assert.ok(report.date <= previousDate, `${report.file} 未按日期倒序排列`)
    }
    assert.ok(report.title)
    assert.ok(report.category)
    assert.ok(report.summary)
    previousPublishedAt = report.publishedAt
    previousDate = report.date
  }
})

test('source reports and the Vue library manifest contain the same complete file set', () => {
  const sourceFiles = readdirSync(sourceRoot)
    .filter((file) => file.toLowerCase().endsWith('.html'))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  const manifestFiles = library.reports
    .map((report) => report.file)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))

  assert.deepEqual(manifestFiles, sourceFiles)

  for (const report of library.reports) {
    const sourceUrl = new URL(report.file, sourceRoot)
    assert.ok(existsSync(sourceUrl), `缺少源报告：${report.file}`)

    const html = readFileSync(sourceUrl, 'utf8')
    assert.match(html, /<html[\s>]/i)
    assert.match(html, /<\/html>/i)
    assert.match(html, /<title>/i)
    assert.match(html, /<style[\s>]/i)
    assert.match(html, /<body[\s>]/i)
    assert.match(html, /report-nav\.js/)

    const pageHomeLinks = [
      ...html.matchAll(
        /<a\b(?=[^>]*\bdata-report-page-home\b)[^>]*>[\s\S]*?<\/a>/gi,
      ),
    ]
    assert.equal(pageHomeLinks.length, 1, `${report.file} 应有且仅有一个首页链接`)
    assert.match(
      pageHomeLinks[0][0],
      /\bhref=["']\.\.\/research\/index\.html["']/,
      `${report.file} 的首页链接路径不正确`,
    )
    assert.match(pageHomeLinks[0][0], /返回首页/u)
  }
})

test('public report copies and their static navigation are not versioned', () => {
  assert.equal(
    existsSync(new URL('../public/research/stocks/', import.meta.url)),
    false,
    'public/research/stocks 不应继续存在',
  )
  assert.equal(
    existsSync(new URL('../public/research/scripts/report-nav.js', import.meta.url)),
    false,
    'public/research/scripts/report-nav.js 不应继续存在',
  )
})

test('standalone research library loads the shared navigation from the workspace root', () => {
  const html = readFileSync(new URL('../research/index.html', import.meta.url), 'utf8')
  assert.match(html, /<script src="\.\.\/scripts\/report-nav\.js" defer><\/script>/)
})

test('report CSS is scoped into the reader root', () => {
  const css = scopeReportCss(`
    :root { --ink: #111; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    h2, .card { color: var(--ink); }
    @media (max-width: 720px) {
      body { font-size: 14px; }
      .card { padding: 0; }
    }
    @keyframes fade { from { opacity: 0 } to { opacity: 1 } }
  `)

  assert.match(css, /^\.rp-doc\s*\{/)
  assert.match(css, /\.rp-doc \*\s*\{/)
  assert.match(css, /\.rp-doc h2, \.rp-doc \.card\s*\{/)
  assert.match(css, /@media \(max-width: 720px\)\s*\{\s*\.rp-doc\s*\{/)
  assert.match(css, /@keyframes fade \{ from \{ opacity: 0 \} to \{ opacity: 1 \} \}/)
  assert.doesNotMatch(css, /(^|})\s*body\s*\{/)
})

test('every stock report has a generated Vue document', () => {
  const documentFiles = readdirSync(documentRoot)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/i, ''))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  const reportSlugs = library.reports
    .map((report) => report.slug)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))

  assert.deepEqual(documentFiles, reportSlugs)
  assert.equal(searchIndex.length, library.reports.length)

  for (const report of library.reports) {
    const docPath = new URL(`${report.slug}.json`, documentRoot)
    assert.ok(existsSync(docPath), `缺少 Vue 文档：${report.slug}`)

    const doc = JSON.parse(readFileSync(docPath, 'utf8'))
    assert.equal(doc.slug, report.slug)
    assert.equal(doc.file, report.file)
    assert.ok(doc.title)
    assert.ok(doc.html.length > 500, `${report.slug} 正文过短`)
    assert.ok(doc.css.includes('.rp-doc'))
    assert.doesNotMatch(doc.html, /<script\b/i, `${report.slug} 仍残留脚本`)
    assert.doesNotMatch(
      doc.html,
      /data-report-page-home/i,
      `${report.slug} 的静态首页链接未从 Vue 阅读正文剥离`,
    )
    assert.doesNotMatch(
      doc.css,
      /(^|})\s*(body|html|:root)\s*[,{]/,
      `${report.slug} 存在未作用域化的全局样式`,
    )

    const searchDoc = searchIndex.find((item) => item.slug === report.slug)
    assert.ok(searchDoc, `缺少正文检索索引：${report.slug}`)
    assert.equal(searchDoc.file, report.file)
    assert.equal(searchDoc.title, report.title)
    assert.ok(searchDoc.sections.length > 0, `${report.slug} 没有可检索正文`)
  }
})
