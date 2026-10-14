import { useEffect } from 'react'
import { useTheme } from '@/hooks/useTheme'
import { isPlatformTauri } from '@/lib/platform/utils'
import type { AppThemePayload } from '@/services/theme/authority'

export function ThemeProvider() {
  const isDark = useTheme((state) => state.isDark)
  const applyAuthorityTheme = useTheme((state) => state.applyAuthorityTheme)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
  }, [isDark])

  // Rust owns the theme and broadcasts every change. This window only paints a
  // broadcast that matches the mode it is on and is newer than what it already
  // painted, so a window stuck on defaults can no longer pull the whole app
  // back to the desktop's theme.
  useEffect(() => {
    if (!isPlatformTauri()) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<AppThemePayload>('app-theme-changed', (event) => {
          applyAuthorityTheme(event.payload)
        })
      )
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch((err) => console.error('Failed to listen app-theme-changed:', err))
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [applyAuthorityTheme])

  // Web build only: there is no native authority, so follow the OS media query
  // while the user is on `auto`.
  useEffect(() => {
    if (isPlatformTauri()) return
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleMediaChange = (event: MediaQueryListEvent) => {
      if (useTheme.getState().activeTheme !== 'auto') return
      useTheme.getState().setIsDark(event.matches)
    }
    mediaQuery.addEventListener('change', handleMediaChange)
    return () => mediaQuery.removeEventListener('change', handleMediaChange)
  }, [])

  return null
}
