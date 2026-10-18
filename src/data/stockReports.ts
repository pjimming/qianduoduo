import rawLibrary from './stockReports.json'

export interface StockReport {
  file: string
  slug: string
  title: string
  date: string
  category: string
  summary: string
  keywords: string
  priority: string | null
  priorityDetail: string | null
}

export interface StockReportLibrary {
  generatedAt: string
  source: string
  count: number
  reports: StockReport[]
}

export const stockReportLibrary = rawLibrary as StockReportLibrary
export const stockReports = stockReportLibrary.reports

export function reportByFile(file: string | undefined | null): StockReport | undefined {
  if (!file) return undefined
  return stockReports.find((report) => report.file === file)
}

export function reportBySlug(slug: string | undefined | null): StockReport | undefined {
  if (!slug) return undefined
  return stockReports.find((report) => report.slug === slug)
}

export function reportUrl(file: string): string {
  return `/research/stocks/${encodeURIComponent(file)}`
}

export const stockReportStats = {
  count: stockReports.length,
  latest: stockReports[0]?.date ?? '',
  earliest: stockReports[stockReports.length - 1]?.date ?? '',
  categories: new Set(stockReports.map((report) => report.category)).size,
}
