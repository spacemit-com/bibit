import { describe, expect, it } from 'vitest'
import {
  SERVICE_JOB_LIMITS_V1,
  SERVICE_JOB_STATES_V1,
  validateServiceJobEventSequenceV1,
  type ServiceJobEventV1,
} from './service-job'

const statusEvent = (
  sequence: number,
  status: ServiceJobEventV1['status']
): ServiceJobEventV1 => ({
  version: 1,
  jobId: 'job-1',
  sequence,
  kind: 'status',
  status,
  emittedAt: '2026-08-31T00:00:00.000Z',
})

describe('Feature service jobs v1', () => {
  it('fixes the public state machine and resource limits', () => {
    expect(SERVICE_JOB_STATES_V1).toEqual([
      'queued',
      'running',
      'finalizing',
      'cancel_requested',
      'succeeded',
      'failed',
      'cancelled',
    ])
    expect(SERVICE_JOB_LIMITS_V1).toEqual({
      maxProviderStoredBytes: 512 * 1024 * 1024,
      maxEventsPerJob: 256,
      maxProgressEventsPerSecond: 10,
      defaultMaxConcurrentJobs: 1,
    })
  })

  it('accepts a monotonic event sequence with one terminal state', () => {
    const events: ServiceJobEventV1[] = [
      statusEvent(1, 'queued'),
      statusEvent(2, 'running'),
      {
        version: 1,
        jobId: 'job-1',
        sequence: 3,
        kind: 'progress',
        status: 'running',
        emittedAt: '2026-08-31T00:00:01.000Z',
        progress: { completedBytes: 8, totalBytes: 16 },
      },
      statusEvent(4, 'finalizing'),
      statusEvent(5, 'succeeded'),
    ]

    expect(validateServiceJobEventSequenceV1(events)).toEqual([])
  })

  it.each([
    {
      label: 'negative bytes',
      events: [
        {
          ...statusEvent(1, 'running'),
          kind: 'progress',
          progress: { completedBytes: -1 },
        },
      ],
      code: 'invalid-progress',
    },
    {
      label: 'non-monotonic sequence',
      events: [statusEvent(2, 'queued'), statusEvent(2, 'running')],
      code: 'non-monotonic-sequence',
    },
    {
      label: 'duplicate terminal',
      events: [statusEvent(1, 'succeeded'), statusEvent(2, 'failed')],
      code: 'duplicate-terminal',
    },
    {
      label: 'unknown state',
      events: [{ ...statusEvent(1, 'queued'), status: 'paused' }],
      code: 'invalid-status',
    },
    {
      label: 'mixed job ids',
      events: [
        statusEvent(1, 'queued'),
        { ...statusEvent(2, 'running'), jobId: 'job-2' },
      ],
      code: 'job-mismatch',
    },
    {
      label: 'unknown event kind',
      events: [{ ...statusEvent(1, 'queued'), kind: 'trace' }],
      code: 'invalid-event',
    },
  ])('rejects $label', ({ events, code }) => {
    expect(
      validateServiceJobEventSequenceV1(events as readonly unknown[]).map(
        (issue) => issue.code
      )
    ).toContain(code)
  })
})
