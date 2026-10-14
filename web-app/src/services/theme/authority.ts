/**
 * Access to the app theme authority.
 *
 * Rust owns the theme: it resolves `auto` against the desktop, paints the GTK
 * surfaces, binds every window and persists the user's choice. Webviews only
 * read the snapshot (`get_app_theme`) and report user intent
 * (`set_app_theme`); none of them decides or persists a theme on its own.
 */

import { isPlatformTauri } from '@/lib/platform/utils'
import { localStorageKey } from '@/constants/localStorage'

/** Authoritative theme snapshot. `revision` advances only on real changes. */
export type AppThemePayload = {
  mode: string
  resolved: string
  revision: number
}

export const normalizeThemeMode = (mode: string | undefined): AppTheme => {
  return mode === 'dark' || mode === 'light' ? mode : 'auto'
}

/** `true` = dark, `false` = light, `null` = not a usable resolved value. */
export const resolvedIsDark = (resolved: string | undefined): boolean | null => {
  if (resolved === 'dark') return true
  if (resolved === 'light') return false
  return null
}

export const checkOSDarkMode = (): boolean => {
  return Boolean(
    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

/**
 * Mirror the authoritative theme into localStorage.
 *
 * `index.html`'s pre-paint script can only read localStorage synchronously, so
 * the mirror keeps the very first frame in the right theme. The mirror is
 * derived from the authority — never from a webview's own guess.
 */
export const mirrorThemeForFirstPaint = (mode: string, isDark: boolean) => {
  try {
    localStorage.setItem(
      localStorageKey.theme,
      JSON.stringify({
        state: { activeTheme: normalizeThemeMode(mode), isDark },
        version: 0,
      })
    )
  } catch {
    // localStorage can be unavailable (disabled storage, quota); ignore.
  }
}

const readMirror = (): AppThemePayload => {
  let mode: AppTheme = 'auto'
  let isDark = checkOSDarkMode()
  try {
    const raw = localStorage.getItem(localStorageKey.theme)
    if (raw) {
      const state = JSON.parse(raw)?.state
      mode = normalizeThemeMode(state?.activeTheme)
      if (mode !== 'auto') isDark = mode === 'dark'
    }
  } catch {
    // Fall through to the OS heuristic.
  }
  return { mode, resolved: isDark ? 'dark' : 'light', revision: 0 }
}

/** Read the current authoritative theme without changing it. */
export async function readAppTheme(): Promise<AppThemePayload | null> {
  if (!isPlatformTauri()) return readMirror()
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<AppThemePayload>('get_app_theme')
}

/** Report a user choice; the returned snapshot is the authority's answer. */
export async function requestAppTheme(
  mode: AppTheme
): Promise<AppThemePayload | null> {
  if (!isPlatformTauri()) {
    const resolved = mode === 'auto' ? (checkOSDarkMode() ? 'dark' : 'light') : mode
    mirrorThemeForFirstPaint(mode, resolved === 'dark')
    return { mode, resolved, revision: 0 }
  }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<AppThemePayload>('set_app_theme', { mode })
}
