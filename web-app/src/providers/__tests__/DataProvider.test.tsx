import { render, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Hoisted shared mocks/state
const h = vi.hoisted(() => {
  return {
    runtimeId: 'bianbu',
    runtimeEpoch: 'epoch',
    setProviders: vi.fn(),
    updateProvider: vi.fn(),
    getProviderByName: vi.fn(),
    providers: [] as Array<Record<string, unknown>>,
    setServers: vi.fn(),
    setSettings: vi.fn(),
    setThreads: vi.fn(),
    setThreadsLoading: vi.fn(),
    setThreadsState: vi.fn(),
    resetPrompt: vi.fn(),
    threadsInStore: {} as Record<string, unknown>,
    registrationListeners: new Set<() => void>(),
    setLastServerModels: vi.fn(),
    setServerPort: vi.fn(),
    setServerStatus: vi.fn(),
    navigate: vi.fn(),
    invoke: vi.fn().mockResolvedValue(undefined),
    windowLabel: 'main',
    isDev: vi.fn().mockReturnValue(false),
    providerHasRemoteApiKeys: vi.fn().mockReturnValue(true),
    providerRemoteApiKeyChain: vi.fn().mockReturnValue(['key-1']),
    eventsOn: vi.fn(),
    eventsOff: vi.fn(),
    localApi: {
      enableOnStartup: false,
      serverHost: '127.0.0.1',
      serverPort: 1337,
      apiPrefix: '/v1',
      apiKey: '',
      trustedHosts: [],
      corsEnabled: true,
      verboseLogs: false,
      proxyTimeout: 0,
      lastServerModels: [] as Array<{ model: string; provider: string }>,
      defaultModelLocalApiServer: null as null | { model: string; provider: string },
    },
  }
})

vi.mock('@/stores/runtime-store', () => ({ useRuntimeStore: (selector: (state: unknown) => unknown) => selector({ runtimeId: h.runtimeId, runtimeEpoch: h.runtimeEpoch }) }))

// Zustand-style hook with getState support
vi.mock('@/hooks/useModelProvider', () => {
  const useModelProvider = vi.fn(() => ({
    setProviders: h.setProviders,
    getProviderByName: h.getProviderByName,
  })) as unknown as {
    (): unknown
    getState: () => { providers: unknown[]; updateProvider: () => void }
  }
  useModelProvider.getState = () => ({
    providers: h.providers,
    updateProvider: h.updateProvider,
  })
  return { useModelProvider }
})

vi.mock('@/hooks/useMCPServers', () => ({
  useMCPServers: () => ({ setServers: h.setServers, setSettings: h.setSettings }),
  DEFAULT_MCP_SETTINGS: { foo: 'bar' },
}))

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({
      onRegistrationChange: (cb: () => void) => {
        h.registrationListeners.add(cb)
        return () => h.registrationListeners.delete(cb)
      },
    }),
  },
}))

vi.mock('@/hooks/useThreads', () => {
  const state = () => ({
    setThreads: h.setThreads,
    setThreadsLoading: h.setThreadsLoading,
    threads: h.threadsInStore,
  })
  const useThreads = vi.fn((selector?: (s: unknown) => unknown) =>
    selector ? selector(state()) : state()
  ) as unknown as {
    (selector?: (s: unknown) => unknown): unknown
    getState: () => { threads: Record<string, unknown> }
    setState: (state: Record<string, unknown>) => void
  }
  useThreads.getState = () => ({ threads: h.threadsInStore })
  useThreads.setState = h.setThreadsState
  return { useThreads }
})

vi.mock('@/hooks/usePrompt', () => ({
  usePrompt: {
    getState: () => ({ resetPrompt: h.resetPrompt }),
  },
}))

vi.mock('@/hooks/useLocalApiServer', () => ({
  useLocalApiServer: () => ({
    ...h.localApi,
    setLastServerModels: h.setLastServerModels,
    setServerPort: h.setServerPort,
  }),
}))

vi.mock('@/hooks/useAppState', () => ({
  useAppState: (sel: (s: { setServerStatus: unknown }) => unknown) =>
    sel({ setServerStatus: h.setServerStatus }),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => h.navigate,
}))

vi.mock('@/lib/utils', () => ({
  isDev: () => h.isDev(),
}))

vi.mock('@/lib/provider-api-keys', () => ({
  providerHasRemoteApiKeys: (p: unknown) => h.providerHasRemoteApiKeys(p),
  providerRemoteApiKeyChain: (p: unknown) => h.providerRemoteApiKeyChain(p),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: h.windowLabel }),
}))

vi.mock('@janhq/core', () => ({
  AppEvent: { onModelImported: 'onModelImported' },
  events: {
    on: (...a: unknown[]) => h.eventsOn(...a),
    off: (...a: unknown[]) => h.eventsOff(...a),
  },
}))

// Override serviceHub per-test needs. We extend the global setup's mock.
const hubState = vi.hoisted(() => ({
  unsubscribe: vi.fn(),
  deeplinkGetCurrent: vi.fn().mockResolvedValue(null),
  deeplinkOnOpenUrl: vi.fn().mockResolvedValue(vi.fn()),
  eventsListen: vi.fn(),
  getProviders: vi.fn().mockResolvedValue([]),
  getMCPConfig: vi.fn().mockResolvedValue({ mcpServers: { a: 1 }, mcpSettings: { s: 1 } }),
  fetchThreads: vi.fn().mockResolvedValue([]),
  getServerStatus: vi.fn().mockResolvedValue(false),
  startModel: vi.fn().mockResolvedValue(undefined),
  getActiveModels: vi.fn().mockResolvedValue([]),
  startServer: vi.fn().mockResolvedValue(1337),
}))

vi.mock('@/hooks/useServiceHub', () => {
  const hub = {
    providers: () => ({ getProviders: hubState.getProviders }),
    mcp: () => ({ getMCPConfig: hubState.getMCPConfig }),
    threads: () => ({ fetchThreads: hubState.fetchThreads }),
    events: () => ({
      listen: (...args: unknown[]) => {
        hubState.eventsListen(...args)
        return Promise.resolve(hubState.unsubscribe)
      },
    }),
    app: () => ({ getServerStatus: hubState.getServerStatus }),
    models: () => ({
      startModel: hubState.startModel,
      getActiveModels: hubState.getActiveModels,
    }),
  }
  return {
    useServiceHub: () => hub,
    getServiceHub: () => hub,
    initializeServiceHubStore: vi.fn(),
    isServiceHubInitialized: () => true,
  }
})

// Import after mocks
import { DataProvider } from '../DataProvider'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'

const resetHubState = () => {
  hubState.getProviders.mockResolvedValue([])
  hubState.getMCPConfig.mockResolvedValue({ mcpServers: { a: 1 }, mcpSettings: { s: 1 } })
  hubState.fetchThreads.mockResolvedValue([])
  hubState.getServerStatus.mockResolvedValue(false)
  hubState.getActiveModels.mockResolvedValue([])
  hubState.startServer.mockResolvedValue(1337)
  hubState.startModel.mockResolvedValue(undefined)
}

describe('DataProvider', () => {
  const originalWindowCore = (window as unknown as { core?: unknown }).core

  beforeEach(() => {
    vi.clearAllMocks()
    resetHubState()
    h.runtimeId = 'bianbu'
    h.runtimeEpoch = 'epoch'
    h.providers = []
    h.threadsInStore = {}
    h.registrationListeners.clear()
    h.isDev.mockReturnValue(false)
    h.providerHasRemoteApiKeys.mockReturnValue(true)
    h.providerRemoteApiKeyChain.mockReturnValue(['key-1'])
    h.invoke.mockResolvedValue(undefined)
    h.windowLabel = 'main'
    useGeneralSetting.setState({ autoUpdateCheck: false })
    h.localApi.enableOnStartup = false
    h.localApi.defaultModelLocalApiServer = null
    h.localApi.lastServerModels = []
    ;(window as unknown as { core: unknown }).core = {
      api: { startServer: hubState.startServer },
    }
  })

  afterEach(() => {
    useGeneralSetting.setState({ autoUpdateCheck: false })
    ;(window as unknown as { core?: unknown }).core = originalWindowCore
  })

  it('renders null (no DOM output)', () => {
    const { container } = render(<DataProvider />)
    expect(container.firstChild).toBeNull()
  })

  it('retries fetchThreads when it throws (extension not ready) and never wipes the list on failure', async () => {
    hubState.fetchThreads
      .mockRejectedValueOnce(new Error('Conversational extension not available yet'))
      .mockResolvedValueOnce([{ id: 't1' }])

    render(<DataProvider />)

    await waitFor(() => {
      expect(hubState.fetchThreads).toHaveBeenCalledTimes(2)
    })
    // The failed first attempt must not push an empty array.
    expect(h.setThreads).not.toHaveBeenCalledWith([])
    await waitFor(() => {
      expect(h.setThreads).toHaveBeenCalledWith([{ id: 't1' }])
    })
  })

  it('does not wipe a populated thread list when fetchThreads resolves empty', async () => {
    h.threadsInStore = { t1: { id: 't1' } }
    hubState.fetchThreads.mockResolvedValue([])

    render(<DataProvider />)

    await waitFor(() => {
      expect(hubState.fetchThreads).toHaveBeenCalled()
    })
    expect(h.setThreads).not.toHaveBeenCalled()
  })

  it('writes an empty thread list when the store is also empty', async () => {
    hubState.fetchThreads.mockResolvedValue([])

    render(<DataProvider />)

    await waitFor(() => {
      expect(h.setThreads).toHaveBeenCalledWith([])
    })
  })

  it('leaves the old session route when the Runtime changes', async () => {
    const { rerender } = render(<DataProvider />)
    await waitFor(() => expect(hubState.fetchThreads).toHaveBeenCalled())
    h.setThreads.mockClear()
    h.setThreadsState.mockClear()
    h.resetPrompt.mockClear()
    h.navigate.mockClear()

    h.runtimeId = 'hermes'
    rerender(<DataProvider />)

    await waitFor(() => {
      expect(h.setThreads).toHaveBeenCalledWith([])
      expect(h.setThreadsState).toHaveBeenCalledWith({
        currentThreadId: undefined,
        currentThreadTargetId: undefined,
      })
      expect(h.resetPrompt).toHaveBeenCalledOnce()
      expect(h.navigate).toHaveBeenCalledWith({ to: '/', replace: true })
    })
  })

  it('refetches threads when an extension registers after retries are exhausted', async () => {
    vi.useFakeTimers()
    try {
      hubState.fetchThreads.mockRejectedValue(new Error('not ready'))

      const { unmount } = render(<DataProvider />)

      // 1 initial attempt + 20 bounded retries (backoff capped at 1s).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30000)
      })
      expect(hubState.fetchThreads).toHaveBeenCalledTimes(21)
      expect(h.setThreads).not.toHaveBeenCalled()

      // A late extension registration re-arms the fetch.
      hubState.fetchThreads.mockResolvedValue([{ id: 't1' }])
      await act(async () => {
        h.registrationListeners.forEach((cb) => cb())
      })
      expect(hubState.fetchThreads).toHaveBeenCalledTimes(22)
      expect(h.setThreads).toHaveBeenCalledWith([{ id: 't1' }])

      unmount()
      expect(h.registrationListeners.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes DEFAULT_MCP_SETTINGS when mcp config lacks values', async () => {
    hubState.getMCPConfig.mockResolvedValue({})
    render(<DataProvider />)
    await waitFor(() => {
      expect(h.setServers).toHaveBeenCalledWith({})
      expect(h.setSettings).toHaveBeenCalledWith({ foo: 'bar' })
    })
  })

  it('registers remote providers with the backend for active providers', async () => {
    const fetched = [
      {
        provider: 'openai',
        active: true,
        models: [{ id: 'gpt-4' }],
        custom_header: [{ header: 'X', value: 'Y' }],
        base_url: 'https://api',
      },
      {
        provider: 'llamacpp',
        active: true,
        models: [],
        custom_header: [],
      },
    ]
    hubState.getProviders.mockResolvedValue(fetched)
    // Registration reads the store after setProviders merges the fetched list.
    h.providers = fetched
    render(<DataProvider />)
    await waitFor(() => {
      expect(h.invoke).toHaveBeenCalledWith(
        'register_provider_config',
        expect.objectContaining({
          request: expect.objectContaining({
            provider: 'openai',
            api_key: 'key-1',
            models: ['gpt-4'],
          }),
        }),
      )
    })
    // llamacpp should be skipped
    const calls = h.invoke.mock.calls.filter(
      (c) => c[0] === 'register_provider_config' && (c[1] as { request: { provider: string } }).request.provider === 'llamacpp',
    )
    expect(calls.length).toBe(0)
  })

  it('skips registration when provider has no API key chain', async () => {
    h.providerRemoteApiKeyChain.mockReturnValue([])
    h.providers = [
      { provider: 'openai', active: true, models: [], custom_header: [] },
    ]
    render(<DataProvider />)
    await waitFor(() => {
      expect(h.providerRemoteApiKeyChain).toHaveBeenCalled()
    })
    const regCalls = h.invoke.mock.calls.filter((c) => c[0] === 'register_provider_config')
    expect(regCalls.length).toBe(0)
  })

  it('logs provider registration failures without throwing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.invoke.mockRejectedValue(new Error('nope'))
    const fetched = [
      { provider: 'openai', active: true, models: [], custom_header: [] },
    ]
    hubState.getProviders.mockResolvedValue(fetched)
    h.providers = fetched
    render(<DataProvider />)
    await waitFor(() => {
      expect(err).toHaveBeenCalledWith(
        expect.stringContaining('Failed to register provider openai'),
        expect.any(Error),
      )
    })
    err.mockRestore()
  })

  it('registers a listener for onModelImported events', async () => {
    render(<DataProvider />)
    await waitFor(() => {
      expect(h.eventsOn).toHaveBeenCalledWith('onModelImported', expect.any(Function))
    })
  })

  it('does not start server on mount when enableOnStartup is false', async () => {
    render(<DataProvider />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(hubState.getServerStatus).not.toHaveBeenCalled()
    expect(hubState.startServer).not.toHaveBeenCalled()
  })

  it('short-circuits when server is already running', async () => {
    h.localApi.enableOnStartup = true
    hubState.getServerStatus.mockResolvedValue(true)
    render(<DataProvider />)
    await waitFor(() => {
      expect(h.setServerStatus).toHaveBeenCalledWith('running')
    })
    expect(hubState.startServer).not.toHaveBeenCalled()
  })

  it('starts default model and local API server when enabled', async () => {
    h.localApi.enableOnStartup = true
    h.localApi.defaultModelLocalApiServer = { model: 'm1', provider: 'openai' }
    h.getProviderByName.mockReturnValue({ provider: 'openai' })
    hubState.getServerStatus.mockResolvedValue(false)
    hubState.startServer.mockResolvedValue(2000)
    hubState.getActiveModels.mockResolvedValue(['m1'])
    h.providers = [{ provider: 'openai', models: [{ id: 'm1' }] }]

    render(<DataProvider />)

    await waitFor(() => {
      expect(h.setServerStatus).toHaveBeenCalledWith('pending')
      expect(hubState.startModel).toHaveBeenCalled()
      expect(hubState.startServer).toHaveBeenCalled()
    })

    await waitFor(() => {
      expect(h.setServerPort).toHaveBeenCalledWith(2000)
      expect(h.setServerStatus).toHaveBeenCalledWith('running')
      expect(h.setLastServerModels).toHaveBeenCalledWith([
        { model: 'm1', provider: 'openai' },
      ])
    })
  })

  it('sets server status to stopped on startup failure', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.localApi.enableOnStartup = true
    hubState.getServerStatus.mockRejectedValue(new Error('fail'))
    render(<DataProvider />)
    await waitFor(() => {
      expect(h.setServerStatus).toHaveBeenCalledWith('stopped')
    })
    err.mockRestore()
  })


})


it('reloads sessions after reconnecting the same Runtime', async () => {
  hubState.fetchThreads.mockResolvedValue([])
  const { rerender } = render(<DataProvider />)
  await waitFor(() => expect(hubState.fetchThreads).toHaveBeenCalled())
  hubState.fetchThreads.mockClear().mockResolvedValue([{ id: 'recovered-session' }])
  h.runtimeEpoch = 'reconnected'
  rerender(<DataProvider />)
  await waitFor(() => expect(h.setThreads).toHaveBeenCalledWith([{ id: 'recovered-session' }]))
})
