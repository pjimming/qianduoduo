import { computed, ref } from 'vue'
import type { LedgerRecord, RangeValue } from '@/types/dashboard'
import { dateMs, rangeRecords } from './useFormatters'

interface RecordWindow {
  start: number
  count: number
}

export function useChartViewport(records: () => LedgerRecord[]) {
  const preset = ref<RangeValue>(30)
  const customWindow = ref<RecordWindow | null>(null)
  const presetWindow = computed(() => {
    const count = rangeRecords(records(), preset.value).length
    return { start: records().length - count, count }
  })
  const viewWindow = computed(() => {
    if (!customWindow.value) return presetWindow.value
    const count = Math.min(customWindow.value.count, records().length)
    return { start: Math.min(customWindow.value.start, records().length - count), count }
  })
  const visibleRecords = computed(() => {
    const { start, count } = viewWindow.value
    return records().slice(start, start + count)
  })
  const activeRange = computed(() => {
    const { start, count } = viewWindow.value
    if (start === presetWindow.value.start && count === presetWindow.value.count) return preset.value
    return count === records().length ? 'all' : null
  })

  function setRange(range: RangeValue): void {
    preset.value = range
    customWindow.value = null
  }

  function pan(offset: number): void {
    const { start, count } = viewWindow.value
    const nextStart = Math.max(0, Math.min(start + offset, records().length - count))
    if (nextStart !== start) customWindow.value = { start: nextStart, count }
  }

  function zoom(factor: number, anchor: number): void {
    const { start, count } = viewWindow.value
    if (!count || (factor < 1 && count <= 2)) return
    const series = records()
    const scaled = Math.round(count * factor)
    const nextCount = factor < 1
      ? Math.max(2, Math.min(count - 1, scaled))
      : Math.min(series.length, Math.max(count + 1, scaled))
    if (nextCount === count) return

    // Find the window that keeps the date under the pointer closest to its
    // original position, even when records are unevenly spaced.
    const timeAtAnchor = (first: number, size: number): number => {
      const startTime = dateMs(series[first].date)
      const endTime = dateMs(series[first + size - 1].date)
      return startTime + (endTime - startTime) * anchor
    }
    const anchorTime = timeAtAnchor(start, count)
    let left = Math.max(0, Math.min(start, start + count - nextCount))
    let right = Math.min(series.length - nextCount, Math.max(start, start + count - nextCount))
    while (left < right) {
      const middle = Math.floor((left + right) / 2)
      const before = Math.abs(timeAtAnchor(middle, nextCount) - anchorTime)
      const after = Math.abs(timeAtAnchor(middle + 1, nextCount) - anchorTime)
      if (before <= after) right = middle
      else left = middle + 1
    }
    customWindow.value = { start: left, count: nextCount }
  }

  return { visibleRecords, activeRange, setRange, pan, zoom }
}
