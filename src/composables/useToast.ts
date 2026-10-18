import { onUnmounted, reactive, readonly } from 'vue'

interface ToastOptions {
  error?: boolean
  duration?: number
}

interface ToastState {
  message: string
  visible: boolean
  error: boolean
}

const state = reactive<ToastState>({
  message: '',
  visible: false,
  error: false,
})

let toastTimer: number | undefined

export function useToast() {
  function show(message: string, options: ToastOptions = {}): void {
    state.message = message
    state.error = Boolean(options.error)
    state.visible = true
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      state.visible = false
    }, options.duration || 3400)
  }

  function clear(): void {
    window.clearTimeout(toastTimer)
    state.visible = false
  }

  onUnmounted(clear)

  return {
    toast: readonly(state),
    show,
    clear,
  }
}
