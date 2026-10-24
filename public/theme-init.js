;(() => {
  try {
    const saved = localStorage.getItem('qianduoduo:theme:v1')
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const preference =
      saved === 'light' || saved === 'dark' || saved === 'system'
        ? saved
        : 'system'
    const theme =
      preference === 'system'
        ? prefersDark
          ? 'dark'
          : 'light'
        : preference
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.themePreference = preference
    document.documentElement.style.colorScheme = theme
  } catch {
    document.documentElement.dataset.theme = 'light'
    document.documentElement.dataset.themePreference = 'system'
  }
})()
