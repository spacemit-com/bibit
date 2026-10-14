import { invoke } from '@tauri-apps/api/core'
import type { FeatureServiceJobsApiV1 } from '@bibit/feature-sdk'
import type {
  ServiceJobEventBatchV1,
  ServiceJobSnapshotV1,
} from '@bibit/feature-contracts'

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export const createServiceJobsApi = (
  featureId: string,
  pluginVersion: string,
  featureInstanceToken: string,
  tauriInvoke: TauriInvoke = invoke,
  pollIntervalMs = 250
): FeatureServiceJobsApiV1 => {
  const context = { featureId, pluginVersion, featureInstanceToken }
  const events: FeatureServiceJobsApiV1['events'] = ({ jobId, afterSequence }) =>
    tauriInvoke('feature_service_job_events', {
      request: { ...context, jobId, afterSequence },
    })
  return {
    availability: (serviceId) =>
      tauriInvoke('feature_service_job_availability', {
        request: { ...context, serviceId },
      }),
    start: async ({ version, ...request }) => {
      if (version !== 1) {
        throw new Error('Unsupported service job request version')
      }
      return {
        version: 1,
        job: await tauriInvoke<ServiceJobSnapshotV1>('feature_service_job_start', {
          request: { ...context, ...request },
        }),
      }
    },
    get: (jobId) =>
      tauriInvoke('feature_service_job_get', {
        request: { ...context, jobId },
      }),
    list: (serviceId) =>
      tauriInvoke('feature_service_job_list', {
        request: { ...context, serviceId },
      }),
    events,
    cancel: ({ version, jobId }) => {
      if (version !== 1) {
        return Promise.reject(
          new Error('Unsupported service job request version')
        )
      }
      return tauriInvoke('feature_service_job_cancel', {
        request: { ...context, jobId },
      })
    },
    subscribe: ({ jobId, afterSequence }, listener) => {
      let stopped = false
      let sequence = afterSequence
      let timer: ReturnType<typeof setTimeout> | undefined
      const poll = async () => {
        try {
          const batch = (await events({
            version: 1,
            jobId,
            afterSequence: sequence,
          })) as ServiceJobEventBatchV1
          if (stopped) return
          sequence = batch.snapshot.lastSequence
          listener(batch)
          if (['succeeded', 'failed', 'cancelled'].includes(batch.snapshot.status)) {
            stopped = true
            return
          }
        } catch {
          // A later poll can recover from a transient native-command failure.
        } finally {
          if (!stopped) timer = setTimeout(poll, pollIntervalMs)
        }
      }
      void poll()
      return () => {
        stopped = true
        if (timer !== undefined) clearTimeout(timer)
      }
    },
  }
}
