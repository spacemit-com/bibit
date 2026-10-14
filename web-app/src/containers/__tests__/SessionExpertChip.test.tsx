import { act, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

const h = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }))
vi.mock('@/stores/runtime-store', () => ({
  useRuntimeStore: (select: any) => select({ runtimeEpoch: 'e1', runtimeId: 'bianbu' }),
}))

import { SessionExpertChip } from '../SessionExpertChip'

beforeEach(() => {
  localStorage.clear()
  h.invoke.mockReset().mockImplementation(async (name: string) =>
    name === 'runtime_agents_list'
      ? [{ id: 'bianbu.audit', name: 'audit', zhName: '代码审查专家', available: true, unavailableReason: '' }]
      : { targetId: 't1', runtimeEpoch: 'e1' })
})

it('显示会话绑定专家的中文名', async () => {
  render(<SessionExpertChip agentId="bianbu.audit" enabled />)
  await act(async () => {})
  const chip = screen.getByTestId('session-expert-chip')
  expect(chip).toHaveTextContent('代码审查专家')
  expect(chip).toHaveAttribute('title', expect.stringContaining('代码审查专家'))
})

it('专家目录取不到该 id 时回落显示 id，不空白', async () => {
  render(<SessionExpertChip agentId="gone.expert" enabled />)
  await act(async () => {})
  expect(screen.getByTestId('session-expert-chip')).toHaveTextContent('gone.expert')
})

it('非 Runtime 会话或没有绑定专家时不占位', async () => {
  const view = render(<SessionExpertChip agentId="" enabled />)
  await act(async () => {})
  expect(screen.queryByTestId('session-expert-chip')).not.toBeInTheDocument()
  view.rerender(<SessionExpertChip agentId="bianbu.audit" enabled={false} />)
  await act(async () => {})
  expect(screen.queryByTestId('session-expert-chip')).not.toBeInTheDocument()
  expect(h.invoke).not.toHaveBeenCalledWith('runtime_agents_list', expect.anything())
})
