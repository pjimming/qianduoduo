import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

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
    }
    const outlook = sections[7]
    const subheadings = [...outlook.matchAll(/^###[ \t]+(.+?)[ \t]*\r?$/gmu)]
      .map((match) => match[1])
    assert.deepEqual(subheadings, ['短期（1-2 周）', '中期（1-3 个月）'],
      `${file} 展望章必须依次包含短期和中期两个三级标题`)
  }
})
