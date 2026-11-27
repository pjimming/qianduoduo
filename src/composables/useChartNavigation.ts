import { onMounted, onUnmounted, ref } from 'vue'

interface ChartNavigation {
  canNavigate: () => boolean
  canPan: () => boolean
  visibleCount: () => number
  pan: (offset: number) => void
  zoom: (factor: number, anchor: number) => void
  hover: (event: PointerEvent) => void
  clearHover: () => void
}

export function useChartNavigation(options: ChartNavigation) {
  const dragging = ref(false)
  let drag: { pointerId: number; target: SVGRectElement; origin: number; width: number } | null = null
  let wheelDelta = 0

  function endDrag(event?: PointerEvent): void {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return
    const { target, pointerId } = drag
    drag = null
    dragging.value = false
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
  }

  function startDrag(event: PointerEvent): void {
    if (drag || event.button !== 0 || event.pointerType === 'touch' || !options.canPan()) return
    const target = event.currentTarget as SVGRectElement
    const width = target.getBoundingClientRect().width
    if (!width) return
    target.setPointerCapture(event.pointerId)
    drag = { pointerId: event.pointerId, target, origin: event.clientX, width }
    dragging.value = true
    options.clearHover()
  }

  function movePointer(event: PointerEvent): void {
    if (!drag) {
      options.hover(event)
      return
    }
    if (event.pointerId !== drag.pointerId) return
    const pixelsPerRecord = drag.width / Math.max(1, options.visibleCount() - 1)
    const offset = Math.round((drag.origin - event.clientX) / pixelsPerRecord)
    if (offset) {
      drag.origin -= offset * pixelsPerRecord
      options.pan(offset)
    }
  }

  function leavePlot(): void {
    wheelDelta = 0
    options.clearHover()
  }

  function zoomWithWheel(event: WheelEvent): void {
    if (!options.canNavigate() || event.ctrlKey || event.metaKey || !event.deltaY) return
    const rect = (event.currentTarget as SVGRectElement).getBoundingClientRect()
    if (!rect.width) return
    event.preventDefault()
    if (drag) return
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1
    const delta = event.deltaY * unit
    wheelDelta = Math.sign(delta) === Math.sign(wheelDelta) ? wheelDelta + delta : delta
    if (Math.abs(wheelDelta) < 24) return
    const factor = Math.exp(Math.max(-400, Math.min(400, wheelDelta)) * 0.0022)
    const anchor = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    wheelDelta = 0
    options.clearHover()
    options.zoom(factor, anchor)
  }

  function navigateWithKeyboard(event: KeyboardEvent): void {
    if (!options.canNavigate() || event.ctrlKey || event.metaKey || event.altKey) return
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        const step = Math.max(1, Math.round(options.visibleCount() / 5))
        options.pan(event.key === 'ArrowLeft' ? -step : step)
        break
      }
      case '+':
      case '=':
        options.zoom(0.8, 0.5)
        break
      case '-':
        options.zoom(1.25, 0.5)
        break
      default:
        return
    }
    event.preventDefault()
    options.clearHover()
  }

  function cancelNavigation(event?: PointerEvent): void {
    if (event && drag && event.pointerId !== drag.pointerId) return
    endDrag(event)
    leavePlot()
  }

  const handleBlur = () => cancelNavigation()
  onMounted(() => window.addEventListener('blur', handleBlur))
  onUnmounted(() => {
    window.removeEventListener('blur', handleBlur)
    endDrag()
  })

  return {
    dragging,
    navigateWithKeyboard,
    movePointer,
    leavePlot,
    plotListeners: {
      pointerdown: startDrag,
      pointerup: endDrag,
      pointercancel: cancelNavigation,
      lostpointercapture: endDrag,
      wheel: zoomWithWheel,
    },
  }
}
