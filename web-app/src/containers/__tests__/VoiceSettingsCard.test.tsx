import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  emitEvent: undefined as undefined | ((payload: unknown) => void),
  dispose: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (payload: unknown) => void) => {
    // VoiceStatusBridge 还会注册 voice-overlay-opened，别让它顶掉状态事件。
    if (event === 'voice-tool-event') h.emitEvent = handler
    return Promise.resolve(h.dispose)
  }),
}))

vi.mock('@/lib/platform/utils', () => ({ isPlatformTauri: () => true }))
import VoiceSettingsCard from '@/containers/VoiceSettingsCard'
import { VoiceStatusBridge } from '@/components/VoiceStatusBridge'
import { useVoiceStatusStore } from '@/stores/voice-status-store'

const renderCard = () =>
  render(
    <>
      <VoiceStatusBridge />
      <VoiceSettingsCard />
    </>
  )

const readyStatus = {
  event: 'status',
  wake: true,
  asr: true,
  audio_ready: true,
  kws_loaded: true,
  asr_loaded: true,
  asr_model_type: 'sensevoice',
  mode: 'idle',
}

// 本次改造之后的服务端快照带 desired；旧服务端没有该字段。
const modernStatus = {
  ...readyStatus,
  partial_switches: true,
  queued_model_switch: true,
  desired: { asr_model_type: 'sensevoice', pending: false },
}

describe('VoiceSettingsCard', () => {
  beforeEach(() => {
    h.invoke.mockReset()
    // 默认所有 invoke 都返回一份就绪快照；单个用例再用 Once 覆盖自己关心的那次调用。
    h.invoke.mockResolvedValue(readyStatus)
    h.emitEvent = undefined
    h.dispose.mockClear()
    useVoiceStatusStore.setState({
      status: null,
      offline: false,
      switching: null,
      switchError: null,
      switchIntent: null,
    })
  })

  it('renders service readiness and switch states from get_status', async () => {
    h.invoke.mockResolvedValueOnce(readyStatus)
    renderCard()
    await waitFor(() => {
      expect(h.invoke).toHaveBeenCalledWith('voice_tool_get_status')
    })
    await waitFor(() => {
      expect(screen.getAllByText('Voice service is running; wake word and recognition are ready.')).toHaveLength(1)
    })
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(2)
    expect(switches[0]).toHaveAttribute('aria-checked', 'true')
    expect(switches[1]).toHaveAttribute('aria-checked', 'true')
  })

  it('sends only the clicked switch field with a request id', async () => {
    h.invoke.mockResolvedValueOnce(modernStatus)
    renderCard()
    await waitFor(() => {
      expect(screen.getAllByRole('switch')).toHaveLength(2)
    })
    await act(async () => {
      fireEvent.click(screen.getAllByRole('switch')[0])
    })
    await waitFor(() => {
      expect(h.invoke).toHaveBeenCalledWith('voice_tool_set_switches', {
        wake: false,
        requestId: expect.stringMatching(/^sw-/),
      })
    })
  })

  it("ignores another client's receipt and keeps this window's intent", async () => {
    h.invoke.mockResolvedValueOnce(modernStatus)
    renderCard()
    await waitFor(() => {
      expect(screen.getAllByRole('switch')).toHaveLength(2)
    })

    let releaseSwitch: ((value: unknown) => void) | undefined
    h.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSwitch = resolve
        })
    )
    await act(async () => {
      fireEvent.click(screen.getAllByRole('switch')[0])
    })

    // 别的窗口/CLI 触发的回执：id 不匹配，不能清掉本窗口的在途意图。
    await act(async () => {
      h.emitEvent?.({
        payload: {
          event: 'switches_applied',
          request_id: 'cli-42',
          wake: true,
          asr: true,
        },
      })
    })
    expect(screen.getAllByRole('switch')[0]).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(
      screen.getAllByText('Applying the voice switches…').length
    ).toBeGreaterThan(0)
    releaseSwitch?.(undefined)
  })

  it('falls back to a full payload for a legacy service', async () => {
    // 旧服务端对缺失字段取默认 true，只发一个字段会把另一个开关一起打开。
    h.invoke.mockResolvedValueOnce(readyStatus)
    renderCard()
    await waitFor(() => {
      expect(screen.getAllByRole('switch')).toHaveLength(2)
    })
    await act(async () => {
      fireEvent.click(screen.getAllByRole('switch')[0])
    })
    await waitFor(() => {
      expect(h.invoke).toHaveBeenCalledWith('voice_tool_set_switches', {
        wake: false,
        asr: true,
      })
    })
  })

  it('falls back to a full payload when the capability bit is absent', async () => {
    // 只凭 desired 猜版本是错的：能力位缺失就必须退回全量提交。
    h.invoke.mockResolvedValueOnce({
      ...readyStatus,
      desired: { asr_model_type: 'sensevoice', pending: false },
    })
    renderCard()
    await waitFor(() => {
      expect(screen.getAllByRole('switch')).toHaveLength(2)
    })
    await act(async () => {
      fireEvent.click(screen.getAllByRole('switch')[0])
    })
    await waitFor(() => {
      expect(h.invoke).toHaveBeenCalledWith('voice_tool_set_switches', {
        wake: false,
        asr: true,
      })
    })
  })

  it('shows the clicked switch as applying and converges on the receipt', async () => {
    h.invoke.mockResolvedValueOnce(modernStatus)
    renderCard()
    await waitFor(() => {
      expect(screen.getAllByRole('switch')).toHaveLength(2)
    })

    let releaseSwitch: ((value: unknown) => void) | undefined
    h.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSwitch = resolve
        })
    )
    await act(async () => {
      fireEvent.click(screen.getAllByRole('switch')[0])
    })

    // 乐观显示用户意图，并说明服务端正在应用。
    expect(screen.getAllByRole('switch')[0]).toHaveAttribute(
      'aria-checked',
      'false'
    )
    expect(
      screen.getAllByText('Applying the voice switches…').length
    ).toBeGreaterThan(0)

    // 回执必须带回这次点击的 requestId，界面才会收敛（关联链路是真的）。
    const call = h.invoke.mock.calls.find(
      (entry) => entry[0] === 'voice_tool_set_switches'
    )
    const appliedId = (call?.[1] as { requestId: string }).requestId
    await act(async () => {
      h.emitEvent?.({
        payload: {
          event: 'switches_applied',
          request_id: appliedId,
          wake: false,
          asr: true,
        },
      })
    })
    await waitFor(() => {
      expect(
        screen.getAllByText(
          'Voice service is running; wake word and recognition are ready.'
        )
      ).toHaveLength(1)
    })
    releaseSwitch?.(undefined)
  })

  it('shows the offline description when the service is unreachable', async () => {
    h.invoke.mockRejectedValueOnce(new Error('Voice Tool 未连接'))
    renderCard()
    await waitFor(() => {
      expect(
        screen.getAllByText('Voice service is not connected; voice input is unavailable.')
      ).toHaveLength(1)
    })
    expect(screen.getAllByRole('switch')[0]).toBeDisabled()
  })

  it('keeps the service state when a switch command is unconfirmed', async () => {
    h.invoke.mockResolvedValueOnce(readyStatus)
    renderCard()
    await waitFor(() => {
      expect(screen.getAllByRole('switch')).toHaveLength(2)
    })

    // 命令超时说明服务端可能只是忙，不能因此把界面推进"未连接"。
    h.invoke.mockImplementation((command: string) =>
      command === 'voice_tool_set_switches'
        ? Promise.reject(new Error('语音命令超时'))
        : Promise.resolve(readyStatus)
    )
    await act(async () => {
      fireEvent.click(screen.getAllByRole('switch')[0])
    })

    // 未确认时读一次快照对账，并且不把界面推进离线态。
    await waitFor(() => {
      const probes = h.invoke.mock.calls.filter(
        (call) => call[0] === 'voice_tool_get_status'
      )
      expect(probes.length).toBeGreaterThan(1)
    })
    expect(
      screen.queryAllByText(
        'Voice service is not connected; voice input is unavailable.'
      )
    ).toHaveLength(0)
    expect(screen.getAllByRole('switch')[0]).not.toBeDisabled()
  })

  it('updates from voice-tool-event status broadcasts', async () => {
    h.invoke.mockResolvedValueOnce(readyStatus)
    renderCard()
    await waitFor(() => {
      expect(screen.getAllByRole('switch')).toHaveLength(2)
    })
    await act(async () => {
      h.emitEvent?.({
        payload: { ...readyStatus, wake: false },
      })
    })
    await waitFor(() => {
      expect(screen.getAllByRole('switch')[0]).toHaveAttribute(
        'aria-checked',
        'false'
      )
    })
  })

  it('shows the target engine and keeps the switches usable while switching', async () => {
    h.invoke.mockResolvedValueOnce(readyStatus)
    renderCard()
    await waitFor(() => {
      expect(screen.getAllByRole('switch')).toHaveLength(2)
    })

    await act(async () => {
      h.emitEvent?.({
        payload: {
          ...readyStatus,
          asr_loaded: false,
          switching: {
            kind: 'asr_model',
            from: 'sensevoice',
            to: 'qwen3_asr_0.6b',
            request_id: 'sw-3',
            elapsed_ms: 900,
          },
        },
      })
    })

    // 切换中比「模型加载中」更具体：说目标引擎；下拉按既有规则禁用，开关保持可用，
    // 因为在途改开关是按字段记录意图而不是排队等待。
    expect(
      screen.getAllByText(/Switching to Qwen3-ASR \(large model\)/).length
    ).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Qwen3-ASR/ })).toBeDisabled()
    expect(screen.getAllByRole('switch')[0]).not.toBeDisabled()
  })

  it('surfaces a failed switch with its reason and keeps the effective engine', async () => {
    h.invoke.mockResolvedValueOnce(readyStatus)
    renderCard()
    await waitFor(() => {
      expect(screen.getAllByRole('switch')).toHaveLength(2)
    })

    await act(async () => {
      h.emitEvent?.({ payload: { event: 'error', code: 'ASR_MODEL_FILES_MISSING' } })
    })

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The target engine is missing model files; nothing was switched.'
    )
    expect(screen.getByRole('button', { name: /SenseVoice/ })).toBeEnabled()
  })
})
