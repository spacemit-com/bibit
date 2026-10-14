import { webcrypto } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createFileTransferApi } from '../fileTransfer'

describe('file transfer Host API', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      vi.stubGlobal('crypto', webcrypto)
    }
  })

  it('binds the active feature instance and never exposes a path', async () => {
    const invoke = vi.fn().mockResolvedValue({
      version: 1,
      grantId: 'grant-1',
      direction: 'upload',
      displayName: 'sample.demo-agent',
      expiresAt: new Date(0).toISOString(),
      byteLength: 4,
    })
    const grant = await createFileTransferApi(
      'agent-hub',
      '0.3.0',
      'instance-1',
      invoke
    ).select({
      version: 1,
      serviceId: 'store',
      operationId: 'agents.upload.v1',
      direction: 'upload',
    })

    expect(invoke).toHaveBeenCalledWith('feature_file_grant_select', {
      request: expect.objectContaining({
        featureId: 'agent-hub',
        pluginVersion: '0.3.0',
        featureInstanceToken: 'instance-1',
      }),
    })
    expect(JSON.stringify(grant)).not.toContain('/')
  })

  it('rejects an unsupported request version before Native IPC', async () => {
    const invoke = vi.fn()
    const api = createFileTransferApi('agent-hub', '0.3.0', 'instance-1', invoke)

    await expect(
      api.select({
        version: 2,
        serviceId: 'store',
        operationId: 'agents.upload.v1',
        direction: 'upload',
      } as never)
    ).rejects.toThrow('Unsupported file transfer request version')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('publishes download bytes without exposing a path', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const api = createFileTransferApi('memory', '0.1.4', 'instance-1', invoke)
    const content = new TextEncoder().encode('{"memory":"ok"}')

    await api.publish({
      version: 1,
      grantId: 'grant-1',
      serviceId: 'memory',
      operationId: 'privacy.export_data',
      content,
    })

    expect(invoke).toHaveBeenCalledWith('feature_file_grant_publish', {
      request: expect.objectContaining({
        featureId: 'memory',
        pluginVersion: '0.1.4',
        featureInstanceToken: 'instance-1',
        grantId: 'grant-1',
        serviceId: 'memory',
        operationId: 'privacy.export_data',
        byteLength: content.byteLength,
      }),
    })
    const request = invoke.mock.calls[0][1].request as Record<string, unknown>
    expect(Object.keys(request).sort()).toEqual(
      [
        'byteLength',
        'contentBase64',
        'featureId',
        'featureInstanceToken',
        'grantId',
        'operationId',
        'pluginVersion',
        'serviceId',
        'sha256',
      ].sort()
    )
    expect(request.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(
      Buffer.from(request.contentBase64 as string, 'base64').equals(
        Buffer.from(content)
      )
    ).toBe(true)
  })

  it('rejects an unsupported publish version before Native IPC', async () => {
    const invoke = vi.fn()
    const api = createFileTransferApi('memory', '0.1.4', 'instance-1', invoke)

    await expect(
      api.publish({
        version: 2,
        grantId: 'grant-1',
        serviceId: 'memory',
        operationId: 'privacy.export_data',
        content: new Uint8Array(),
      } as never)
    ).rejects.toThrow('Unsupported file transfer request version')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects a publish request without a grant before Native IPC', async () => {
    const invoke = vi.fn()
    const api = createFileTransferApi('memory', '0.1.4', 'instance-1', invoke)

    await expect(
      api.publish({
        version: 1,
        grantId: '',
        serviceId: 'memory',
        operationId: 'privacy.export_data',
        content: new Uint8Array(),
      })
    ).rejects.toThrow('A file grant id is required')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('propagates a Host rejection for a publish request', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValue(new Error('grant_already_consumed'))
    const api = createFileTransferApi('memory', '0.1.4', 'instance-1', invoke)

    await expect(
      api.publish({
        version: 1,
        grantId: 'grant-1',
        serviceId: 'memory',
        operationId: 'privacy.export_data',
        content: new TextEncoder().encode('{}'),
      })
    ).rejects.toThrow('grant_already_consumed')
  })
})
