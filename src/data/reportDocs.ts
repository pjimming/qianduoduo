export interface ReportDoc {
  slug: string
  file: string
  title: string
  lang: string
  bodyClass: string
  html: string
  css: string
  headings: Array<{ id: string; level: number; text: string }>
}

const docLoaders = import.meta.glob<ReportDoc>('./reportDocs/*.json')

export function loadReportDoc(slug: string): Promise<ReportDoc> | undefined {
  const loader = docLoaders[`./reportDocs/${slug}.json`] as
    | (() => Promise<ReportDoc>)
    | undefined
  return loader ? loader() : undefined
}
