const THEME_KEY = 'pr-reviewer.theme'

export type Theme = 'dark' | 'light'

/** Stored explicit choice wins; anything else follows the system preference. */
export function resolveTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === 'dark' || stored === 'light') return stored
  return prefersDark ? 'dark' : 'light'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme)
  applyTheme(theme)
}

export function getCurrentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

export function initTheme(): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  applyTheme(resolveTheme(localStorage.getItem(THEME_KEY), prefersDark))
}
