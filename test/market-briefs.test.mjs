import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { marked } from 'marked'

const briefRoot = new URL('../market-briefs/', import.meta.url)
// The eight-section format took effect on 2026-11-03; archived briefs
// retain their original format rather than being rewritten retroactively.
const currentFormatStart = '2026-11-03'
const legacySections = [
  '市场概览',
  '风格与板块',
  '关键事件',
  '报告库联动',
  '下一交易日关注',
  '一句话结论',
]
const currentSections = [
  /^收盘概览$/u,
  /^市场为何这样走？$/u,
  /^结构性亮点：\S.*$/u,
  /^关键资金信号$/u,
  /^政策面信号$/u,
  /^估值参考$/u,
  /^后续影响与展望$/u,
  /^结论$/u,
]

function sectionHeadings(markdown) {
  return [...markdown.matchAll(/^##[ \t]+(.+?)[ \t]*\r?$/gmu)]
    .map((match) => match[1].replace(/^[一二三四五六七八]+、[ \t]*/u, ''))
}

test('market brief emphasis renders without literal double-asterisk markers', () => {
  for (const file of readdirSync(briefRoot).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name))) {
    const tokens = marked.lexer(readFileSync(new URL(file, briefRoot), 'utf8'))
    marked.walkTokens(tokens, (token) => {
      if (token.type === 'text' && !token.tokens?.length) {
        assert.ok(!token.text.includes('**'),
          `${file} 加粗未解析（检查标点与中文边界）：${token.text}`)
      }
    })
  }
})

test('market brief Markdown files use valid unique trading-date names and the fixed sections', () => {
  const files = readdirSync(briefRoot)
    .filter((file) => file.endsWith('.md') && file !== 'README.md')
    .sort()

  assert.equal(new Set(files).size, files.length)

  for (const file of files) {
    assert.match(file, /^\d{4}-\d{2}-\d{2}\.md$/u, `${file} 文件名不符合 YYYY-MM-DD.md`)
    const date = file.slice(0, -3)
    const [year, month, day] = date.split('-').map(Number)
    const parsed = new Date(Date.UTC(year, month - 1, day))
    assert.equal(
      `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-${String(parsed.getUTCDate()).padStart(2, '0')}`,
      date,
      `${file} 不是有效日期`,
    )

    const markdown = readFileSync(new URL(file, briefRoot), 'utf8').trim()
    assert.ok(markdown.length > 0, `${file} 内容为空`)
    assert.equal(
      [...markdown.matchAll(/^#\s+\S.+$/gmu)].length,
      1,
      `${file} 应有一个一级标题`,
    )

    const headlineMatch = markdown.match(
      /^>[ \t]*今日标题[：:][ \t]*(.+?)[ \t]*$/mu,
    )
    assert.ok(headlineMatch, `${file} 缺少“> 今日标题：”当日标题`)
    const headline = headlineMatch[1].replace(/\s+/gu, ' ')
    assert.ok(headline.length > 0, `${file} 今日标题不能为空`)
    assert.ok(
      [...headline].length <= 20,
      `${file} 今日标题超过 20 字：${headline}`,
    )

    const headings = sectionHeadings(markdown)
    if (date < currentFormatStart) {
      assert.deepEqual(headings, legacySections, `${file} 历史六章节顺序不正确`)
      continue
    }

    assert.equal(headings.length, 8, `${file} 必须恰有八个二级章节`)
    currentSections.forEach((pattern, index) => {
      assert.match(headings[index], pattern, `${file} 第 ${index + 1} 章不符合当前规范`)
    })
    const sections = markdown.split(/^##[ \t]+/mu)
    const structure = sections[3]
    const strengthSections = [...structure.matchAll(/^###[ \t]+(.+?)[ \t]*\r?$/gmu)]
      .map((match) => match[1])
    assert.deepEqual(strengthSections, ['强势板块', '弱势板块'],
      `${file} 结构性亮点必须同时覆盖强势和弱势板块`)
    for (const part of structure.split(/^###[ \t]+/mu).slice(1)) {
      assert.ok(part.trim().split('\n').slice(1).join('\n').trim(),
        `${file} 强弱板块小节不能只有标题`)
      // The table template follows the 2026-11-04 brief; older archives retain their layout.
      if (date >= '2026-11-04') {
        const tables = marked.lexer(part).filter((token) => token.type === 'table')
        assert.equal(tables.length, 1, `${file} 每个强弱板块小节应有一张数据表`)
        assert.deepEqual(tables[0].header.map((cell) => cell.text),
          ['板块', '涨跌幅', '第三方主力净流入', '净流入率'],
          `${file} 强弱板块表格列不符合模板`)
        assert.ok(tables[0].rows.length >= 1, `${file} 强弱板块表格不能只有表头`)
        if (date >= '2026-11-05' && !part.includes('不足五') && !part.includes('未获取到')) {
          const rows = tables[0].rows
          assert.equal(rows.length, 5, `${file} 强弱板块应分别展示前五`)
          const values = rows.map((row) => Number.parseFloat(row[2].text.replace(/[^0-9.+-]/gu, '')))
          const strong = part.startsWith('强势板块')
          assert.ok(values.every((value) => Number.isFinite(value) && (strong ? value > 0 : value < 0)),
            `${file} 前五资金方向错误`)
          assert.ok(values.every((value, index) => index === 0 || (strong
            ? values[index - 1] >= value : values[index - 1] <= value)),
            `${file} 前五应按净流入或净流出金额排序`)
        }
      }
    }
    if (date >= '2026-11-05') {
      const funds = sections[4]
      for (const code of ['510050', '510300', '159915', '588000', '512100', '510500']) {
        assert.ok(funds.includes(code), `${file} 缺少基准模板 ETF ${code}`)
      }
      assert.ok(funds.includes('合计'), `${file} ETF 应展示合计及变化`)
      const valuationTables = marked.lexer(sections[6]).filter((token) => token.type === 'table')
      const valuationIndices = valuationTables.flatMap((table) => table.rows.map((row) =>
        row[0].tokens.map((token) => token.text).join('')))
      for (const index of ['沪深300', '创业板指', '科创50']) {
        assert.ok(valuationIndices.includes(index), `${file} 缺少基准估值指数 ${index}`)
      }
    }
    const outlook = sections[7]
    const subheadings = [...outlook.matchAll(/^###[ \t]+(.+?)[ \t]*\r?$/gmu)]
      .map((match) => match[1])
    assert.deepEqual(subheadings, ['短期（1-2 周）', '中期（1-3 个月）'],
      `${file} 展望章必须依次包含短期和中期两个三级标题`)
  }
})
