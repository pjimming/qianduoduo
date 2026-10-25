const DAY_MS = 24 * 60 * 60 * 1000

export function dateMs(value: string): number {
  return Date.parse(`${value}T00:00:00Z`)
}

export function normalizeNumber(value: number): number {
  return Math.abs(value) < 0.000000001 ? 0 : value
}

export function formatMoney(value: number | null | undefined, digits = 2): string {
  const number = Number(value) || 0
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(normalizeNumber(number))
}

export function formatSignedMoney(value: number | null | undefined, digits = 2): string {
  const number = normalizeNumber(Number(value) || 0)
  const prefix = number > 0 ? '+' : number < 0 ? '−' : ''
  return `${prefix}¥${formatMoney(Math.abs(number), digits)}`
}

export function formatPct(
  value: number | null | undefined,
  digits = 2,
  signed = false,
): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  const number = normalizeNumber(Number(value))
  const prefix = signed && number > 0 ? '+' : number < 0 ? '−' : ''
  return `${prefix}${Math.abs(number).toFixed(digits)}%`
}

export function formatPp(
  value: number | null | undefined,
  digits = 2,
  signed = false,
): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  const number = normalizeNumber(Number(value))
  const prefix = signed && number > 0 ? '+' : number < 0 ? '−' : ''
  return `${prefix}${Math.abs(number).toFixed(digits)}pp`
}

export function formatCompactMoney(value: number): string {
  const number = Number(value) || 0
  const absolute = Math.abs(number)
  if (absolute >= 1e8) return `${(number / 1e8).toFixed(2)}亿`
  if (absolute >= 1e4) return `${(number / 1e4).toFixed(1)}万`
  if (absolute >= 1e3) return `${(number / 1e3).toFixed(1)}千`
  return number.toFixed(0)
}

export function formatAxisPct(value: number): string {
  const absolute = Math.abs(value)
  if (absolute > 0 && absolute < 0.01) return `${value.toFixed(4)}%`
  if (absolute < 1) return `${value.toFixed(3)}%`
  return `${value.toFixed(2)}%`
}

export function formatDateCN(value: string | null | undefined): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(`${value}T00:00:00Z`))
}

export function formatDateShort(value: string | null | undefined): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'UTC',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(`${value}T00:00:00Z`))
    .replaceAll('/', '.')
}

export function formatAxisDate(value: string, spanDays: number): string {
  const date = new Date(`${value}T00:00:00Z`)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  if (spanDays > 330) {
    return `${String(date.getUTCFullYear()).slice(2)}/${month}`
  }
  return `${month}/${day}`
}

export function formatTerm(termDays: number | null, bucket: ProductBucketLike): string {
  if (termDays === 0) return '日开'
  if (termDays === null) return bucket === 'long' ? '长期' : '期限未定'
  return `${termDays}天`
}

type ProductBucketLike = 'cash' | 'short' | 'medium' | 'long' | 'unknown'

export function bucketLabel(bucket: ProductBucketLike): string {
  if (bucket === 'cash') return '日开（仅展示）'
  if (bucket === 'short') return '短期 1–30 天'
  if (bucket === 'medium') return '中期 31–100 天'
  if (bucket === 'long') return '长期 101 天+'
  return '期限未知'
}

export function rangeRecords<T extends { date: string }>(
  records: T[],
  range: number | 'all',
): T[] {
  if (!records.length || range === 'all') return records
  const days = Number(range)
  const last = dateMs(records.at(-1)?.date ?? '')
  const cutoff = last - (days - 1) * DAY_MS
  const selected = records.filter((record) => dateMs(record.date) >= cutoff)
  return selected.length ? selected : records.slice(-1)
}

export function periodReturn(records: Array<{ daily_return: number }>): number {
  if (!records.length) return 0
  return records.reduce((nav, record) => nav * (1 + record.daily_return), 1) - 1
}
