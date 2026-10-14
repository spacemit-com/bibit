import { act, render, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  emitEvent: undefined as undefined | ((payload: unknown) => void),
  emitOpened: undefined as undefined | ((payload: unknown) => void),
  dispose: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (payload: unknown) => void) => {
    if (event === 'voice-tool-event') h.emitEvent = handler
    if (event === 'voice-overlay-opened') h.emitOpened = handler
    return Promise.resolve(h.dispose)
  }),
}))

vi.mock('@/lib/platform/utils', () => ({ isPlatformTauri: () => true }))

import { VoiceStatusBridge } from '@/components/VoiceStatusBridge'
import {
  SWITCH_INTENT_TIMEOUT_MS,
  SWITCH_TIMEOUT_MS,
  useVoiceStatusStore,
} from '@/stores/voice-status-store'

const readyStatus = {
  event: 'status',
  wake: true,
  asr: true,
  audio_ready: true,
  kws_loaded: true,
  asr_loaded: true,
  asr_model_type: 'qwen3_asr_0.6b',
  mode: 'idle',
}

describe('VoiceStatusBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.emitEvent = undefined
    h.emitOpened = undefined
    useVoiceStatusStore.setState({ status: null, offline: false })
  })

  it('probes the voice service on mount and records readiness', async () => {
    h.invoke.mockResolvedValueOnce(readyStatus)

    render(<VoiceStatusBridge />)

    await waitFor(() => expect(useVoiceStatusStore.getState().status).toEqual(readyStatus))
    expect(h.invoke).toHaveBeenCalledWith('voice_tool_get_status')
    expect(useVoiceStatusStore.getState().offline).toBe(false)
  })

  it('records the service as offline when the probe fails', async () => {
    h.invoke.mockRejectedValueOnce(
      new Error('Voice Tool 未连接: 没有那个文件或目录 (os error 2)')
    )

    render(<VoiceStatusBridge />)

    await waitFor(() => expect(useVoiceStatusStore.getState().offline).toBe(true))
    expect(useVoiceStatusStore.getState().status).toBeNull()
  })

  it('updates the shared state from status broadcasts', async () => {
    h.invoke.mockRejectedValueOnce(new Error('offline'))
    render(<VoiceStatusBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())

    await act(async () => h.emitEvent?.({ payload: { ...readyStatus, wake: false } }))

    await waitFor(() => expect(useVoiceStatusStore.getState().status?.wake).toBe(false))
    expect(useVoiceStatusStore.getState().offline).toBe(false)
  })

  it('re-probes whenever the overlay is opened again', async () => {
    h.invoke.mockResolvedValueOnce(readyStatus)
    render(<VoiceStatusBridge />)
    await waitFor(() => expect(useVoiceStatusStore.getState().status).not.toBeNull())
    // 服务随后挂掉：常驻窗口不会再收到状态推送，只能靠重新探测纠正。
    useVoiceStatusStore.setState({ status: null, offline: true })
    h.invoke.mockResolvedValueOnce(readyStatus)

    await act(async () => h.emitOpened?.({ payload: { mode: 'voice' } }))

    await waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(useVoiceStatusStore.getState().offline).toBe(false))
    expect(useVoiceStatusStore.getState().status).toEqual(readyStatus)
  })

  it('reduces the switching event chain into the shared state', async () => {
    h.invoke.mockRejectedValueOnce(new Error('offline'))
    render(<VoiceStatusBridge />)
    await waitFor(() => expect(h.emitEvent).toBeDefined())

    await act(async () =>
      h.emitEvent?.({
        payload: {
          event: 'status',
          ...readyStatus,
          switching: {
            kind: 'asr_model',
            from: 'qwen3_asr_0.6b',
            to: 'sensevoice',
            request_id: 'sw-7',
            elapsed_ms: 400,
          },
        },
      })
    )
    // 切换中途打开设置页也能直接进入「切换中」，生效引擎仍是旧的。
    expect(useVoiceStatusStore.getState().switching?.target).toBe('sensevoice')
    expect(useVoiceStatusStore.getState().status?.asr_model_type).toBe('qwen3_asr_0.6b')

    await act(async () =>
      h.emitEvent?.({
        payload: { event: 'model_switched', from: 'qwen3_asr_0.6b', to: 'sensevoice', duration_ms: 6900 },
      })
    )
    expect(useVoiceStatusStore.getState().switching).toBeNull()
    expect(useVoiceStatusStore.getState().status?.asr_model_type).toBe('sensevoice')
  })

  it('stops waiting and reconciles once when a switch is never confirmed', async () => {
    vi.useFakeTimers()
    try {
      h.invoke.mockRejectedValueOnce(new Error('offline'))
      render(<VoiceStatusBridge />)
      await act(async () => {})

      await act(async () => {
        useVoiceStatusStore.setState({
          switching: { kind: 'asr_model', target: 'sensevoice', startedAt: Date.now() },
        })
      })
      h.invoke.mockResolvedValueOnce(readyStatus)
      await act(async () => {
        vi.advanceTimersByTime(SWITCH_TIMEOUT_MS + 1)
        await Promise.resolve()
      })

      const state = useVoiceStatusStore.getState()
      expect(state.switching).toBeNull()
      expect(state.switchError?.code).toBe('SWITCH_UNCONFIRMED')
      // 超时后只对账读一次，不做轮询。
      expect(h.invoke).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears a switch intent the service never confirms', async () => {
    vi.useFakeTimers()
    try {
      h.invoke.mockResolvedValue(readyStatus)
      render(<VoiceStatusBridge />)
      await act(async () => {
        await Promise.resolve()
      })
      act(() => {
        useVoiceStatusStore.setState({
          switchIntent: { asr: { value: false, requestId: 'sw-1' }, startedAt: Date.now() },
        })
      })
      await act(async () => {
        vi.advanceTimersByTime(SWITCH_INTENT_TIMEOUT_MS + 1)
      })
      // 服务端丢弃命令或回 BAD_COMMAND 时，界面不能永远停在「正在应用」。
      expect(useVoiceStatusStore.getState().switchIntent).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not keep reconciling when the snapshot still reports that switch', async () => {
    vi.useFakeTimers()
    try {
      h.invoke.mockRejectedValueOnce(new Error('offline'))
      render(<VoiceStatusBridge />)
      await act(async () => {})

      await act(async () => {
        useVoiceStatusStore.setState({
          switching: {
            kind: 'asr_model',
            target: 'sensevoice',
            requestId: 'sw-2',
            startedAt: Date.now(),
          },
        })
      })
      // 对账读回来的快照仍说这次切换在进行；此时剩余窗口按 elapsed_ms 已经是 0。
      h.invoke.mockResolvedValue({
        ...readyStatus,
        switching: {
          kind: 'asr_model',
          from: 'qwen3_asr_0.6b',
          to: 'sensevoice',
          request_id: 'sw-2',
          elapsed_ms: SWITCH_TIMEOUT_MS + 500,
        },
      })
      await act(async () => {
        vi.advanceTimersByTime(SWITCH_TIMEOUT_MS + 1)
        await Promise.resolve()
      })
      const callsAfterFirst = h.invoke.mock.calls.length

      await act(async () => {
        vi.advanceTimersByTime(SWITCH_TIMEOUT_MS + 1)
        await Promise.resolve()
      })

      expect(h.invoke.mock.calls.length).toBe(callsAfterFirst)
      expect(useVoiceStatusStore.getState().switching).toBeNull()
      expect(useVoiceStatusStore.getState().switchError?.code).toBe('SWITCH_UNCONFIRMED')
    } finally {
      vi.useRealTimers()
    }
  })
})
