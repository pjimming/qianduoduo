import { computed, readonly, ref } from 'vue'

export type ThemeName = 'light' | 'dark'
export type ThemePreference = ThemeName | 'system'

export const THEME_STORAGE_KEY = 'qianduoduo:theme:v1'

const colorSchemeQuery =
  typeof window !== 'undefined'
    ? window.matchMedia?.('(prefers-color-scheme: dark)')
    : null
const systemPrefersDark = ref(colorSchemeQuery?.matches ?? false)
const preference = ref<ThemePreference>(readSavedPreference())
const resolvedTheme = computed<ThemeName>(() =>
  preference.value === 'system'
    ? systemPrefersDark.value
      ? 'dark'
      : 'light'
    : preference.value,
)
let systemListenerRegistered = false

function readSavedPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    return value === 'light' || value === 'dark' || value === 'system'
      ? value
      : 'system'
  } catch {
    return 'system'
  }
}

function syncDocument(): void {
  const theme = resolvedTheme.value
  document.documentElement.dataset.theme = theme
  document.documentElement.dataset.themePreference = preference.value
  document.documentElement.style.colorScheme = theme
}

function handleSystemThemeChange(event: MediaQueryListEvent): void {
  systemPrefersDark.value = event.matches
  if (preference.value === 'system') syncDocument()
}

export function initializeTheme(): void {
  syncDocument()
  if (colorSchemeQuery && !systemListenerRegistered) {
    colorSchemeQuery.addEventListener('change', handleSystemThemeChange)
    systemListenerRegistered = true
  }
}

export function setTheme(theme: ThemeName): void {
  setThemePreference(theme)
}

export function setThemePreference(nextPreference: ThemePreference): void {
  preference.value = nextPreference
  syncDocument()
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, nextPreference)
  } catch {
    // 本地存储不可用时只保留当前会话状态。
  }
}

export function toggleTheme(): void {
  setThemePreference(resolvedTheme.value === 'dark' ? 'light' : 'dark')
}

export function useTheme() {
  const isDark = computed(() => resolvedTheme.value === 'dark')
  const isSystem = computed(() => preference.value === 'system')
  const preferenceLabel = computed(() => {
    if (preference.value === 'system') {
      return `跟随系统（当前${resolvedTheme.value === 'dark' ? '深色' : '浅色'}）`
    }
    return resolvedTheme.value === 'dark' ? '深色' : '浅色'
  })

  return {
    preference: readonly(preference),
    theme: readonly(resolvedTheme),
    isDark,
    isSystem,
    preferenceLabel,
    setTheme,
    setThemePreference,
    toggleTheme,
  }
}
