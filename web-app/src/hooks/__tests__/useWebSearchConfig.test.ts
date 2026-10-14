import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(async () => null as string | null),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ core: () => ({ invoke: mockInvoke }) }),
}))

vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}))

import { WEB_SEARCH_PROVIDERS, useWebSearchConfig } from '../useWebSearchConfig'

describe('useWebSearchConfig keyring seeding', () => {
  beforeEach(() => mockInvoke.mockClear())

  it('reads a keyring secret only for providers that have one', async () => {
    // Premise: at least one provider is keyless (SearXNG). An empty secret key
    // still opens a Secret Service connection on every startup.
    expect(WEB_SEARCH_PROVIDERS.some((p) => !p.secretKey)).toBe(true)

    await useWebSearchConfig.persist.rehydrate()

    const keys = mockInvoke.mock.calls.map((call) => (call[1] as { key: string }).key)
    expect(keys).toEqual(['exa-api-key', 'tavily-api-key'])
  })
})
