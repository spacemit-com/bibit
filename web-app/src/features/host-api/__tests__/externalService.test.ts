import { describe, expect, it, vi } from 'vitest'
import {
  createExternalServiceApi,
  createExternalServiceGatewayApi,
} from '../externalService'

describe('experimental external service API', () => {
  it('applies a bounded default timeout and rejects invalid timeout values', async () => {
    vi.useFakeTimers()
    const handler = vi.fn(async () => new Promise(() => undefined))
    const api = createExternalServiceApi('memory', { wait: handler })

    const pending = api.request({
      serviceId: 'memory',
      operationId: 'wait',
      params: {},
    })
    const timedOut = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(30_000)
    await timedOut

    for (const timeoutMs of [0, -1, Number.POSITIVE_INFINITY, 300_001]) {
      await expect(
        api.request({
          serviceId: 'memory',
          operationId: 'wait',
          params: {},
          timeoutMs,
        })
      ).rejects.toMatchObject({ code: 'incompatible' })
    }
    expect(handler).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('dispatches only a registered service operation', async () => {
    const handler = vi.fn(async ({ params }) => ({ echoed: params }))
    const api = createExternalServiceApi('store', { list: handler })
    await expect(
      api.request({ serviceId: 'store', operationId: 'list', params: { page: 1 } })
    ).resolves.toEqual({ echoed: { page: 1 } })
    await expect(
      api.request({ serviceId: 'store', operationId: 'missing', params: {} })
    ).rejects.toMatchObject({ code: 'incompatible', diagnosticId: expect.any(String) })
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'list', params: { page: 1 } })
    )
  })

  it('supports timeout and caller cancellation', async () => {
    const api = createExternalServiceApi('memory', {
      wait: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    })
    await expect(
      api.request({ serviceId: 'memory', operationId: 'wait', params: {}, timeoutMs: 5 })
    ).rejects.toMatchObject({ code: 'timeout' })
    const controller = new AbortController()
    const pending = api.request({ serviceId: 'memory', operationId: 'wait', params: {}, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('rejects an already cancelled request before invoking its handler', async () => {
    const handler = vi.fn(async () => 'should not run')
    const api = createExternalServiceApi('memory', { read: handler })
    const controller = new AbortController()
    controller.abort()

    await expect(
      api.request({
        serviceId: 'memory',
        operationId: 'read',
        params: {},
        signal: controller.signal,
      })
    ).rejects.toMatchObject({
      code: 'cancelled',
      diagnosticId: expect.any(String),
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects transport and credential fields and sanitizes mapped errors', async () => {
    const api = createExternalServiceApi('security', {
      check: async () => {
        throw Object.assign(new Error('Authorization Bearer top-secret token=abc'), { status: 401 })
      },
    })
    await expect(
      api.request({ serviceId: 'security', operationId: 'check', params: { apiKey: 'secret' } })
    ).rejects.toMatchObject({ code: 'incompatible' })
    await expect(
      api.request({ serviceId: 'security', operationId: 'check', params: {} })
    ).rejects.toMatchObject({ code: 'unauthorized', message: expect.not.stringContaining('secret') })
  })

  it.each([
    [new TypeError('network token=secret'), 'offline'],
    [Object.assign(new Error('old apiKey=secret'), { status: 426 }), 'incompatible'],
    [Object.assign(new Error('down cookie=secret'), { status: 503 }), 'unavailable'],
    [new Error('secret=never expose'), 'unknown'],
  ])('maps transport failure without leaking details', async (failure, code) => {
    const failing = createExternalServiceApi('store', {
      run: async () => {
        throw failure
      },
    })
    const healthy = createExternalServiceApi('memory', {
      run: async () => 'healthy',
    })
    await expect(
      failing.request({ serviceId: 'store', operationId: 'run', params: {} })
    ).rejects.toMatchObject({
      code,
      diagnosticId: expect.any(String),
      message: expect.not.stringContaining('secret'),
    })
    await expect(
      healthy.request({ serviceId: 'memory', operationId: 'run', params: {} })
    ).resolves.toBe('healthy')
  })

  it('wraps operations in the v1 gateway envelope and unwraps the result', async () => {
    const transport = vi.fn(async (request) => ({
      protocolVersion: 1 as const,
      requestId: request.requestId,
      ok: true as const,
      result: { items: ['agent-1'] },
    }))
    const api = createExternalServiceGatewayApi(
      'store',
      transport,
      () => 'request-1'
    )

    await expect(
      api.request({
        serviceId: 'store',
        operationId: 'agents.list.v1',
        params: { limit: 20 },
        timeoutMs: 1234,
      })
    ).resolves.toEqual({ items: ['agent-1'] })
    expect(transport).toHaveBeenCalledWith(
      {
        protocolVersion: 1,
        requestId: 'request-1',
        serviceId: 'store',
        operationId: 'agents.list.v1',
        params: { limit: 20 },
        timeoutMs: 1234,
      },
      expect.any(AbortSignal)
    )
  })

  it.each(['agents.create.v1', 'agents.update.v1'])('forwards default L2 quotas to native policy for %s', async (operationId) => {
    const transport = vi.fn(async (request) => ({
      protocolVersion: 1 as const, requestId: request.requestId,
      ok: true as const, result: { saved: true },
    }))
    const api = createExternalServiceGatewayApi('runtime', transport)
    const params = {
      name: 'ResearchAssistant',
      permissions: {
        capabilities: [{ capability: 'file.read', scope: '/data', risk_level: 'L2' }],
        resource_limits: { tokens: { per_session: 20000, per_day: 100000, on_exceeded: 'pause_and_notify' } },
      },
    }
    await expect(api.request({ serviceId: 'runtime', operationId, params })).resolves.toEqual({ saved: true })
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ params }), expect.any(AbortSignal))
  })

  it('forwards provider credential business fields to native policy', async () => {
    const transport = vi.fn(async (request) => ({
      protocolVersion: 1 as const, requestId: request.requestId,
      ok: true as const, result: { saved: true },
    }))
    const api = createExternalServiceGatewayApi('runtime', transport)
    const params = { base_url: 'https://example.test/v1', api_key: 'entered-by-user', runtime: { agent_max_context_tokens: 32000 } }
    await expect(api.request({ serviceId: 'runtime', operationId: 'providers.create.v1', params })).resolves.toEqual({ saved: true })
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ params }), expect.any(AbortSignal))
  })

  it('still rejects gateway envelope overrides and non-object parameters', async () => {
    const transport = vi.fn()
    const api = createExternalServiceGatewayApi('runtime', transport)
    const request = { serviceId: 'runtime' as const, operationId: 'agents.create.v1', params: {} }
    for (const invalid of [{ ...request, headers: {} }, { ...request, params: [] }, { ...request, params: null }]) {
      await expect(api.request(invalid as typeof request)).rejects.toMatchObject({ code: 'incompatible' })
    }
    expect(transport).not.toHaveBeenCalled()
  })

  it('rejects mismatched receipts and preserves sanitized gateway errors', async () => {
    const mismatched = createExternalServiceGatewayApi(
      'security',
      async () => ({
        protocolVersion: 1,
        requestId: 'another-request',
        ok: true,
        result: {},
      }),
      () => 'request-1'
    )
    await expect(
      mismatched.request({
        serviceId: 'security',
        operationId: 'rules.list.v1',
        params: {},
      })
    ).rejects.toMatchObject({ code: 'incompatible' })

    const unavailable = createExternalServiceGatewayApi(
      'security',
      async (request) => ({
        protocolVersion: 1,
        requestId: request.requestId,
        ok: false,
        error: {
          code: 'unavailable',
          message: 'The service is unavailable',
          retryable: true,
        },
      }),
      () => 'request-2'
    )
    await expect(
      unavailable.request({
        serviceId: 'security',
        operationId: 'rules.list.v1',
        params: {},
      })
    ).rejects.toMatchObject({
      code: 'unavailable',
      message: 'The service is unavailable',
      retryable: true,
    })
  })
})
