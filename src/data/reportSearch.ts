export interface ReportSearchSection {
  id: string
  heading: string
  text: string
}

export interface ReportSearchDoc {
  slug: string
  file: string
  title: string
  date: string
  category: string
  sections: ReportSearchSection[]
}

export interface ReportSearchHit {
  slug: string
  title: string
  date: string
  heading: string
  anchor: string
  before: string
  match: string
  after: string
}

let indexPromise: Promise<ReportSearchDoc[]> | null = null

export function loadReportSearchIndex(): Promise<ReportSearchDoc[]> {
  if (!indexPromise) {
    indexPromise = import('./reportSearch.json').then(
      (module) => module.default as ReportSearchDoc[],
    )
  }
  return indexPromise
}

function normalize(value: string): string {
  return value.toLowerCase()
}

export interface ReportSearchResult {
  hits: ReportSearchHit[]
  total: number
}

export function searchReportBody(
  docs: ReportSearchDoc[],
  query: string,
  options: { limit?: number; perReport?: number } = {},
): ReportSearchResult {
  const terms = normalize(query).split(/\s+/).filter(Boolean)
  if (!terms.length) return { hits: [], total: 0 }

  const limit = options.limit ?? 12
  const perReport = options.perReport ?? 2
  const hits: ReportSearchHit[] = []
  let total = 0

  for (const doc of docs) {
    let docHits = 0
    for (const section of doc.sections) {
      const haystack = normalize(`${section.heading} ${section.text}`)
      if (!terms.every((term) => haystack.includes(term))) continue

      let source = section.text || section.heading
      let index = normalize(source).indexOf(terms[0])
      if (index === -1) {
        source = section.heading
        index = normalize(source).indexOf(terms[0])
      }
      if (index === -1) index = 0

      const start = Math.max(0, index - 70)
      const end = Math.min(source.length, index + terms[0].length + 120)
      const before = source.slice(start, index)
      const match = source.slice(index, index + terms[0].length)
      const after = source.slice(index + match.length, end)

      total += 1
      if (docHits >= perReport || hits.length >= limit) continue
      hits.push({
        slug: doc.slug,
        title: doc.title,
        date: doc.date,
        heading: section.heading || '开篇',
        anchor: section.id,
        before: `${start > 0 ? '…' : ''}${before}`,
        match,
        after: `${after}${end < source.length ? '…' : ''}`,
      })
      docHits += 1
    }
  }

  return { hits, total }
}
