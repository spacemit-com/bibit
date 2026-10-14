import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  isMaximized: vi.fn().mockResolvedValue(false),
  isVisible: vi.fn().mockResolvedValue(false),
  onResized: vi.fn().mockResolvedValue(vi.fn()),
  invoke: vi.fn().mockResolvedValue([0, 0]),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    isMaximized: h.isMaximized,
    isVisible: h.isVisible,
    onResized: h.onResized,
    listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
      h.listeners.set(name, callback)
      return () => h.listeners.delete(name)
    }),
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))

import { WindowSurfaceShell } from '@/components/WindowSurfaceShell'
import { startVoiceOverlayDrag } from '@/components/WindowResizeGrips'
import { useVoiceInputStore } from '@/stores/voice-input-store'

describe('WindowSurfaceShell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as any).IS_TAURI = true
    ;(globalThis as any).IS_LINUX = false
    h.isMaximized.mockResolvedValue(false)
    h.isVisible.mockResolvedValue(false)
    h.invoke.mockResolvedValue([0, 0])
    h.listeners.clear()
  })

  const openOverlay = () => act(() => h.listeners.get('voice-overlay-shown')?.({ payload: {} }))
  const blankOverlay = () => act(() => h.listeners.get('voice-overlay-hidden')?.({ payload: {} }))

  // BIT-FLOAT-03：玻璃材质挂在 shell 的 data-glass 上，CSS 靠它选择。
  it('语音态给浮窗标 data-glass，切到键盘态后撤销', () => {
    ;(globalThis as any).IS_LINUX = true
    useVoiceInputStore.setState({ mode: 'voice' })
    const { rerender } = render(
      <WindowSurfaceShell mode="voice-overlay" testId="glass-shell">
        <div>内容</div>
      </WindowSurfaceShell>
    )
    expect(screen.getByTestId('glass-shell')).toHaveAttribute('data-glass', 'voice')

    act(() => useVoiceInputStore.setState({ mode: 'keyboard' }))
    rerender(
      <WindowSurfaceShell mode="voice-overlay" testId="glass-shell">
        <div>内容</div>
      </WindowSurfaceShell>
    )
    expect(screen.getByTestId('glass-shell')).not.toHaveAttribute('data-glass')
  })

  it('主窗口不套浮窗玻璃材质', () => {
    useVoiceInputStore.setState({ mode: 'voice' })
    render(
      <WindowSurfaceShell mode="main" testId="main-glass-shell">
        <div>内容</div>
      </WindowSurfaceShell>
    )
    expect(screen.getByTestId('main-glass-shell')).not.toHaveAttribute('data-glass')
  })

  it('renders main window with rounded corners and border when floating', async () => {
    render(
      <WindowSurfaceShell mode="main" testId="test-main-shell">
        <div>Main content</div>
      </WindowSurfaceShell>
    )

    const shell = screen.getByTestId('test-main-shell')
    await waitFor(() => {
      expect(shell).toHaveClass('rounded-2xl')
      expect(shell).toHaveClass('border')
    })
    expect(screen.getByText('Main content')).toBeInTheDocument()
  })

  it('renders compact status-popup with rounded corners and border', () => {
    render(
      <WindowSurfaceShell mode="compact" testId="test-compact-shell">
        <div>Quick chat content</div>
      </WindowSurfaceShell>
    )

    const shell = screen.getByTestId('test-compact-shell')
    expect(shell).toHaveClass('rounded-2xl')
    expect(shell).toHaveClass('border')
    expect(screen.getByText('Quick chat content')).toBeInTheDocument()
  })

  it('removes rounded corners when main window is maximized', async () => {
    h.isMaximized.mockResolvedValue(true)

    render(
      <WindowSurfaceShell mode="main" testId="test-maximized-shell">
        <div>Maximized content</div>
      </WindowSurfaceShell>
    )

    const shell = screen.getByTestId('test-maximized-shell')
    await waitFor(() => {
      expect(shell).toHaveClass('rounded-none')
      expect(shell).toHaveClass('border-0')
      expect(shell).not.toHaveClass('rounded-2xl')
    })
  })

  /**
   * 窗口 unmapped 后 webview 不再渲染，所以落点只能在显示时取、隐藏时必须先把框收起来：
   * 否则下次 map 会先亮出上一帧的旧位置（SpacemiT K3 实测错位约 190ms）。
   */
  it('takes the voice overlay origin on open and blanks it on hide', async () => {
    ;(globalThis as any).IS_LINUX = true
    h.invoke.mockResolvedValue([1256, 7])

    render(
      <WindowSurfaceShell mode="voice-overlay" testId="test-overlay-shell">
        <div>Voice content</div>
      </WindowSurfaceShell>
    )

    const shell = screen.getByTestId('test-overlay-shell')
    // 挂载时不取落点：那时取到的值在下次显示前就过期了，框先不显示。
    expect(shell.style.display).toBe('none')
    expect(h.invoke).not.toHaveBeenCalledWith('get_voice_overlay_position')

    openOverlay()
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('get_voice_overlay_position'))
    await waitFor(() => expect(shell.style.left).toBe('1256px'))
    expect(shell.style.top).toBe('7px')
    expect(shell.style.width).toBe('460px')
    expect(shell.style.height).toBe('620px')
    // 可见时不写 display，交给类上的 flex（写死 block 会顶掉它）。
    expect(shell.style.display).toBe('')

    blankOverlay()
    await waitFor(() => expect(shell.style.display).toBe('none'))
    // 收框那一帧提交之后才回执，后端据此才 unmapped 窗口。
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('voice_overlay_blanked'))
  })

  it('follows the voice overlay move event from a drag', async () => {
    ;(globalThis as any).IS_LINUX = true
    h.invoke.mockResolvedValue([1256, 7])

    render(
      <WindowSurfaceShell mode="voice-overlay" testId="test-overlay-shell">
        <div>Voice content</div>
      </WindowSurfaceShell>
    )

    const shell = screen.getByTestId('test-overlay-shell')
    openOverlay()
    await waitFor(() => expect(shell.style.left).toBe('1256px'))

    act(() => {
      window.dispatchEvent(
        new CustomEvent('voice-overlay-moved', { detail: { x: 40, y: 60 } })
      )
    })
    await waitFor(() => expect(shell.style.left).toBe('40px'))
    expect(shell.style.top).toBe('60px')
  })

  it('挂载前已经显示的浮窗读取当前位置', async () => {
    ;(globalThis as any).IS_LINUX = true
    h.isVisible.mockResolvedValue(true)
    h.invoke.mockResolvedValue([300, 400])
    render(<WindowSurfaceShell mode="voice-overlay" testId="overlay"><div>内容</div></WindowSurfaceShell>)
    await waitFor(() => expect(screen.getByTestId('overlay').style.left).toBe('300px'))
    expect(screen.getByTestId('overlay').style.display).toBe('')
  })

  it('隐藏后忽略迟到的初始可见性响应', async () => {
    ;(globalThis as any).IS_LINUX = true
    let resolveVisible!: (value: boolean) => void
    h.isVisible.mockImplementation(() => new Promise<boolean>(resolve => { resolveVisible = resolve }))
    render(<WindowSurfaceShell mode="voice-overlay" testId="overlay"><div>内容</div></WindowSurfaceShell>)
    await waitFor(() => expect(h.isVisible).toHaveBeenCalled())
    blankOverlay()
    await act(async () => resolveVisible(true))
    expect(screen.getByTestId('overlay').style.display).toBe('none')
    expect(h.invoke).not.toHaveBeenCalledWith('get_voice_overlay_position')
  })

  it('隐藏后忽略迟到的位置响应，下一次显示再读取位置', async () => {
    ;(globalThis as any).IS_LINUX = true
    let resolvePosition!: (value: [number, number]) => void
    h.invoke.mockImplementation((command: string) => command === 'get_voice_overlay_position'
      ? new Promise<[number, number]>(resolve => { resolvePosition = resolve })
      : Promise.resolve())
    render(<WindowSurfaceShell mode="voice-overlay" testId="overlay"><div>内容</div></WindowSurfaceShell>)
    openOverlay()
    blankOverlay()
    await act(async () => resolvePosition([100, 200]))
    expect(screen.getByTestId('overlay').style.display).toBe('none')
    h.invoke.mockResolvedValue([300, 400])
    openOverlay()
    await waitFor(() => expect(screen.getByTestId('overlay').style.left).toBe('300px'))
  })

  it('commits the voice overlay drag as a relative offset', async () => {
    ;(globalThis as any).IS_LINUX = true
    h.invoke.mockResolvedValue([1256, 7])

    render(
      <WindowSurfaceShell mode="voice-overlay" testId="test-overlay-shell">
        <div>Voice content</div>
      </WindowSurfaceShell>
    )

    const shell = screen.getByTestId('test-overlay-shell')
    openOverlay()
    await waitFor(() => expect(shell.style.left).toBe('1256px'))
    h.invoke.mockResolvedValue([1316, 37])

    startVoiceOverlayDrag({
      button: 0,
      // 缩放下 clientX 是分数像素：命令只收整数，必须取整后再发（SpacemiT K3 实测：
      // 直接发分数会被 Tauri 判成 invalid type，拖完弹回原位）。
      clientX: 100.4,
      clientY: 100.2,
      target: screen.getByText('Voice content'),
      preventDefault: () => {},
    } as unknown as React.PointerEvent<HTMLElement>)
    // jsdom 没有 PointerEvent：用同名的 MouseEvent 顶上，坐标字段一样。
    fireEvent(window, new MouseEvent('pointermove', { clientX: 160.8, clientY: 130.6 }))
    fireEvent(window, new MouseEvent('pointerup', { clientX: 160.8, clientY: 130.6 }))

    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith('update_voice_overlay_offset', {
        deltaX: 60,
        deltaY: 30,
      })
    )
    // 后端夹完之后回填，前端按它收尾。
    await waitFor(() => expect(shell.style.left).toBe('1316px'))
    expect(shell.style.top).toBe('37px')
  })

  it('stops the drag preview at the usable area instead of jumping back on release', async () => {
    ;(globalThis as any).IS_LINUX = true
    h.invoke.mockResolvedValue([1256, 7])

    render(
      <WindowSurfaceShell mode="voice-overlay" testId="test-overlay-shell">
        <div>Voice content</div>
      </WindowSurfaceShell>
    )

    const shell = screen.getByTestId('test-overlay-shell')
    openOverlay()
    await waitFor(() => expect(shell.style.left).toBe('1256px'))

    startVoiceOverlayDrag({
      button: 0,
      clientX: 100,
      clientY: 100,
      target: screen.getByText('Voice content'),
      preventDefault: () => {},
    } as unknown as React.PointerEvent<HTMLElement>)
    // 一路拖到屏幕外：预览要停在可用区边界，发出去的位移也是边界那一段，
    // 不能发原始位移——后端会夹回来，松手就跳。
    fireEvent(window, new MouseEvent('pointermove', { clientX: 900, clientY: 700 }))
    fireEvent(window, new MouseEvent('pointerup', { clientX: 900, clientY: 700 }))

    const limitX = window.innerWidth - 460
    const limitY = window.innerHeight - 620
    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith('update_voice_overlay_offset', {
        deltaX: limitX,
        deltaY: limitY,
      })
    )
  })
})
