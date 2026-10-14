import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  chatInitializers: [] as Array<Record<string, unknown>>,
  sdkOptions: [] as Array<Record<string, unknown>>,
}))

vi.mock('@ai-sdk/react', () => ({
  Chat: class {
    status = 'ready'
    messages = []

    constructor(initializer: Record<string, unknown>) {
      h.chatInitializers.push(initializer)
    }

    ['~registerStatusCallback']() {
      return () => undefined
    }

    stop() {}
  },
  useChat: (options: Record<string, unknown>) => {
    h.sdkOptions.push(options)
    return { status: 'ready' }
  },
}))

vi.mock('@/lib/runtime-chat-transport', () => ({
  RuntimeChatTransport: class {
    updateSystemMessage = vi.fn()
    setOnTokenUsage = vi.fn()
    refreshTools = vi.fn()
    setContinueFromContent = vi.fn()
    updateRagToolsAvailability = vi.fn()
  },
}))

vi.mock('@/lib/custom-chat-transport', () => ({
  CustomChatTransport: class {
    updateSystemMessage = vi.fn()
    setOnTokenUsage = vi.fn()
    refreshTools = vi.fn()
    setContinueFromContent = vi.fn()
    updateRagToolsAvailability = vi.fn()
  },
}))

vi.mock('@/hooks/useAppState', () => ({
  useAppState: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ mcpToolNames: new Set(), ragToolNames: new Set() }),
}))

vi.mock('@/stores/runtime-store', () => ({
  useRuntimeStore: (selector: (state: { enabled: true }) => unknown) =>
    selector({ enabled: true }),
}))

import { useChat } from '../use-chat'
import { useChatSessions } from '@/stores/chat-session-store'

describe('useChat', () => {
  beforeEach(() => {
    h.chatInitializers.length = 0
    h.sdkOptions.length = 0
    useChatSessions.getState().clearSessions()
  })

  it('uses the persistent thread id as the AI SDK chat id', () => {
    renderHook(() => useChat({ sessionId: 'thread-uuid' }))

    expect(h.chatInitializers).toHaveLength(1)
    expect(h.chatInitializers[0]).toMatchObject({ id: 'thread-uuid' })
  })

  it('respects an explicit Runtime resume gate', () => {
    const { rerender } = renderHook(
      ({ resume }) => useChat({ sessionId: 'thread-uuid', resume }),
      { initialProps: { resume: false } }
    )

    expect(h.sdkOptions.at(-1)).toMatchObject({ resume: false })

    rerender({ resume: true })

    expect(h.sdkOptions.at(-1)).toMatchObject({ resume: true })
  })
})
