import { dateMs } from './useFormatters'

const DAY_MS = 24 * 60 * 60 * 1000

export interface ChartMargins {
  top: number
  right: number
  bottom: number
  left: number
}

export interface ChartGeometry {
  plotWidth: number
  plotHeight: number
  plotBottom: number
  minTime: number
  maxTime: number
  spanDays: number
  xForIndex: (index: number) => number
}

export interface ChartPoint<TRecord> {
  x: number
  y: number
  top: number
  bottom: number
  record: TRecord
}

export function niceStep(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(rawStep))
  const error = rawStep / power
  let factor = 10
  if (error <= 1) factor = 1
  else if (error <= 2) factor = 2
  else if (error <= 5) factor = 5
  return factor * power
}

export function niceTicks(
  min: number,
  max: number,
  count = 4,
): { min: number; max: number; ticks: number[] } {
  let nextMin = min
  let nextMax = max
  if (nextMin === nextMax) {
    const padding = Math.abs(nextMin) * 0.1 || 1
    nextMin -= padding
    nextMax += padding
  }
  const step = niceStep((nextMax - nextMin) / Math.max(1, count))
  const niceMin = Math.floor(nextMin / step) * step
  const niceMax = Math.ceil(nextMax / step) * step
  const ticks: number[] = []
  for (let value = niceMin; value <= niceMax + step * 0.5; value += step) {
    ticks.push(Number(value.toPrecision(12)))
  }
  return { min: niceMin, max: niceMax, ticks }
}

export function chartGeometry<T extends { date: string }>(
  records: T[],
  width: number,
  height: number,
  margins: ChartMargins,
): ChartGeometry {
  const times = records.map((record) => dateMs(record.date))
  const minTime = Math.min(...times)
  const maxTime = Math.max(...times)
  const timeSpan = maxTime - minTime
  const plotWidth = width - margins.left - margins.right
  const plotHeight = height - margins.top - margins.bottom
  const xForIndex = (index: number): number => {
    if (records.length === 1 || timeSpan === 0) {
      return margins.left + plotWidth / 2
    }
    return margins.left + ((times[index] - minTime) / timeSpan) * plotWidth
  }
  return {
    plotWidth,
    plotHeight,
    plotBottom: margins.top + plotHeight,
    minTime,
    maxTime,
    spanDays: Math.max(1, Math.round(timeSpan / DAY_MS) + 1),
    xForIndex,
  }
}

export function xAxisIndices(recordCount: number, width: number): number[] {
  const maxLabels = width < 520 ? 4 : width < 760 ? 5 : 6
  const labelCount = Math.min(maxLabels, recordCount)
  if (labelCount === 0) return []
  const indices: number[] = []
  for (let index = 0; index < labelCount; index += 1) {
    const point = Math.round((index * (recordCount - 1)) / Math.max(1, labelCount - 1))
    if (!indices.includes(point)) indices.push(point)
  }
  return indices
}
