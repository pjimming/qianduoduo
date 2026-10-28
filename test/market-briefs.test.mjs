import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const briefRoot = new URL('../market-briefs/', import.meta.url)
const requiredSections = [
  '市场概览',
  '风格与板块',
  '关键事件',
  '报告库联动',
  '下一交易日关注',
  '一句话结论',
]

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

    for (const section of requiredSections) {
      assert.match(
        markdown,
        new RegExp(`^##\\s+${section}\\s*$`, 'mu'),
        `${file} 缺少固定章节：${section}`,
      )
    }
  }
})
