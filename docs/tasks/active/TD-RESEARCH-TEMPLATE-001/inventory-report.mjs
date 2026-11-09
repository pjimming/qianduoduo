import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const reportDir = path.join(root, 'report')
const out = path.join(root, 'docs/tasks/active/TD-RESEARCH-TEMPLATE-001/inventory.json')

const files = (await readdir(reportDir)).filter((f) => f.endsWith('.html')).sort()
const rows = []

for (const file of files) {
  const raw = await readFile(path.join(reportDir, file), 'utf8')
  const styleMatch = raw.match(/<style[^>]*>([\s\S]*?)<\/style>/i)
  const style = styleMatch?.[1] ?? ''
  const bodyMatch = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  const body = bodyMatch?.[1] ?? ''
  const classes = [...body.matchAll(/class="([^"]+)"/gi)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter(Boolean)
  const classCount = {}
  for (const c of classes) classCount[c] = (classCount[c] ?? 0) + 1
  const topClasses = Object.entries(classCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([c, n]) => `${c}:${n}`)
  const headings = [...body.matchAll(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({
    level: Number(m[1]),
    text: m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 70),
  }))
  const meta = (key) => raw.match(new RegExp(`<!--\\s*rpnav-${key}\\s*:\\s*([\\s\\S]*?)\\s*-->`, 'i'))?.[1].trim() ?? ''
  const title = raw.match(/<title>([\s\S]*?)<\/title>/i)?.[1].trim() ?? ''
  const sub = raw.match(/<p[^>]*class="[^"]*\bsub\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1].replace(/<[^>]+>/g, '').trim() ?? ''
  const firstStyle = style.slice(0, 200).replace(/\s+/g, ' ')
  rows.push({
    file,
    title,
    rpnavTitle: meta('title'),
    date: meta('published'),
    tag: meta('tag'),
    summary: meta('summary').length,
    priority: meta('priority'),
    styleBytes: style.length,
    bodyBytes: body.length,
    totalBytes: raw.length,
    hero: /class="[^"]*hero/.test(body) || /class='[^']*hero/.test(body),
    section: (body.match(/class="[^"]*\bsection\b/g) ?? []).length,
    toc: /class="[^"]*\btoc\b/.test(body) || /<nav[^>]*aria-label="目录"/.test(body),
    layout: /class="[^"]*\blayout\b/.test(body),
    tables: (body.match(/<table/g) ?? []).length,
    tableWraps: (body.match(/class="[^"]*table-wrap/g) ?? []).length,
    images: (body.match(/<img/g) ?? []).length,
    inlineStyles: (body.match(/style="/g) ?? []).length,
    scripts: [...body.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]),
    hasHome: /data-report-page-home/.test(raw),
    darkPref: /prefers-color-scheme/.test(style),
    darkTheme: /data-theme/.test(style),
    cssVars: [...new Set([...style.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((m) => m[1]))],
    topClasses,
    headings: headings.slice(0, 12),
    h1: headings.find((h) => h.level === 1)?.text ?? '',
    h2Count: headings.filter((h) => h.level === 2).length,
    subLength: sub.length,
  })
}

await writeFile(out, JSON.stringify(rows, null, 2))
console.log(JSON.stringify({ count: rows.length, out }, null, 2))
for (const r of rows) {
  console.log(
    [
      r.file,
      `style=${r.styleBytes}`,
      `sections=${r.section}`,
      `toc=${r.toc ? 'Y' : '-'}`,
      `layout=${r.layout ? 'Y' : '-'}`,
      `tables=${r.tables}`,
      `imgs=${r.images}`,
      `inline=${r.inlineStyles}`,
      `dark=${r.darkPref ? 'pref' : ''}${r.darkTheme ? '+theme' : ''}`,
      `h2=${r.h2Count}`,
      r.topClasses.slice(0, 8).join(','),
    ].join(' | '),
  )
}
