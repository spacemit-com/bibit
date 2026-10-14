import React from 'react'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  startDragging: vi.fn().mockResolvedValue(undefined),
  createThread: vi.fn(),
  listeners: {} as Record<string, (event: { payload?: unknown }) => void>,
  listen: vi.fn((event: string, handler: (event: { payload?: unknown }) => void) => {
    h.listeners[event] = handler
    return Promise.resolve(() => {})
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ startDragging: h.startDragging, listen: h.listen }),
}))

import { VoiceBall } from '@/components/VoiceBall'

describe('VoiceBall', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.listeners = {}
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_voice_ball_position') return Promise.resolve([16, 16])
      return Promise.resolve(undefined)
    })
    h.startDragging.mockResolvedValue(undefined)
  })

  const renderBall = async () => {
    const user = userEvent.setup()
    render(<VoiceBall />)
    const button = screen.getByRole('button', { name: 'Click the ball to open the voice overlay, double-click to open the app' })
    await act(async () => { await Promise.resolve() })
    return { user, button, ball: button.firstElementChild as HTMLElement }
  }

  const dragUpLeft = (user: ReturnType<typeof userEvent.setup>, button: HTMLElement) =>
    user.pointer([
      { keys: '[MouseLeft>]', target: button, coords: { x: 20, y: 20 } },
      { target: button, coords: { x: -20, y: -5 } },
    ])

  it('opens the input popup on click even when voice service is unavailable', async () => {
    const user = userEvent.setup()
    render(<VoiceBall />)
    const button = screen.getByRole('button', { name: 'Click the ball to open the voice overlay, double-click to open the app' })
    await user.click(button)

    // 单击要让位给双击判定，所以弹窗在等待窗口之后才出现。
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('show_voice_overlay'))
    expect(h.createThread).not.toHaveBeenCalled()
    expect(h.invoke).not.toHaveBeenCalledWith('voice_tool_start_manual_asr')
  })

  it('opens the main window on double click instead of the voice popup', async () => {
    const user = userEvent.setup()
    render(<VoiceBall />)
    const button = screen.getByRole('button', { name: 'Click the ball to open the voice overlay, double-click to open the app' })
    await user.dblClick(button)

    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('open_main_window'))
    expect(h.invoke).not.toHaveBeenCalledWith('show_voice_overlay')
  })

  it('uses its embedded action without opening a window', async () => {
    const activate = vi.fn()
    render(<VoiceBall embedded label="开始语音输入" onActivate={activate} />)
    const button = screen.getByRole('button', { name: '开始语音输入' })
    expect(button).not.toHaveClass('h-screen', 'w-screen')
    // 内嵌时触发器就是可见控件，环留在触发器上（球的环会被触发器的圆角裁剪吃掉）。
    expect(button).toHaveClass('focus-visible:ring-2')
    await userEvent.setup().click(button)
    expect(activate).toHaveBeenCalledOnce()
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('keeps the focus ring on the ball instead of the invisible surface trigger', () => {
    render(<VoiceBall />)
    const button = screen.getByRole('button', { name: 'Click the ball to open the voice overlay, double-click to open the app' })
    // 独立球窗的触发器是铺满 surface 的不可见盒子（surface 原点在屏幕左上角），
    // 尺寸和焦点环都必须留在球本体上，否则焦点态会在左上角画出一个空心绿圈。
    expect(button).not.toHaveClass('h-screen', 'w-screen')
    expect(button).not.toHaveClass('focus-visible:ring-2')
    expect(button.firstElementChild).toHaveClass('rounded-full', 'group-focus-visible:ring-2')
  })

  it('fills its slot when embedded instead of overflowing as a 96px ball', () => {
    render(<VoiceBall embedded label="开始语音输入" />)
    const ball = screen.getByRole('button', { name: '开始语音输入' })
      .firstElementChild as HTMLElement
    // 写死 96px 会盖住输入框和发送按钮；内嵌时尺寸由外面的槽位决定。
    expect(ball.style.width).toBe('100%')
    expect(ball.style.height).toBe('100%')
    expect(ball.style.position).not.toBe('absolute')
  })

  it('keeps click handling sessionless', async () => {
    render(<VoiceBall />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Click the ball to open the voice overlay, double-click to open the app' }))

    // 挂载时读一次位置，点击只多一次打开弹窗——中间不能出现任何语音会话命令。
    await waitFor(() =>
      expect(h.invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
        'get_voice_ball_position',
        'show_voice_overlay',
      ])
    )
    expect(h.invoke).toHaveBeenLastCalledWith('show_voice_overlay')
  })

  it('清空画面后才回执隐藏，并在再次显示前应用拖动后的新位置', async () => {
    const { ball } = await renderBall()
    act(() => h.listeners['voice-ball-hidden']?.({}))
    expect(ball.style.display).toBe('none')
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('voice_ball_blanked'))
    act(() => h.listeners['voice-ball:set-margins']?.({ payload: { rightMargin: 240, bottomMargin: 300 } }))
    expect(ball.style.display).toBe('none')
    act(() => h.listeners['voice-ball-shown']?.({ payload: { rightMargin: 240, bottomMargin: 300 } }))
    expect(ball.style.right).toBe('240px')
    expect(ball.style.bottom).toBe('300px')
    expect(ball.style.display).not.toBe('none')
  })

  it('drags the ball locally and persists the new margins on release', async () => {
    const { user, button, ball } = await renderBall()
    await dragUpLeft(user, button)
    // 拖动过程只更新本地 transform，零 IPC 往返。
    expect(ball.style.transform).toBe('translate(-40px, -25px)')
    expect(h.invoke).not.toHaveBeenCalledWith('update_voice_ball_position', expect.anything())

    await user.pointer([{ keys: '[/MouseLeft]', target: button }])
    // 向左上拖 → margin 变大：16+40 / 16+25，落盘一次并就地落位（transform 归零）。
    expect(h.invoke).toHaveBeenCalledWith('update_voice_ball_position', {
      rightMargin: 56,
      bottomMargin: 41,
    })
    expect(ball.style.transform).toBe('translate(0px, 0px)')
    expect(h.invoke).not.toHaveBeenCalledWith('show_voice_overlay')
    expect(h.startDragging).not.toHaveBeenCalled()
  })

  it('persists the drag position when the drag ends with pointercancel', async () => {
    // SpacemiT K3 实测：WebKit 松手时投递的是 pointercancel。这条路径若丢弃位移，
    // 球会弹回原处且位置永远不落盘——正是本次要修的回归。
    const { user, button, ball } = await renderBall()
    await dragUpLeft(user, button)
    await act(async () => {
      fireEvent.pointerCancel(button, { pointerId: 1, button: 0 })
    })
    expect(h.invoke).toHaveBeenCalledWith('update_voice_ball_position', {
      rightMargin: 56,
      bottomMargin: 41,
    })
    expect(ball.style.transform).toBe('translate(0px, 0px)')
  })

  it('follows the margin the backend pushes after the overlay was dragged', async () => {
    // 浮窗拖走后球要跟着挪：球窗口常驻，前端只在挂载时读一次位置，
    // 后端改了 margin 必须推过来，否则球重现时还停在拖走前的地方。
    const { ball } = await renderBall()
    expect(ball.style.right).toBe('16px')
    await act(async () => {
      h.listeners['voice-ball:set-margins']?.({ payload: { rightMargin: 300, bottomMargin: 120 } })
    })
    expect(ball.style.right).toBe('300px')
    expect(ball.style.bottom).toBe('120px')
  })

  it('renders default state with eyes and hidden thinking ring', () => {
    render(<VoiceBall />)
    const button = screen.getByRole('button', { name: 'Click the ball to open the voice overlay, double-click to open the app' })
    expect(button).toHaveAttribute('data-thinking', 'false')

    const ring = screen.getByTestId('voice-ball-ring')
    expect(ring).not.toHaveClass('is-thinking')

    const eyes = screen.getByTestId('voice-ball-eyes')
    expect(eyes).toBeInTheDocument()
  })

  it('shows thinking ring when isThinking is true or toggled via event', () => {
    const { rerender } = render(<VoiceBall isThinking={true} />)
    const button = screen.getByRole('button', { name: 'Click the ball to open the voice overlay, double-click to open the app' })
    expect(button).toHaveAttribute('data-thinking', 'true')

    const ring = screen.getByTestId('voice-ball-ring')
    expect(ring).toHaveClass('is-thinking')

    rerender(<VoiceBall isThinking={false} />)
    expect(ring).not.toHaveClass('is-thinking')

    // Test custom event toggle
    act(() => {
      window.dispatchEvent(
        new CustomEvent('voice-ball-thinking', { detail: { thinking: true } })
      )
    })
    expect(ring).toHaveClass('is-thinking')
  })

  it('shows waves and hides eyes when isListening is true or toggled via event', () => {
    const { rerender } = render(<VoiceBall isListening={true} />)
    const button = screen.getByRole('button', { name: 'Click the ball to open the voice overlay, double-click to open the app' })
    expect(button).toHaveAttribute('data-listening', 'true')

    expect(screen.queryByTestId('voice-ball-eyes')).not.toBeInTheDocument()
    expect(screen.getByTestId('voice-ball-waves')).toBeInTheDocument()

    rerender(<VoiceBall isListening={false} />)
    expect(button).toHaveAttribute('data-listening', 'false')
    expect(screen.getByTestId('voice-ball-eyes')).toBeInTheDocument()
    expect(screen.queryByTestId('voice-ball-waves')).not.toBeInTheDocument()

    // Test custom event toggle
    act(() => {
      window.dispatchEvent(
        new CustomEvent('voice-ball-listening', { detail: { listening: true } })
      )
    })
    expect(screen.queryByTestId('voice-ball-eyes')).not.toBeInTheDocument()
    expect(screen.getByTestId('voice-ball-waves')).toBeInTheDocument()
  })

  it('supports unified mode prop and external levels data', () => {
    const { rerender } = render(<VoiceBall mode="listening" levels={[3, 5, 2, 4]} />)
    const button = screen.getByRole('button', { name: 'Click the ball to open the voice overlay, double-click to open the app' })
    expect(button).toHaveAttribute('data-mode', 'listening')
    expect(button).toHaveAttribute('data-listening', 'true')
    expect(screen.getByTestId('voice-ball-waves')).toBeInTheDocument()

    rerender(<VoiceBall mode="thinking" />)
    expect(button).toHaveAttribute('data-mode', 'thinking')
    expect(button).toHaveAttribute('data-thinking', 'true')
    expect(screen.getByTestId('voice-ball-ring')).toHaveClass('is-thinking')

    rerender(<VoiceBall mode="idle" />)
    expect(button).toHaveAttribute('data-mode', 'idle')
    expect(screen.getByTestId('voice-ball-eyes')).toBeInTheDocument()
  })

  // 悬浮球在整屏透明 surface 上出帧很贵（SpacemiT K3 实测约 16ms/帧），所以动效必须
  // 是低频离散步进，离开该状态就完全停下来。
  it('steps the thinking ring in discrete frames and stops when idle', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = render(<VoiceBall mode="thinking" />)
      const ring = screen.getByTestId('voice-ball-ring')

      expect(ring.style.transform).toBe('rotate(0deg)')

      act(() => {
        vi.advanceTimersByTime(250)
      })
      expect(ring.style.transform).toBe('rotate(45deg)')

      rerender(<VoiceBall mode="idle" />)
      const frozen = screen.getByTestId('voice-ball-ring').style.transform
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(screen.getByTestId('voice-ball-ring').style.transform).toBe(frozen)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the idle eyes still between beats', () => {
    vi.useFakeTimers()
    try {
      render(<VoiceBall mode="idle" />)
      const eyesClass = () => screen.getByTestId('voice-ball-eyes').getAttribute('class') ?? ''

      expect(eyesClass()).not.toContain('is-look-')

      // 一拍之内视线不动（眨眼由重新挂载点阵层触发，不改变类名）
      act(() => {
        vi.advanceTimersByTime(12_000)
      })
      expect(eyesClass()).not.toContain('is-look-')

      // 每 3 拍挪一次视线
      act(() => {
        vi.advanceTimersByTime(24_000)
      })
      expect(eyesClass()).toContain('is-look-top-left')
    } finally {
      vi.useRealTimers()
    }
  })
})
