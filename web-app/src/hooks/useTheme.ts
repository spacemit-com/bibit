import { create } from 'zustand'
import {
  checkOSDarkMode,
  mirrorThemeForFirstPaint,
  normalizeThemeMode,
  readAppTheme,
  requestAppTheme,
  resolvedIsDark,
  type AppThemePayload,
} from '@/services/theme/authority'

export { checkOSDarkMode }

export type ThemeState = {
  /** The user's choice as the authority sees it. */
  activeTheme: AppTheme
  /** What every surface paints right now. */
  isDark: boolean
  /** Last authority revision applied here; older broadcasts are ignored. */
  revision: number
  /** True once this webview has read the authority at least once. */
  hydrated: boolean
  /**
   * Last mode the authority confirmed for this window. The guard compares
   * against this — never against the optimistic picker value — so a window
   * whose own request failed still accepts the authority's next broadcast.
   */
  confirmedMode: AppTheme | null
  setTheme: (theme: AppTheme) => Promise<void>
  applyAuthorityTheme: (payload: AppThemePayload | null | undefined) => void
  hydrateFromAuthority: () => Promise<void>
  setIsDark: (isDark: boolean) => void
}

/**
 * Theme state derived from the Rust authority.
 *
 * This store deliberately does **not** persist anything: a webview that never
 * hydrated must not be able to hand its default (`auto`) back to disk, which is
 * how the user's saved choice used to get overwritten.
 */
export const useTheme = create<ThemeState>()((set, get) => ({
  activeTheme: 'auto',
  isDark: checkOSDarkMode(),
  revision: 0,
  hydrated: false,
  confirmedMode: null,

  setTheme: async (activeTheme) => {
    // The picker reacts immediately; the authority's answer settles the state.
    set(() => ({ activeTheme }))
    try {
      const payload = await requestAppTheme(activeTheme)
      get().applyAuthorityTheme(payload)
    } catch (error) {
      console.error('set_app_theme failed:', error)
      // Never leave the picker claiming a mode the authority never accepted.
      set(() => ({ activeTheme: get().confirmedMode ?? 'auto' }))
    }
  },

  applyAuthorityTheme: (payload) => {
    if (!payload) return
    const resolved = resolvedIsDark(payload.resolved)
    if (resolved === null) return
    const mode = normalizeThemeMode(payload.mode)
    const revision = typeof payload.revision === 'number' ? payload.revision : 0
    const state = get()
    // Rust is the only broadcaster (`APP_THEME_EVENT`), so any payload that
    // advances the revision is the user's mode as the authority sees it — a
    // window with a stale local view must follow it. Only older revisions are
    // dropped, so out-of-order delivery cannot roll the theme back.
    if (revision < state.revision) return
    mirrorThemeForFirstPaint(mode, resolved)
    set(() => ({
      activeTheme: mode,
      isDark: resolved,
      revision,
      hydrated: true,
      confirmedMode: mode,
    }))
  },

  hydrateFromAuthority: async () => {
    try {
      const payload = await readAppTheme()
      if (payload) get().applyAuthorityTheme(payload)
      else set(() => ({ hydrated: true }))
    } catch (error) {
      console.error('get_app_theme failed:', error)
      set(() => ({ hydrated: true }))
    }
  },

  setIsDark: (isDark) => set(() => ({ isDark })),
}))
