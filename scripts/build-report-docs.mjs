#!/usr/bin/env node
/**
 * 把 report/*.html 转成应用内 Vue 阅读器可直接渲染的文档数据。
 *
 * 产物：
 * - src/data/reportDocs/<slug>.json  正文、作用域化 CSS、章节锚点
 * - src/data/reportSearch.json       按 h2 分段的正文检索索引
 * - public/research/media/<slug>/    从正文抽出的图片（构建生成，勿手动编辑）
 *
 * report/*.html 仍是唯一可编辑的调研源文件；其余都是构建产物。
 */

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = path.join(root, 'report')
const outputDir = path.join(root, 'src', 'data', 'reportDocs')
const searchPath = path.join(root, 'src', 'data', 'reportSearch.json')
const mediaDir = path.join(root, 'public', 'research', 'media')
const scopeRoot = '.rp-doc'
let sharpLib = null

function splitTopLevel(value, separator) {
  const parts = []
  let start = 0
  let depth = 0
  let quote = null

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (quote) {
      if (char === '\\') i += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
    else if (char === separator && depth === 0) {
      parts.push(value.slice(start, i))
      start = i + 1
    }
  }

  parts.push(value.slice(start))
  return parts
}

function findMatchingBrace(css, openIndex) {
  let depth = 0
  let quote = null

  for (let i = openIndex; i < css.length; i += 1) {
    const char = css[i]
    if (quote) {
      if (char === '\\') i += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }

  return -1
}

function findRuleBoundary(css, start) {
  let depth = 0
  let quote = null

  for (let i = start; i < css.length; i += 1) {
    const char = css[i]
    if (quote) {
      if (char === '\\') i += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && (char === '{' || char === '}')) return i
  }

  return -1
}

function scopeSelector(selector) {
  const value = selector.trim()
  if (!value) return value

  if (/^(?::root|html|body)$/.test(value)) return scopeRoot

  const leadingRoot = /^(?::root|html|body)(?=[\s>+~.#:[*])/.exec(value)
  if (leadingRoot) {
    return value.replace(/^(?::root|html|body)/, scopeRoot)
  }

  if (value === '*') return `${scopeRoot} *`
  return `${scopeRoot} ${value}`
}

function scopeBlock(css) {
  let output = ''
  let index = 0

  while (index < css.length) {
    const boundary = findRuleBoundary(css, index)
    if (boundary === -1) {
      output += css.slice(index)
      break
    }

    const prelude = css.slice(index, boundary)
    if (css[boundary] === '}') {
      output += prelude
      index = boundary + 1
      continue
    }

    const close = findMatchingBrace(css, boundary)
    if (close === -1) {
      output += css.slice(index)
      break
    }

    const body = css.slice(boundary + 1, close)
    const header = prelude.trim()

    if (header.startsWith('@')) {
      const separator = header.search(/[\s({]/)
      const name = header.slice(1, separator === -1 ? undefined : separator).toLowerCase()
      if (['media', 'supports', 'container', 'layer'].includes(name)) {
        output += `${prelude}{${scopeBlock(body)}}`
      } else {
        output += `${prelude}{${body}}`
      }
    } else {
      const selectors = splitTopLevel(header, ',')
        .map(scopeSelector)
        .join(', ')
      output += `${selectors}{${body}}`
    }

    index = close + 1
  }

  return output
}

export function scopeReportCss(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return scopeBlock(withoutComments).trim()
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function textOnly(html) {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function stripEmbeddedChrome(body) {
  return body
    .replace(
      /\s*<a\b(?=[^>]*\bdata-report-page-home\b)[^>]*>[\s\S]*?<\/a>\s*/gi,
      '',
    )
    .replace(/<!--\s*↓\s*报告导航[\s\S]*?-->/g, '')
    .replace(
      /<script\b[^>]*\bsrc=["'][^"']*report-nav\.js["'][^>]*>\s*<\/script>/gi,
      '',
    )
    .trim()
}

function protectNav(html) {
  const blocks = []
  const masked = html.replace(/<nav\b[\s\S]*?<\/nav>/gi, (block) => {
    blocks.push(block)
    return `\u0000RPNAV${blocks.length - 1}\u0000`
  })
  return {
    html: masked,
    restore: (value) =>
      value.replace(/\u0000RPNAV(\d+)\u0000/g, (_, index) => blocks[Number(index)]),
  }
}

function ensureHeadingIds(html) {
  let index = 0
  const headings = []
  const output = html.replace(
    /<h([23])([^>]*)>([\s\S]*?)<\/h\1>/gi,
    (match, level, attrs, inner) => {
      let id = /\bid=["']([^"']+)["']/i.exec(attrs)?.[1]
      if (!id) {
        index += 1
        id = `rp-sec-${index}`
        attrs = `${attrs} id="${id}"`
      }
      headings.push({ id, level: Number(level), text: textOnly(inner) })
      return `<h${level}${attrs}>${inner}</h${level}>`
    },
  )
  return { html: output, headings }
}

function pngSize(buffer) {
  if (buffer.length < 24) return null
  if (buffer.toString('ascii', 1, 4) !== 'PNG') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

async function extractImages(html, slug) {
  let count = 0
  let bytes = 0
  const files = []
  const images = []

  let output = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch =
      /\bsrc=["'](data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=\s]+))["']/i.exec(
        tag,
      )
    if (!srcMatch) return tag
    const id = images.length
    images.push({ tag, srcMatch })
    return `\u0000RPIMG${id}\u0000`
  })

  for (let id = 0; id < images.length; id += 1) {
    const { tag, srcMatch } = images[id]

    const mime = srcMatch[2].toLowerCase()
    let extension = mime === 'jpeg' ? 'jpg' : mime === 'svg+xml' ? 'svg' : mime
    let buffer = Buffer.from(srcMatch[3].replace(/\s+/g, ''), 'base64')
    if (!buffer.length) {
      output = output.replace(`\u0000RPIMG${id}\u0000`, tag)
      continue
    }

    const size = extension === 'png' ? pngSize(buffer) : null
    if (sharpLib && ['png', 'jpg', 'jpeg'].includes(extension)) {
      try {
        const webp = await sharpLib(buffer).webp({ quality: 88, effort: 5 }).toBuffer()
        if (webp.length < buffer.length) {
          buffer = webp
          extension = 'webp'
        }
      } catch {
        // 转换失败时保留原图，不阻塞整篇报告构建。
      }
    }

    const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 12)
    const fileName = `${hash}.${extension}`
    count += 1
    bytes += buffer.length
    files.push({ fileName, buffer })
    const url = `/research/media/${encodeURIComponent(slug)}/${fileName}`

    let next = tag.replace(srcMatch[0], `src="${url}"`)
    if (!/\bloading=/i.test(next)) next = next.replace(/^<img/i, '<img loading="lazy"')
    if (!/\bdecoding=/i.test(next)) next = next.replace(/^<img/i, '<img decoding="async"')
    if (size && !/\bwidth=/i.test(next)) {
      next = next.replace(/^<img/i, `<img width="${size.width}" height="${size.height}"`)
    }
    output = output.replace(`\u0000RPIMG${id}\u0000`, next)
  }

  return { html: output, count, bytes, files }
}

function buildSearchSections(html) {
  const sections = []
  const matches = [...html.matchAll(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi)]

  const intro = textOnly(html.slice(0, matches[0]?.index ?? html.length))
  if (intro.length > 120) {
    sections.push({ id: '', heading: '开篇', text: intro.slice(0, 12000) })
  }

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const start = (match.index ?? 0) + match[0].length
    const end = matches[index + 1]?.index ?? html.length
    const id = /\bid=["']([^"']+)["']/i.exec(match[1])?.[1] ?? ''
    const heading = textOnly(match[2])
    const text = textOnly(html.slice(start, end))
    if (!heading && !text) continue
    sections.push({ id, heading, text: text.slice(0, 12000) })
  }

  return sections
}

async function extractReport(html, fileName) {
  const slug = fileName.replace(/\.html$/i, '')
  const title = textOnly(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? slug)
  const displayTitle = title
    .replace(/\s*[|·｜]\s*\d{4}-\d{2}-\d{2}\s*$/, '')
    .replace(/（\d{4}-\d{2}-\d{2}）\s*$/, '')
    .trim()
  const bodyMatch = html.match(/<body([^>]*)>([\s\S]*?)<\/body>/i)
  if (!bodyMatch) throw new Error(`${fileName} 缺少 <body>`)

  const lang = html.match(/<html[^>]*\blang=["']([^"']+)["']/i)?.[1] ?? 'zh-CN'
  const bodyClass = bodyMatch[1].match(/\bclass=["']([^"']*)["']/i)?.[1] ?? ''
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1])
    .join('\n')
  const date = /(\d{4}-\d{2}-\d{2})\.html$/i.exec(fileName)?.[1] ?? ''
  const category = html.match(/<!--\s*rpnav-tag:\s*(.*?)\s*-->/i)?.[1] ?? ''
  let content = stripEmbeddedChrome(bodyMatch[2])

  if (/<script\b/i.test(content)) {
    throw new Error(`${fileName} 含内联脚本，Vue 阅读器只渲染静态报告内容`)
  }
  if (/\bon[a-z]+\s*=/i.test(content) || /javascript:/i.test(content)) {
    throw new Error(`${fileName} 含内联事件或 javascript: 链接，请先清理`)
  }

  const nav = protectNav(content)
  const withIds = ensureHeadingIds(nav.html)
  content = nav.restore(withIds.html)

  const searchSections = buildSearchSections(content)
  const images = await extractImages(content, slug)
  content = images.html

  return {
    doc: {
      slug,
      file: fileName,
      title,
      lang,
      bodyClass,
      html: content,
      css: scopeReportCss(styles),
      headings: withIds.headings,
    },
    search: {
      slug,
      file: fileName,
      title: displayTitle || title,
      date,
      category,
      sections: searchSections,
    },
    images,
  }
}

async function main() {
  if (!existsSync(sourceDir)) {
    throw new Error(`找不到报告源目录：${sourceDir}`)
  }

  const files = (await readdir(sourceDir))
    .filter((file) => file.toLowerCase().endsWith('.html'))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))

  if (files.length === 0) {
    throw new Error(`报告源目录没有 HTML：${sourceDir}`)
  }

  try {
    sharpLib = (await import('sharp')).default
  } catch {
    sharpLib = null
  }

  await rm(outputDir, { recursive: true, force: true })
  await rm(mediaDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })
  await mkdir(mediaDir, { recursive: true })

  const search = []
  let imageCount = 0
  let imageBytes = 0
  let htmlBytes = 0

  for (const file of files) {
    const html = await readFile(path.join(sourceDir, file), 'utf8')
    const { doc, search: searchDoc, images } = await extractReport(html, file)
    if (!doc.css) throw new Error(`${file} 没有可用的 <style>，无法在应用内渲染`)
    if (!doc.html) throw new Error(`${file} 正文为空`)
    await writeFile(
      path.join(outputDir, `${doc.slug}.json`),
      `${JSON.stringify(doc)}\n`,
      'utf8',
    )
    for (const image of images.files) {
      const targetDir = path.join(mediaDir, doc.slug)
      await mkdir(targetDir, { recursive: true })
      await writeFile(path.join(targetDir, image.fileName), image.buffer)
    }
    search.push(searchDoc)
    imageCount += images.count
    imageBytes += images.bytes
    htmlBytes += Buffer.byteLength(doc.html) + Buffer.byteLength(doc.css)
  }

  await writeFile(searchPath, `${JSON.stringify(search)}\n`, 'utf8')

  console.log(
    `已生成 ${files.length} 篇 Vue 报告文档 -> ${path.relative(root, outputDir)}（${(
      htmlBytes /
      1024 /
      1024
    ).toFixed(2)} MB）`,
  )
  console.log(
    `已外置 ${imageCount} 张图片 -> ${path.relative(root, mediaDir)}（${(
      imageBytes /
      1024 /
      1024
    ).toFixed(2)} MB）`,
  )
  console.log(`已生成正文检索索引 -> ${path.relative(root, searchPath)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
