import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DefaultThreadsService } from '../threads/default'
import { ExtensionManager } from '@/lib/extension'
import { ConversationalExtension, ExtensionTypeEnum } from '@janhq/core'
import { useRuntimeStore } from '@/stores/runtime-store'
import { readSessionTitle, sessionTitleKey, sessionTitleRequests } from '@/lib/session-title'

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}))

// Mock ExtensionManager
vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: vi.fn(),
  },
}))

describe('DefaultThreadsService', () => {
  let threadsService: DefaultThreadsService

  const setRuntimeBacked = (backed: boolean) => {
    useRuntimeStore.setState({
      runtimeId: backed ? 'bianbu' : 'hermes',
      capabilities: {
        durableSessions: backed,
        detachedRuns: backed,
        replayableEvents: backed,
        runtimeOwnedApprovals: backed,
      },
    })
  }

  const mockConversationalExtension = {
    listThreads: vi.fn(),
    createThread: vi.fn(),
    modifyThread: vi.fn(),
    deleteThread: vi.fn(),
  }

  const mockExtensionManager = {
    get: vi.fn().mockReturnValue(mockConversationalExtension),
  }

  beforeEach(() => {
    localStorage.clear()
    sessionTitleRequests.clear()
    threadsService = new DefaultThreadsService()
    setRuntimeBacked(false)
    vi.clearAllMocks()
    h.invoke.mockReset()
    ;(ExtensionManager.getInstance as any).mockReturnValue(mockExtensionManager)
  })

  it('手动标题先标记并等待已发出的自动标题请求，再提交重命名', async () => {
    setRuntimeBacked(true)
    const key = sessionTitleKey('target-a', 's1')
    let finish!: () => void
    sessionTitleRequests.set(key, new Promise<void>(resolve => { finish = resolve }))
    h.invoke.mockResolvedValue({ accepted: true, duplicate: false })
    const rename = threadsService.updateThread({ id: 's1', title: '手动名称', metadata: { targetId: 'target-a' } } as Thread)
    expect(readSessionTitle(key)?.manual).toBe(true)
    expect(h.invoke).not.toHaveBeenCalled()
    finish()
    await rename
    expect(h.invoke).toHaveBeenCalledWith('runtime_session_rename', { expectedTargetId: 'target-a', sessionId: 's1', title: '手动名称' })
  })

  describe('fetchThreads', () => {
    it('uses Runtime Sessions as the Bianbu authority', async () => {
      threadsService = new DefaultThreadsService()
      setRuntimeBacked(true)
      h.invoke.mockImplementation(async (command: string) => {
        if (command === 'runtime_sessions_list') {
          return [
            {
              id: 'session-1',
              title: 'Runtime Session',
              agentId: 'default',
              metadata: { source: 'runtime' },
              createdAt: 1,
              updatedAt: 2,
            },
          ]
        }
        return { runtimeId: 'bianbu', status: 'ready', sequence: 0 }
      })

      const result = await threadsService.fetchThreads()

      expect(h.invoke).not.toHaveBeenCalledWith('runtime_start')
      expect(h.invoke).toHaveBeenNthCalledWith(1, 'runtime_sessions_list')
      expect(mockConversationalExtension.listThreads).not.toHaveBeenCalled()
      expect(result[0]).toMatchObject({
        id: 'session-1',
        model: { id: 'default', provider: 'runtime' },
        metadata: expect.objectContaining({ source: 'runtime', runtime: 'bianbu', agentId: 'default' }),
      })
    })

  })

  it('列表读取失败及重试不会重新启动 Runtime', async () => {
    setRuntimeBacked(true)
    h.invoke.mockRejectedValue(new Error('Runtime 未就绪'))
    await expect(threadsService.fetchThreads()).rejects.toThrow('Runtime 未就绪')
    await expect(threadsService.fetchThreads()).rejects.toThrow('Runtime 未就绪')
    expect(h.invoke.mock.calls.map(call => call[0])).toEqual(['runtime_sessions_list', 'runtime_sessions_list'])
  })

  it('loads Hermes history from the existing conversational storage', async () => {
    const stored = [{ id: 'hermes-session', title: 'Hermes Session' }] as Thread[]
    mockConversationalExtension.listThreads.mockResolvedValue(stored)

    await expect(threadsService.fetchThreads()).resolves.toBe(stored)

    expect(mockConversationalExtension.listThreads).toHaveBeenCalledOnce()
    expect(h.invoke).not.toHaveBeenCalledWith('runtime_sessions_list')
  })

  it('reports Hermes storage as not ready until the extension registers', async () => {
    mockExtensionManager.get.mockReturnValueOnce(undefined)

    await expect(threadsService.fetchThreads()).rejects.toThrow(
      'Conversation storage is not ready yet'
    )
  })

  it('deletes durable sessions on the Runtime with controller ownership', async () => {
    setRuntimeBacked(true)
    h.invoke.mockResolvedValue({ accepted: true, duplicate: false })
    await threadsService.deleteThread('session-1', 'target-a')
    expect(h.invoke).toHaveBeenCalledWith('runtime_session_delete', { sessionId: 'session-1', expectedTargetId: 'target-a' })
    expect(mockConversationalExtension.deleteThread).not.toHaveBeenCalled()
  })

  it('captures the Runtime target before creating a session', async () => {
    setRuntimeBacked(true)
    h.invoke.mockImplementation(async (command: string) => command === 'runtime_target_identity'
      ? { targetId: 'target-a' }
      : { accepted: true, duplicate: false })
    const created = await threadsService.createThread({
      id: 'session-1', title: 'Runtime Session', model: { id: 'bianbu', provider: 'runtime' }, metadata: { agentId: 'agent-1' },
    } as Thread)
    expect(h.invoke).toHaveBeenCalledWith('runtime_session_create', {
      expectedTargetId: 'target-a',
      request: { sessionId: 'session-1', title: 'Runtime Session', agentId: 'agent-1' },
    })
    expect(created.metadata?.targetId).toBe('target-a')
  })

  it('uses the thread target when renaming a Runtime session', async () => {
    setRuntimeBacked(true)
    h.invoke.mockResolvedValue({ accepted: true, duplicate: false })
    await threadsService.updateThread({ id: 'session-1', title: '新标题', metadata: { targetId: 'target-a' } } as Thread)
    expect(h.invoke).toHaveBeenCalledWith('runtime_session_rename', {
      sessionId: 'session-1', title: '新标题', expectedTargetId: 'target-a',
    })
  })

  describe('createThread', () => {
    it('creates a Bianbu Session through the guarded Runtime path', async () => {
      threadsService = new DefaultThreadsService()
      setRuntimeBacked(true)
      const inputThread = {
        id: 'session-1',
        title: 'Runtime Session',
        metadata: { agentId: 'agent-1', targetId: 'target-a' },
        model: { id: 'bianbu', provider: 'runtime' },
      } as Thread
      h.invoke.mockResolvedValue({ accepted: true, duplicate: false })

      await expect(threadsService.createThread(inputThread)).resolves.toBe(
        inputThread
      )

      expect(h.invoke.mock.calls).toEqual([
        ['runtime_controller_acquire'],
        ['runtime_start'],
        [
          'runtime_session_create',
          { expectedTargetId: 'target-a', request: { sessionId: 'session-1', title: 'Runtime Session', agentId: 'agent-1' } },
        ],
        ['runtime_controller_release'],
      ])
      expect(mockConversationalExtension.createThread).not.toHaveBeenCalled()
    })

    it('releases a newly acquired Bianbu controller when creation fails', async () => {
      threadsService = new DefaultThreadsService()
      setRuntimeBacked(true)
      const inputThread = {
        id: 'session-1',
        title: 'Runtime Session',
        metadata: { agentId: 'agent-1', targetId: 'target-a' },
        model: { id: 'bianbu', provider: 'runtime' },
      } as Thread
      h.invoke.mockImplementation(async (command: string) => {
        if (command === 'runtime_start') throw new Error('runtime unavailable')
        return { accepted: true, duplicate: false }
      })

      await expect(threadsService.createThread(inputThread)).rejects.toThrow(
        'runtime unavailable'
      )
      expect(h.invoke.mock.calls).toEqual([
        ['runtime_controller_acquire'],
        ['runtime_start'],
        ['runtime_controller_release'],
      ])
    })

    it('does not release a Bianbu controller owned by an existing caller', async () => {
      threadsService = new DefaultThreadsService()
      setRuntimeBacked(true)
      const inputThread = {
        id: 'session-1',
        title: 'Runtime Session',
        metadata: { agentId: 'agent-1', targetId: 'target-a' },
        model: { id: 'bianbu', provider: 'runtime' },
      } as Thread
      h.invoke.mockResolvedValueOnce({ accepted: true, duplicate: true })

      await expect(threadsService.createThread(inputThread)).resolves.toBe(
        inputThread
      )
      expect(h.invoke).not.toHaveBeenCalledWith('runtime_controller_release')
    })

    it('should create thread successfully', async () => {
      const inputThread = {
        id: '1',
        title: 'New Thread',
        model: { id: 'gpt-4', provider: 'openai' },
        order: 1,
      }

      const mockCreatedThread = {
        id: '1',
        title: 'New Thread',
        updated: 1234567890,
        model: { id: 'gpt-4', provider: 'openai' },
        metadata: { order: 1 },
      }

      mockConversationalExtension.createThread.mockResolvedValue(
        mockCreatedThread
      )

      const result = await threadsService.createThread(inputThread as Thread)

      expect(result).toMatchObject({
        id: '1',
        title: 'New Thread',
        updated: 1234567890,
        model: { id: 'gpt-4', provider: 'openai' },
        order: 1,
      })
    })

    it('should handle creation error and return original thread', async () => {
      const inputThread = {
        id: '1',
        title: 'New Thread',
        model: { id: 'gpt-4', provider: 'openai' },
      }

      mockConversationalExtension.createThread.mockRejectedValue(
        new Error('Creation failed')
      )

      const result = await threadsService.createThread(inputThread as Thread)

      expect(result).toEqual(inputThread)
    })

    it('falls back to the Tauri thread command for runtime threads when the extension create fails', async () => {
      const inputThread = {
        id: 'draft-runtime-thread',
        title: 'Runtime Thread',
        model: { id: 'hermes', provider: 'runtime' },
      }
      const persistedThread = {
        id: 'persisted-runtime-thread',
        title: 'Runtime Thread',
        updated: 1234567890,
        metadata: {},
      }

      mockConversationalExtension.createThread.mockRejectedValue(
        new Error('extension unavailable')
      )
      h.invoke.mockResolvedValue(persistedThread)

      const result = await threadsService.createThread(inputThread as Thread)

      expect(h.invoke).toHaveBeenCalledWith(
        'create_thread',
        expect.objectContaining({
          thread: expect.objectContaining({
            title: 'Runtime Thread',
            model: { id: 'hermes', provider: 'runtime' },
          }),
        })
      )
      expect(result).toMatchObject({
        id: 'persisted-runtime-thread',
        title: 'Runtime Thread',
        model: { id: 'hermes', provider: 'runtime' },
      })
    })
  })

  describe('updateThread', () => {
    it('should update thread successfully', async () => {
      const thread = {
        id: '1',
        title: 'Updated Thread',
        model: { id: 'gpt-4', provider: 'openai' },
        isFavorite: true,
        order: 2,
      }

      threadsService.updateThread(thread as Thread)

      expect(mockConversationalExtension.modifyThread).toHaveBeenCalledWith(
        expect.objectContaining({
          id: '1',
          title: 'Updated Thread',
          assistants: [],
          metadata: { is_favorite: true, order: 2 },
        })
      )
    })
  })

  describe('deleteThread', () => {
    it('should delete thread successfully', () => {
      const threadId = '1'

      threadsService.deleteThread(threadId)

      expect(mockConversationalExtension.deleteThread).toHaveBeenCalledWith(
        threadId
      )
    })
  })

  describe('edge cases and error handling', () => {
    it('propagates runtime session listing failures', async () => {
      setRuntimeBacked(true)
      h.invoke.mockImplementation(async (command: string) => {
        if (command === 'runtime_sessions_list') {
          throw new Error('runtime list failed')
        }
        return { runtimeId: 'bianbu', status: 'ready', sequence: 0 }
      })

      await expect(threadsService.fetchThreads()).rejects.toThrow(
        'runtime list failed'
      )
    })

    it('should handle createThread when extension manager returns null', async () => {
      ;(ExtensionManager.getInstance as any).mockReturnValue({
        get: vi.fn().mockReturnValue(null),
      })

      const inputThread = {
        id: '1',
        title: 'Test Thread',
        model: { id: 'gpt-4', provider: 'openai' },
      }

      const result = await threadsService.createThread(inputThread as Thread)

      expect(result).toEqual(inputThread)
    })

    it('should handle updateThread when extension manager returns null', async () => {
      ;(ExtensionManager.getInstance as any).mockReturnValue({
        get: vi.fn().mockReturnValue(null),
      })

      const thread = {
        id: '1',
        title: 'Test Thread',
        model: { id: 'gpt-4', provider: 'openai' },
      }

      const result = await threadsService.updateThread(thread as Thread)

      expect(result).toBeUndefined()
    })

    it('should handle deleteThread when extension manager returns null', async () => {
      ;(ExtensionManager.getInstance as any).mockReturnValue({
        get: vi.fn().mockReturnValue(null),
      })

      const result = await threadsService.deleteThread('test-id')

      expect(result).toBeUndefined()
    })

    it('should handle updateThread with missing assistants', () => {
      const thread = {
        id: '1',
        title: 'Updated Thread',
        model: { id: 'gpt-4', provider: 'openai' },
        // missing assistants
        isFavorite: true,
        order: 2,
      }

      threadsService.updateThread(thread as Thread)

      expect(mockConversationalExtension.modifyThread).toHaveBeenCalledWith(
        expect.objectContaining({ assistants: [] })
      )
    })

    it('should handle createThread with missing metadata in response', async () => {
      const inputThread = {
        id: '1',
        title: 'New Thread',
        model: { id: 'gpt-4', provider: 'openai' },
        order: 1,
      }

      const mockCreatedThread = {
        id: '1',
        title: 'New Thread',
        updated: 1234567890,
        assistants: [{ model: { id: 'gpt-4', engine: 'openai' } }],
        // missing metadata
      }

      mockConversationalExtension.createThread.mockResolvedValue(
        mockCreatedThread
      )

      const result = await threadsService.createThread(inputThread as Thread)

      expect(result).toMatchObject({
        id: '1',
        title: 'New Thread',
        updated: 1234567890,
        model: { id: 'gpt-4', provider: 'openai' },
        order: 1, // Should fall back to original thread order
        assistants: [{ model: { id: 'gpt-4', engine: 'openai' } }],
      })
    })
  })
})

it('Session列表携目标身份并用持久水位恢复未读，不沿用server false', async () => {
  useRuntimeStore.setState({ capabilities: { durableSessions: true, detachedRuns: true, replayableEvents: true, runtimeOwnedApprovals: true, sessionEvents: true } })
  localStorage.setItem('bibit:session-read:["target-a","s"]', JSON.stringify({ readSeq: 2, terminalSeq: 5 }))
  h.invoke.mockImplementation(async (name: string) => name === 'runtime_target_identity' ? { targetId: 'target-a', runtimeEpoch: 'e' } : name === 'runtime_sessions_list' ? [{ id: 's', title: '会话', agentId: 'a', metadata: {}, createdAt: 1, updatedAt: 2, completedUnread: false, running: false, waiting: true }] : undefined)
  const threads = await new DefaultThreadsService().fetchThreads()
  expect(threads[0].metadata).toMatchObject({ targetId: 'target-a', runtimeSession: { waiting: true, completedUnread: true } })
  localStorage.clear()
})
