import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }))
import { useVoiceSubmission } from '../useVoiceSubmission'
import { type VoiceInput, useVoiceInputStore } from '@/stores/voice-input-store'
const stage = (input: VoiceInput) => useVoiceInputStore.setState({ pending: [input], readyId: input.id })
beforeEach(() => {
  h.invoke.mockResolvedValue({ targetId: 'a', runtimeEpoch: '1' })
  useVoiceInputStore.setState({ mode: 'voice', phase: 'idle', error: '', pending: [] })
})
it('waits for the original session then sends once through the shared sender', async () => {
  const submit = vi.fn().mockResolvedValue(undefined)
  const input = { id: crypto.randomUUID(), sessionId: 's', targetId: 'a', runtimeEpoch: '1', text: '运行任务' }
  stage(input)
  const hook = renderHook(({ ready }) => useVoiceSubmission('s', ready, submit), { initialProps: { ready: false } })
  expect(submit).not.toHaveBeenCalled()
  hook.rerender({ ready: true })
  await waitFor(() => expect(submit).toHaveBeenCalledWith(input.text, input.id))
  await waitFor(() => expect(useVoiceInputStore.getState().pending).toHaveLength(0))
  act(() => stage(input))
  hook.rerender({ ready: true })
  expect(submit).toHaveBeenCalledOnce()
})
it('does not submit to a changed Runtime target', async () => {
  const submit = vi.fn()
  stage({ id: crypto.randomUUID(), sessionId: 's', targetId: 'b', runtimeEpoch: '1', text: '不要串线' })
  renderHook(() => useVoiceSubmission('s', true, submit))
  await waitFor(() => expect(useVoiceInputStore.getState().phase).toBe('error'))
  expect(submit).not.toHaveBeenCalled()
  expect(useVoiceInputStore.getState().error).toContain(
    'The Runtime target changed'
  )
})
it('retains failed text as a visible failure and never retries automatically', async () => {
  const submit = vi.fn().mockRejectedValue(new Error('回执未知'))
  stage({ id: crypto.randomUUID(), sessionId: 's', text: '原始输入' })
  const hook = renderHook(() => useVoiceSubmission('s', true, submit))
  // 识别原文留在结构化失败里（界面照它显示），底层原因只进 error。
  await waitFor(() => expect(useVoiceInputStore.getState().failure).toEqual({ kind: 'send', text: '原始输入' }))
  expect(useVoiceInputStore.getState().error).toContain('回执未知')
  hook.rerender()
  expect(submit).toHaveBeenCalledOnce()
})

it('an old send failure cannot cancel a newly listening voice session', async () => {
  let reject!: (error: Error) => void
  const submit = vi.fn(() => new Promise((_, fail) => { reject = fail }))
  stage({ id: crypto.randomUUID(), sessionId: 's', text: '上一轮' })
  renderHook(() => useVoiceSubmission('s', true, submit))
  await waitFor(() => expect(submit).toHaveBeenCalledOnce())
  act(() => useVoiceInputStore.setState({ mode: 'voice', phase: 'listening' }))
  await act(async () => reject(new Error('旧回执失败')))
  expect(useVoiceInputStore.getState().phase).toBe('listening')
  expect(useVoiceInputStore.getState().mode).toBe('voice')
  expect(useVoiceInputStore.getState().failure).toEqual({ kind: 'send', text: '上一轮' })
})
