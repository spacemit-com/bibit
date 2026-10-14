import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }))
vi.mock('@/components/VoiceBall', () => ({ VoiceBall: ({ onActivate, label, mode }: { onActivate: () => void; label: string; mode: string }) => <button onClick={onActivate} data-mode={mode}>{label}</button> }))
import { VoiceComposer } from '../VoiceComposer'
import { useVoiceInputStore } from '@/stores/voice-input-store'
import { useVoiceStatusStore } from '@/stores/voice-status-store'
beforeEach(() => {
  h.invoke.mockClear()
  useVoiceInputStore.setState({ mode: 'voice', phase: 'idle', error: '', failure: null, pending: [] })
  useVoiceStatusStore.setState({ status: null, offline: false })
})
it('switches input layout without unmounting the draft or opening another window', async () => {
  render(<VoiceComposer><input aria-label="草稿" defaultValue="保留文字" /></VoiceComposer>)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Switch to keyboard input' })))
  expect(screen.getByRole('textbox', { name: '草稿' })).toHaveValue('保留文字')
  expect(h.invoke).toHaveBeenCalledWith('voice_tool_cancel_current')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start voice input' })))
  expect(h.invoke).toHaveBeenCalledWith('voice_tool_start_manual_asr')
  expect(screen.getByLabelText('草稿')).toHaveValue('保留文字')
  expect(h.invoke).not.toHaveBeenCalledWith('open_main_window')
})
it('prioritizes listening over execution and exposes stop', () => {
  useVoiceInputStore.setState({ phase: 'listening' })
  const stop = vi.fn()
  render(<VoiceComposer busy onStop={stop}><input /></VoiceComposer>)
  expect(screen.getByRole('button', { name: 'Stop recording' })).toHaveAttribute('data-mode', 'listening')
  fireEvent.click(screen.getByRole('button', { name: 'Stop running' }))
  expect(stop).toHaveBeenCalledOnce()
})

it('把服务端错误码显示成一句话，并保留球旁边的键盘出口', () => {
  useVoiceInputStore.setState({ phase: 'error', error: 'NO_SPEECH' })
  render(<VoiceComposer><input /></VoiceComposer>)
  // 没听清是中性提示，不该用错误色报警。
  const bubble = screen.getByRole('status')
  expect(bubble).toHaveTextContent("I didn't catch that")
  expect(bubble).toHaveAttribute('data-tone', 'neutral')
  expect(screen.queryByText('NO_SPEECH')).not.toBeInTheDocument()
  // 状态行让位给失败提示，球的位置不变。
  expect(screen.getByRole('button', { name: 'Switch to keyboard input' })).toBeInTheDocument()
})

it('识别到了但没发出去时保留原文并给重录动作，原始原因不上屏', () => {
  useVoiceInputStore.setState({
    mode: 'keyboard',
    phase: 'error',
    error: 'TypeError: Failed to fetch',
    failure: { kind: 'send', text: '帮我看看今天的日程' },
  })
  render(<VoiceComposer><input aria-label="草稿" /></VoiceComposer>)
  const alert = screen.getByRole('alert')
  expect(alert).toHaveTextContent('帮我看看今天的日程')
  expect(alert).not.toHaveTextContent('Failed to fetch')
  fireEvent.click(screen.getByRole('button', { name: 'Record again' }))
  expect(h.invoke).toHaveBeenCalledWith('voice_tool_start_manual_asr')
})

it('语音服务未连接时不显示底层 errno', () => {
  useVoiceStatusStore.setState({ status: null, offline: true })
  useVoiceInputStore.setState({ phase: 'error', error: 'Voice Tool 未连接: 没有那个文件或目录 (os error 2)' })
  render(<VoiceComposer><input /></VoiceComposer>)
  const alert = screen.getByRole('alert')
  expect(alert).toHaveTextContent('Voice service is not connected; voice input is unavailable.')
  expect(alert).not.toHaveTextContent('os error')
})

it('重新开始录音就收起上一次的失败提示', async () => {
  useVoiceInputStore.setState({ phase: 'error', error: 'NO_SPEECH' })
  render(<VoiceComposer><input /></VoiceComposer>)
  expect(screen.getByRole('status')).toHaveTextContent("I didn't catch that")
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start voice input' })))
  expect(screen.queryByText(/I didn't catch that/)).not.toBeInTheDocument()
  expect(h.invoke).toHaveBeenCalledWith('voice_tool_start_manual_asr')
})
