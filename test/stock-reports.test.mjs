import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { scopeReportCss } from '../scripts/build-report-docs.mjs'

const library = JSON.parse(
  readFileSync(new URL('../src/data/stockReports.json', import.meta.url), 'utf8'),
)
const sourceRoot = new URL('../report/', import.meta.url)
const reportRoot = new URL('../public/research/stocks/', import.meta.url)
const navPath = new URL('../public/research/scripts/report-nav.js', import.meta.url)

test('stock report manifest keeps unique, dated entries', () => {
  assert.ok(library.reports.length > 0)
  assert.equal(library.count, library.reports.length)

  const files = library.reports.map((report) => report.file)
  assert.equal(new Set(files).size, files.length)

  let previousDate = '9999-12-31'
  for (const report of library.reports) {
    assert.match(report.date, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(report.date <= previousDate, `${report.file} 未按日期倒序排列`)
    assert.ok(report.title)
    assert.ok(report.category)
    assert.ok(report.summary)
    previousDate = report.date
  }
})

test('every stock report file is archived and self-contained', () => {
  for (const report of library.reports) {
    const sourceUrl = new URL(encodeURIComponent(report.file), sourceRoot)
    const fileUrl = new URL(encodeURIComponent(report.file), reportRoot)
    assert.ok(existsSync(sourceUrl), `缺少源报告：${report.file}`)
    assert.ok(existsSync(fileUrl), `缺少报告文件：${report.file}`)

    const sourceHtml = readFileSync(sourceUrl, 'utf8')
    const html = readFileSync(fileUrl, 'utf8')
    assert.equal(html, sourceHtml, `源报告与应用副本不一致：${report.file}`)
    assert.match(html, /<html[\s>]/i)
    assert.match(html, /<\/html>/i)
    assert.match(html, /<title>/i)
    assert.match(html, /report-nav\.js/)
  }
})

test('embedded report navigation resolves back to the archived reports', () => {
  assert.ok(existsSync(navPath), '缺少报告导航脚本')
  const nav = readFileSync(navPath, 'utf8')
  assert.match(nav, /var REPORTS_BASE = "\.\.\/stocks\/";/)
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
  for (const report of library.reports) {
    const docPath = new URL(
      `../src/data/reportDocs/${report.slug}.json`,
      import.meta.url,
    )
    assert.ok(existsSync(docPath), `缺少 Vue 文档：${report.slug}`)

    const doc = JSON.parse(readFileSync(docPath, 'utf8'))
    assert.equal(doc.slug, report.slug)
    assert.equal(doc.file, report.file)
    assert.ok(doc.title)
    assert.ok(doc.html.length > 500, `${report.slug} 正文过短`)
    assert.ok(doc.css.includes('.rp-doc'))
    assert.doesNotMatch(doc.html, /<script\b/i, `${report.slug} 仍残留脚本`)
    assert.doesNotMatch(
      doc.css,
      /(^|})\s*(body|html|:root)\s*[,{]/,
      `${report.slug} 存在未作用域化的全局样式`,
    )
  }
})
