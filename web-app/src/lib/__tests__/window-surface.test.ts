import { describe, expect, it } from 'vitest'
import {
  resolveWindowSurface,
  shouldStopRuntimeOnPageHide,
} from '@/lib/window-surface'

describe('window surface', () => {
  it('recognizes independent window labels', () => {
    expect(resolveWindowSurface('status-popup')).toBe('status-popup')
    expect(resolveWindowSurface('voice-ball')).toBe('voice-ball')
    expect(resolveWindowSurface('voice-overlay')).toBe('voice-overlay')
    expect(resolveWindowSurface('main')).toBe('main')
    expect(resolveWindowSurface('logs-app-window')).toBe('main')
  })

  it('keeps detached Bianbu runs alive when the main WebView unloads', () => {
    expect(shouldStopRuntimeOnPageHide('main', true)).toBe(false)
    expect(shouldStopRuntimeOnPageHide('main', false)).toBe(true)
    expect(shouldStopRuntimeOnPageHide('status-popup', false)).toBe(false)
  })
})
