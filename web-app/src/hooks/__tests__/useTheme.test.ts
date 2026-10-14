import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: true,
}))

vi.mock('@/lib/platform/utils', () => ({
  isPlatformTauri: () => h.isTauri,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))

import { checkOSDarkMode, useTheme } from '../useTheme'

const readMirror = () => {
  const raw = localStorage.getItem('theme')
  return raw ? JSON.parse(raw) : null
}

describe('useTheme', () => {
  let originalMatchMedia: typeof window.matchMedia

  beforeEach(() => {
    vi.clearAllMocks()
    h.isTauri = true
    localStorage.clear()
    originalMatchMedia = window.matchMedia
    useTheme.setState({
      activeTheme: 'auto',
      isDark: false,
      revision: 0,
      hydrated: false,
      confirmedMode: null,
    })
  })

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  describe('checkOSDarkMode', () => {
    it('follows the OS media query', () => {
      window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never
      expect(checkOSDarkMode()).toBe(true)
      window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never
      expect(checkOSDarkMode()).toBe(false)
    })
  })

  describe('authoritative state', () => {
    it('starts unhydrated instead of guessing a mode', () => {
      expect(useTheme.getState().hydrated).toBe(false)
      expect(useTheme.getState().activeTheme).toBe('auto')
    })

    it('applies an authoritative payload and mirrors it for the first paint', () => {
      useTheme.getState().applyAuthorityTheme({
        mode: 'dark',
        resolved: 'dark',
        revision: 5,
      })
      expect(useTheme.getState().hydrated).toBe(true)
      expect(useTheme.getState().activeTheme).toBe('dark')
      expect(useTheme.getState().isDark).toBe(true)
      expect(useTheme.getState().revision).toBe(5)
      expect(readMirror()).toEqual({
        state: { activeTheme: 'dark', isDark: true },
        version: 0,
      })
    })

    // Regression: a window that never hydrated used to hand its default `auto`
    // back to the shared store (and to disk), turning a dark app light.
    // Rust is the single broadcaster, so a mode change can only come from the
    // user: every window follows it instead of keeping a stale local mode.
    it('follows the authority when the mode changes', () => {
      useTheme.setState({
        activeTheme: 'dark',
        isDark: true,
        hydrated: true,
        revision: 4,
        confirmedMode: 'dark',
      })
      useTheme.getState().applyAuthorityTheme({
        mode: 'auto',
        resolved: 'light',
        revision: 7,
      })
      expect(useTheme.getState().activeTheme).toBe('auto')
      expect(useTheme.getState().isDark).toBe(false)
      expect(useTheme.getState().revision).toBe(7)
    })

    it('adopts the authority mode when this window has nothing yet', () => {
      useTheme.getState().applyAuthorityTheme({
        mode: 'dark',
        resolved: 'dark',
        revision: 1,
      })
      expect(useTheme.getState().activeTheme).toBe('dark')
      expect(useTheme.getState().hydrated).toBe(true)
    })

    it('ignores a stale revision', () => {
      useTheme.setState({
        activeTheme: 'dark',
        isDark: true,
        hydrated: true,
        revision: 9,
        confirmedMode: 'dark',
      })
      useTheme.getState().applyAuthorityTheme({
        mode: 'dark',
        resolved: 'light',
        revision: 3,
      })
      expect(useTheme.getState().isDark).toBe(true)
      expect(useTheme.getState().revision).toBe(9)
    })

    it('ignores malformed payloads', () => {
      useTheme.getState().applyAuthorityTheme(undefined)
      useTheme.getState().applyAuthorityTheme({ mode: 'dark', resolved: 'neon', revision: 1 })
      expect(useTheme.getState().hydrated).toBe(false)
      expect(useTheme.getState().isDark).toBe(false)
    })
  })

  describe('hydration and user choice', () => {
    it('hydrates from the authoritative snapshot', async () => {
      h.invoke.mockResolvedValueOnce({
        mode: 'dark',
        resolved: 'dark',
        revision: 12,
      })
      await useTheme.getState().hydrateFromAuthority()
      expect(h.invoke).toHaveBeenCalledWith('get_app_theme')
      expect(useTheme.getState().activeTheme).toBe('dark')
      expect(useTheme.getState().isDark).toBe(true)
      expect(useTheme.getState().revision).toBe(12)
    })

    it('survives a failed hydration without inventing a theme', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      h.invoke.mockRejectedValueOnce(new Error('no service hub'))
      await useTheme.getState().hydrateFromAuthority()
      expect(useTheme.getState().hydrated).toBe(true)
      expect(useTheme.getState().activeTheme).toBe('auto')
      spy.mockRestore()
    })

    it('sends the user choice and adopts the authoritative answer', async () => {
      h.invoke.mockResolvedValueOnce({
        mode: 'auto',
        resolved: 'dark',
        revision: 2,
      })
      await useTheme.getState().setTheme('auto')
      expect(h.invoke).toHaveBeenCalledWith('set_app_theme', { mode: 'auto' })
      expect(useTheme.getState().activeTheme).toBe('auto')
      expect(useTheme.getState().isDark).toBe(true)
    })

    it('keeps the painted theme when the authority call fails', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      useTheme.setState({
        activeTheme: 'dark',
        isDark: true,
        hydrated: true,
        confirmedMode: 'dark',
      })
      h.invoke.mockRejectedValueOnce(new Error('ipc down'))
      await useTheme.getState().setTheme('light')
      expect(useTheme.getState().isDark).toBe(true)
      // The picker must not keep claiming a mode the authority rejected.
      expect(useTheme.getState().activeTheme).toBe('dark')
      spy.mockRestore()
    })

    it('still accepts the authority after a failed user request', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      useTheme.setState({
        activeTheme: 'light',
        isDark: false,
        hydrated: true,
        confirmedMode: 'light',
      })
      h.invoke.mockRejectedValueOnce(new Error('ipc down'))
      await useTheme.getState().setTheme('dark')
      // The authority (another window, or a later resolve) still wins.
      useTheme.getState().applyAuthorityTheme({
        mode: 'dark',
        resolved: 'dark',
        revision: 6,
      })
      expect(useTheme.getState().isDark).toBe(true)
      expect(useTheme.getState().activeTheme).toBe('dark')
      spy.mockRestore()
    })
  })
})
