import { describe, expect, it, vi } from 'vitest'
import { createServiceJobsApi } from '../serviceJobs'

const terminal = {
  version: 1 as const,
  jobId: 'job-1',
  owner: { featureId: 'agent-hub' },
  serviceId: 'store',
  operationId: 'agents.upload.v1',
  idempotencyKey: 'key-1',
  status: 'succeeded' as const,
  lastSequence: 2,
  result: { agentId: 'demo' },
}

describe('service jobs Host API', () => {
  it('binds owner context and unsubscribe never cancels the job', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'feature_service_job_start') return terminal
      if (command === 'feature_service_job_events') {
        return { snapshot: terminal, events: [], hasGap: false }
      }
      return terminal
    })
    const api = createServiceJobsApi(
      'agent-hub',
      '0.3.0',
      'instance-1',
      invoke,
      1
    )

    await expect(
      api.start({
        version: 1,
        serviceId: 'store',
        operationId: 'agents.upload.v1',
        idempotencyKey: 'key-1',
        grantId: 'grant-1',
        input: {},
      })
    ).resolves.toEqual({ version: 1, job: terminal })
    const listener = vi.fn()
    const unsubscribe = api.subscribe(
      { version: 1, jobId: 'job-1', afterSequence: 0 },
      listener
    )
    await vi.waitFor(() => expect(listener).toHaveBeenCalled())
    unsubscribe()

    expect(invoke).toHaveBeenCalledWith('feature_service_job_start', {
      request: expect.objectContaining({
        featureId: 'agent-hub',
        pluginVersion: '0.3.0',
        featureInstanceToken: 'instance-1',
      }),
    })
    expect(invoke).not.toHaveBeenCalledWith(
      'feature_service_job_cancel',
      expect.anything()
    )
  })

  it('rejects unsupported start and cancel request versions before Native IPC', async () => {
    const invoke = vi.fn()
    const api = createServiceJobsApi('agent-hub', '0.3.0', 'instance-1', invoke)

    await expect(
      api.start({
        version: 2,
        serviceId: 'store',
        operationId: 'agents.upload.v1',
        idempotencyKey: 'key-1',
        grantId: 'grant-1',
        input: {},
      } as never)
    ).rejects.toThrow('Unsupported service job request version')
    await expect(
      api.cancel({ version: 2, jobId: 'job-1' } as never)
    ).rejects.toThrow('Unsupported service job request version')
    expect(invoke).not.toHaveBeenCalled()
  })
})
