import DOMPurify from 'dompurify'
import { marked } from 'marked'

type MarkdownLoader = () => Promise<unknown>

export interface MarketBriefEntry {
  date: string
  fileName: string
  load: () => Promise<string>
}

export interface RenderedMarketBrief {
  title: string
  html: string
  hasTables: boolean
}

const markdownModules = import.meta.glob(
  '../../market-briefs/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md',
  {
    query: '?raw',
    import: 'default',
  },
) as Record<string, MarkdownLoader>

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  )
}

export const marketBriefEntries: MarketBriefEntry[] = Object.entries(
  markdownModules,
)
  .flatMap(([path, load]) => {
    const match = path.match(
      /^\.\.\/\.\.\/market-briefs\/(\d{4}-\d{2}-\d{2})\.md$/u,
    )
    if (!match || !isCalendarDate(match[1])) return []
    return [
      {
        date: match[1],
        fileName: `market-briefs/${match[1]}.md`,
        load: async () => String(await load()),
      },
    ]
  })
  .sort((left, right) => right.date.localeCompare(left.date))

export function findMarketBrief(date: string): MarketBriefEntry | undefined {
  return marketBriefEntries.find((entry) => entry.date === date)
}

function cleanMarkdownTitle(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/[*_`~]/gu, '')
    .trim()
}

export function renderMarketBrief(source: string): RenderedMarketBrief {
  const normalized = source.replace(/\r\n?/gu, '\n')
  const titleMatch = normalized.match(/^\s*#\s+(.+?)\s*(?:\n|$)/u)
  const title = cleanMarkdownTitle(titleMatch?.[1] ?? '')
  const body = titleMatch
    ? normalized.slice(titleMatch.index! + titleMatch[0].length)
    : normalized
  const rawHtml = marked.parse(body, {
    async: false,
    gfm: true,
    breaks: false,
  }) as string
  const sanitizedHtml = DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['style'],
  })
  const template = document.createElement('template')
  template.innerHTML = sanitizedHtml

  for (const anchor of template.content.querySelectorAll('a')) {
    const href = anchor.getAttribute('href') ?? ''
    if (/^https?:\/\//iu.test(href)) {
      anchor.setAttribute('target', '_blank')
      anchor.setAttribute('rel', 'noopener noreferrer')
    }
  }

  const hasTables = template.content.querySelector('table') !== null
  for (const table of template.content.querySelectorAll('table')) {
    const wrapper = document.createElement('div')
    wrapper.className = 'brief-table-scroll'
    wrapper.tabIndex = 0
    wrapper.setAttribute('role', 'region')
    wrapper.setAttribute('aria-label', '简报表格，可横向滚动')
    table.parentNode?.insertBefore(wrapper, table)
    wrapper.appendChild(table)
  }

  return {
    title,
    html: template.innerHTML,
    hasTables,
  }
}
