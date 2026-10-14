import { act, render, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  isTauri: true,
}))

vi.mock('@/lib/platform/utils', () => ({
  isPlatformTauri: () => h.isTauri,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => h.listen(...args),
}))

import { ThemeProvider } from '../ThemeProvider'
import { useTheme } from '@/hooks/useTheme'

type Broadcast = { mode: string; resolved: string; revision: number }

const captureBroadcast = () => {
  let handler: ((event: { payload: unknown }) => void) | undefined
  h.listen.mockImplementation(
    async (_name: string, cb: (event: { payload: unknown }) => void) => {
      handler = cb
      return h.unlisten
    }
  )
  return (payload: unknown) => handler?.({ payload })
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.isTauri = true
    h.listen.mockResolvedValue(h.unlisten)
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    useTheme.setState({
      activeTheme: 'dark',
      isDark: true,
      revision: 3,
      hydrated: true,
      confirmedMode: 'dark',
    })
  })

  // The theme lives in Rust: it resolves, paints and persists. A window that
  // reports its own idea of the theme is exactly what pulled the app back to
  // light, so mounting must not call the authority at all.
  it('does not push a theme to the authority when it mounts', async () => {
    render(<ThemeProvider />)
    await waitFor(() =>
      expect(h.listen).toHaveBeenCalledWith(
        'app-theme-changed',
        expect.any(Function)
      )
    )
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('paints the mode the authority reports', async () => {
    const broadcast = captureBroadcast()
    useTheme.setState({
      activeTheme: 'light',
      isDark: false,
      hydrated: true,
      confirmedMode: 'light',
    })
    render(<ThemeProvider />)
    await waitFor(() => expect(h.listen).toHaveBeenCalled())
    act(() => {
      broadcast({ mode: 'light', resolved: 'light', revision: 4 })
    })
    expect(useTheme.getState().isDark).toBe(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  // Regression: the quick-chat window used to push its own default `auto`
  // (resolved light) and every window applied it, so a dark app turned light as
  // soon as the popup opened. Rust is now the only broadcaster, so a mode the
  // window did not choose is the authority telling it the user changed modes.
  it('follows the authority when the user changes the mode elsewhere', async () => {
    const broadcast = captureBroadcast()
    render(<ThemeProvider />)
    await waitFor(() => expect(h.listen).toHaveBeenCalled())
    act(() => {
      broadcast({ mode: 'auto', resolved: 'light', revision: 9 })
    })
    expect(useTheme.getState().activeTheme).toBe('auto')
    expect(useTheme.getState().isDark).toBe(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('ignores a broadcast older than what this window already painted', async () => {
    const broadcast = captureBroadcast()
    render(<ThemeProvider />)
    await waitFor(() => expect(h.listen).toHaveBeenCalled())
    act(() => {
      broadcast({ mode: 'dark', resolved: 'light', revision: 2 })
    })
    expect(useTheme.getState().isDark).toBe(true)
  })

  it('ignores malformed payloads instead of blanking the theme', async () => {
    const broadcast = captureBroadcast()
    render(<ThemeProvider />)
    await waitFor(() => expect(h.listen).toHaveBeenCalled())
    act(() => {
      broadcast({})
      broadcast({ mode: 'dark', resolved: 'neon', revision: 42 })
      broadcast(null)
    })
    expect(useTheme.getState().isDark).toBe(true)
  })

  it('keeps the web build free of native calls', () => {
    h.isTauri = false
    render(<ThemeProvider />)
    expect(h.invoke).not.toHaveBeenCalled()
    expect(h.listen).not.toHaveBeenCalled()
  })
})
