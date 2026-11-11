import DOMPurify from 'dompurify'
import { marked } from 'marked'

export type AnalysisType = 'morning_brief' | 'midday_brief' | 'market_overview'

export const analysisPeriods: { type: AnalysisType; label: string }[] = [
  { type: 'morning_brief', label: '早盘分析' },
  { type: 'midday_brief', label: '午盘分析' },
  { type: 'market_overview', label: '收盘分析' },
]

export interface MarketAnalysis {
  analysis_type: AnalysisType
  title: string
  content_markdown: string
  published_at: string
  generated_at: string | null
  validation_status: string | null
}

async function readBriefApi<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/market-briefs/${path}`, { signal, cache: 'no-store' })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '市场分析读取失败，请重新读取')
  return data as T
}

export const loadMarketBriefDates = (signal?: AbortSignal) =>
  readBriefApi<{ dates: string[] }>('dates', signal)

export const loadMarketAnalyses = (date: string, signal?: AbortSignal) =>
  readBriefApi<{ trade_date: string; analyses: MarketAnalysis[] }>(date, signal)

export interface RenderedMarketBrief {
  title: string
  headline: string
  html: string
  hasTables: boolean
}

// 简报正文以 `> 今日标题：……` 提供不超过 20 字的当日结论，
// 页面用它作为主标题；日期由页眉和日期选择器呈现。
const headlinePattern = /^>\s*今日标题[：:]\s*(.+?)\s*$/mu

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  )
}

function cleanMarkdownTitle(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/[*_`~]/gu, '')
    .trim()
}

export function renderMarketBrief(source: string): RenderedMarketBrief {
  const normalized = source.replace(/\r\n?/gu, '\n')
  const headlineMatch = normalized.match(headlinePattern)
  const headline = cleanMarkdownTitle(headlineMatch?.[1] ?? '').replace(
    /\s+/gu,
    ' ',
  )
  const withoutHeadline = headlineMatch
    ? `${normalized.slice(0, headlineMatch.index!)}${normalized.slice(
        headlineMatch.index! + headlineMatch[0].length,
      )}`
    : normalized
  const titleMatch = withoutHeadline.match(/^\s*#\s+(.+?)\s*(?:\n|$)/u)
  const title = cleanMarkdownTitle(titleMatch?.[1] ?? '')
  const body = titleMatch
    ? withoutHeadline.slice(titleMatch.index! + titleMatch[0].length)
    : withoutHeadline
  const rawHtml = marked.parse(body, {
    async: false,
    gfm: true,
    breaks: false,
  }) as string
  const sanitizedHtml = DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'img', 'video', 'audio', 'source'],
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
    headline,
    html: template.innerHTML,
    hasTables,
  }
}
