import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_EVENT_NAME } from '@/lib/runtime-contract'

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  order: [] as string[],
  listener: undefined as
    | ((event: { payload: unknown }) => void)
    | undefined,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => h.listen(...args),
}))

import {
  RuntimeControls,
  RuntimeControlsContent,
} from '@/components/RuntimeControls'
import { useRuntimeStore } from '@/stores/runtime-store'
import {
  resetRuntimePermissionControllerForTests,
  runtimePermissionIdentityKey,
  useRuntimePermissionController,
} from '@/features/conversation/runtimePermissionController'

vi.mock('@/lib/window-surface', () => ({
  currentWindowSurface: () => 'main',
  shouldStopRuntimeOnPageHide: (
    surface: string,
    durableSessions: boolean
  ) => surface === 'main' && !durableSessions,
}))

const DEFAULT_CAPABILITIES = {
  durableSessions: false,
  detachedRuns: true,
  replayableEvents: true,
  runtimeOwnedApprovals: false,
}

const runtimeSnapshot = (
  status: 'stopped' | 'checking' | 'starting' | 'ready' | 'stopping' | 'failed',
  sequence = 0
) => ({
  runtimeId: 'hermes',
  runtimeEpoch: 'epoch-a',
  sequence,
  status,
})

const statusEnvelope = (
  status: 'stopped' | 'checking' | 'starting' | 'ready' | 'stopping' | 'failed',
  sequence: number
) => ({
  schemaVersion: '1.0',
  eventId: `event-${sequence}`,
  runtimeId: 'hermes',
  runtimeEpoch: 'epoch-a',
  sessionId: '__runtime__',
  sequence,
  timestamp: '2026-08-05T00:00:00.000Z',
  event: { type: 'runtime_status_changed', status },
})

const permissionEnvelope = () => ({
  schemaVersion: '1.0',
  eventId: 'permission-event-1',
  runtimeId: 'hermes',
  runtimeEpoch: 'epoch-a',
  sessionId: 'thread-1',
  runId: 'run-1',
  sequence: 3,
  timestamp: '2026-08-05T00:00:03.000Z',
  event: {
    type: 'permission_requested',
    request: {
      requestId: 'permission-1',
      toolCallId: 'tool-1',
      title: '允许搜索',
      description: 'Hermes 请求执行 web_search',
      toolName: 'web_search',
      canAllowOnce: true,
      canDeny: true,
      expiresAt: '2026-08-05T00:01:03.000Z',
    },
  },
})

describe('RuntimeControls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.order = []
    h.listener = undefined
    useRuntimeStore.setState({
      enabled: true,
      status: 'stopped',
      runtimeId: undefined,
      runtimeEpoch: undefined,
      lastSequence: -1,
      message: undefined,
      retiredEpochs: new Set(),
      capabilities: DEFAULT_CAPABILITIES,
      availableRuntimes: [],
    })
    resetRuntimePermissionControllerForTests()
    h.listen.mockImplementation(
      async (eventName: string, listener: (event: { payload: unknown }) => void) => {
        h.order.push(`listen:${eventName}`)
        h.listener = listener
        return h.unlisten
      }
    )
    h.invoke.mockImplementation(async (command: string) => {
      h.order.push(`invoke:${command}`)
      if (command === 'runtime_discover') return []
      if (command === 'runtime_capabilities') return DEFAULT_CAPABILITIES
      return runtimeSnapshot('ready')
    })
  })

  it.each([
    ['bianbu', 'epoch-a'],
    ['hermes', 'epoch-b'],
  ])('ignores capabilities returned after switching identity to %s / %s', async (runtimeId, runtimeEpoch) => {
    let resolveCapabilities!: (value: typeof DEFAULT_CAPABILITIES) => void
    h.invoke.mockImplementation(async (command: string) => {
      if (command === 'runtime_discover') return []
      if (command === 'runtime_capabilities') return new Promise((resolve) => { resolveCapabilities = resolve })
      return runtimeSnapshot('ready')
    })
    render(<RuntimeControls />)
    await waitFor(() => expect(resolveCapabilities).toBeDefined())
    const current = { ...DEFAULT_CAPABILITIES, durableSessions: true }
    act(() => useRuntimeStore.setState({ runtimeId, runtimeEpoch, capabilities: current }))
    await act(async () => resolveCapabilities(DEFAULT_CAPABILITIES))
    expect(useRuntimeStore.getState().capabilities).toEqual(current)
  })

  it('keeps the Runtime backend switching entry hidden', async () => {
    h.invoke.mockImplementation(async (command: string) => {
      if (command === 'runtime_discover') return [
        { id: 'bianbu', displayName: 'Bianbu Runtime', available: true, capabilities: DEFAULT_CAPABILITIES },
        { id: 'hermes', displayName: 'Hermes', available: true, capabilities: DEFAULT_CAPABILITIES },
      ]
      if (command === 'runtime_capabilities') return DEFAULT_CAPABILITIES
      return runtimeSnapshot('ready')
    })
    render(<RuntimeControls />)
    await screen.findByText('Hermes connected')
    expect(
      screen.queryByRole('combobox', { name: 'Runtime backend' })
    ).not.toBeInTheDocument()
    expect(h.invoke).not.toHaveBeenCalledWith('runtime_switch', expect.anything())
  })

  it('shows the disconnected state before the listener is ready', () => {
    h.listen.mockReturnValue(new Promise(() => {}))
    render(<RuntimeControls />)
    expect(screen.getByText('Hermes disconnected')).toBeInTheDocument()
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('renders the Security demo when Hermes is disabled', () => {
    render(
      <RuntimeControlsContent
        securityDemo={<button type="button">安全审批演示</button>}
      />
    )

    expect(
      screen.getByRole('button', { name: '安全审批演示' })
    ).toBeInTheDocument()
    expect(h.listen).not.toHaveBeenCalled()
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('listens before starting and reflects checking, starting, and ready states', async () => {
    h.invoke.mockImplementation(async (command: string) => {
      h.order.push(`invoke:${command}`)
      if (command === 'runtime_discover') return []
      if (command === 'runtime_capabilities') return DEFAULT_CAPABILITIES
      return runtimeSnapshot('checking', 0)
    })

    render(<RuntimeControls />)

    await waitFor(() => {
      expect(screen.getByText('Checking Hermes')).toBeInTheDocument()
    })
    expect(h.order).toEqual([
      `listen:${RUNTIME_EVENT_NAME}`,
      'invoke:runtime_discover',
      'invoke:runtime_start',
      'invoke:runtime_capabilities',
    ])

    act(() => h.listener?.({ payload: statusEnvelope('starting', 1) }))
    expect(screen.getByText('Starting Hermes')).toBeInTheDocument()

    act(() => h.listener?.({ payload: statusEnvelope('ready', 2) }))
    expect(screen.getByText('Hermes connected')).toBeInTheDocument()
  })

  it('shows failure and retries runtime_start from an icon button', async () => {
    let starts = 0
    h.invoke.mockImplementation(async (command: string) => {
      h.order.push(`invoke:${command}`)
      if (command === 'runtime_discover') return []
      if (command === 'runtime_capabilities') return DEFAULT_CAPABILITIES
      starts += 1
      return starts === 1
        ? runtimeSnapshot('failed', 0)
        : runtimeSnapshot('ready', 1)
    })

    render(<RuntimeControls />)

    const retry = await screen.findByRole('button', {
      name: 'Reconnect Hermes',
    })
    expect(screen.getByText('Hermes connection failed')).toBeInTheDocument()
    expect(retry.querySelector('svg')).not.toBeNull()

    fireEvent.click(retry)

    await waitFor(() => {
      expect(screen.getByText('Hermes connected')).toBeInTheDocument()
    })
    expect(
      h.invoke.mock.calls.filter(([command]) => command === 'runtime_start')
    ).toHaveLength(2)
  })

  it('re-registers the event listener before retrying after listen fails', async () => {
    h.listen
      .mockRejectedValueOnce(new Error('listen denied'))
      .mockImplementationOnce(
        async (
          eventName: string,
          listener: (event: { payload: unknown }) => void
        ) => {
          h.order.push(`listen:${eventName}`)
          h.listener = listener
          return h.unlisten
        }
      )
    h.invoke.mockImplementation(async (command: string) => {
      h.order.push(`invoke:${command}`)
      return runtimeSnapshot('ready')
    })

    render(<RuntimeControls />)

    expect(await screen.findByText('Hermes connection failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Hermes' }))

    expect(await screen.findByText('Hermes connected')).toBeInTheDocument()
    expect(h.listen).toHaveBeenCalledTimes(2)
    expect(h.invoke).toHaveBeenCalledTimes(3)
    expect(h.order).toEqual([
      `listen:${RUNTIME_EVENT_NAME}`,
      'invoke:runtime_discover',
      'invoke:runtime_start',
      'invoke:runtime_capabilities',
    ])
  })

  it('unlistens from runtime events on unmount', async () => {
    h.invoke.mockResolvedValue(runtimeSnapshot('ready'))
    const { unmount } = render(<RuntimeControls />)

    await waitFor(() => expect(h.listen).toHaveBeenCalled())
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('runtime_start'))
    unmount()

    expect(h.unlisten).toHaveBeenCalledTimes(1)
  })

  it('stops the Runtime once when the main WebView unloads', async () => {
    h.invoke.mockResolvedValue(runtimeSnapshot('ready'))
    render(<RuntimeControls />)
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('runtime_start'))

    fireEvent(window, new Event('pagehide'))
    fireEvent(window, new Event('beforeunload'))

    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('runtime_stop'))
    expect(
      h.invoke.mock.calls.filter(([command]) => command === 'runtime_stop')
    ).toHaveLength(1)
  })

  it('records a permission request before its conversation is opened', async () => {
    h.invoke.mockResolvedValue(runtimeSnapshot('ready'))
    render(<RuntimeControls />)

    await waitFor(() => expect(h.listener).toBeDefined())
    act(() => h.listener?.({ payload: permissionEnvelope() }))

    const data = {
      runtimeId: 'hermes',
      runtimeEpoch: 'epoch-a',
      sessionId: 'thread-1',
      runId: 'run-1',
      requestId: 'permission-1',
      toolCallId: 'tool-1',
    }
    expect(
      useRuntimePermissionController.getState().entries[
        runtimePermissionIdentityKey(data)
      ]
    ).toMatchObject({ status: 'pending', data })
    expect(h.invoke).toHaveBeenCalledTimes(3)
    expect(h.invoke).toHaveBeenCalledWith('runtime_start')
  })
})
