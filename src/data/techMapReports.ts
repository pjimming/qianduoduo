import { stockReports } from './stockReports'
import { techMap } from './techmap'

export interface CompanyReportLink {
  slug: string
  title: string
  date: string
  category: string
}

const CODE_PATTERN = /\b(?:00|30|60|68)\d{4}\b/g
const byCode = new Map<string, CompanyReportLink[]>()

for (const report of stockReports) {
  const codes = new Set(report.keywords.match(CODE_PATTERN) ?? [])
  for (const code of codes) {
    const list = byCode.get(code) ?? []
    list.push({
      slug: report.slug,
      title: report.title,
      date: report.date,
      category: report.category,
    })
    byCode.set(code, list)
  }
}

export function reportsForCompany(code: string): CompanyReportLink[] {
  return byCode.get(code) ?? []
}

export function firstReportForCompany(code: string): CompanyReportLink | null {
  return byCode.get(code)?.[0] ?? null
}

const techMapCodes = new Set(
  techMap.groups.flatMap((group) =>
    group.subs.flatMap((sub) =>
      sub.leaves.flatMap((leaf) => leaf.cos.map((company) => company.c)),
    ),
  ),
)

export const reportCoveredCompanyCount = [...byCode.keys()].filter((code) =>
  techMapCodes.has(code),
).length
