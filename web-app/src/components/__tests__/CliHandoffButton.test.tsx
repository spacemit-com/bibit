import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => h.invoke(...args) }))
vi.mock('sonner', () => ({ toast: { error: h.toast } }))
vi.mock('@/lib/window-surface', () => ({ currentWindowSurface: () => 'main' }))

import { CliHandoffButton } from '@/components/CliHandoffButton'
import { usePrompt } from '@/hooks/usePrompt'
import { useThreads } from '@/hooks/useThreads'
import { useRuntimeStore } from '@/stores/runtime-store'

beforeEach(() => {
  vi.clearAllMocks()
  h.invoke.mockResolvedValue(undefined)
  useThreads.setState({ currentThreadId: 'session-a', currentThreadTargetId: 'target-a' })
  usePrompt.setState({ prompt: '未发送草稿' })
  useRuntimeStore.setState({
    runtimeEpoch: 'epoch-a',
    capabilities: {
      durableSessions: true,
      detachedRuns: true,
      replayableEvents: true,
      runtimeOwnedApprovals: true,
      sessionEvents: true,
    },
  })
})

it('persists the target-bound draft before launching the CLI handoff', async () => {
  render(<CliHandoffButton />)
  fireEvent.click(screen.getByRole('button', { name: 'Continue in CLI' }))

  await waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(2))
  expect(h.invoke.mock.calls).toEqual([
    ['conversation_update_draft', {
      originWindow: 'main',
      sessionId: 'session-a',
      draft: '未发送草稿',
      expectedTargetId: 'target-a',
    }],
    ['runtime_cli_handoff', {
      sessionId: 'session-a',
      targetId: 'target-a',
      runtimeEpoch: 'epoch-a',
      draft: '未发送草稿',
    }],
  ])
})

it('stays available after a failed launch so GUI control can recover', async () => {
  h.invoke.mockImplementation(async (command: string) => {
    if (command === 'runtime_cli_handoff') throw new Error('terminal missing')
  })
  render(<CliHandoffButton />)
  fireEvent.click(screen.getByRole('button', { name: 'Continue in CLI' }))

  await waitFor(() => expect(h.toast).toHaveBeenCalled())
  expect(screen.getByRole('button', { name: 'Continue in CLI' })).toBeEnabled()
})
