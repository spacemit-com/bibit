import type {
  FeatureExternalServiceApiV1,
  FeatureExternalServiceIdV1,
  FeatureExternalServiceRequestV1,
} from '@bibit/feature-sdk'
import type {
  ExternalServiceGatewayRequestV1,
  ExternalServiceGatewayResponseV1,
  FeatureServiceErrorCode,
  FeatureServiceErrorV1,
} from '@bibit/feature-contracts'
import { EXTERNAL_SERVICE_PROTOCOL_VERSION } from '@bibit/feature-contracts'

export interface ExternalServiceHandlerContext {
  params: Readonly<Record<string, unknown>>
  signal: AbortSignal
  timeoutMs: number
}

export type ExternalServiceHandler = (
  context: ExternalServiceHandlerContext
) => Promise<unknown>

export type ExternalServiceHandlers = Readonly<Record<string, ExternalServiceHandler>>

export type ExternalServiceDynamicHandler = (
  context: ExternalServiceHandlerContext & { operationId: string }
) => Promise<unknown>

export type ExternalServiceGatewayTransport = (
  request: ExternalServiceGatewayRequestV1,
  signal: AbortSignal
) => Promise<ExternalServiceGatewayResponseV1>

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000

class ExternalServiceError extends Error implements FeatureServiceErrorV1 {
  readonly version = 1 as const

  constructor(
    readonly code: FeatureServiceErrorCode,
    message: string,
    readonly diagnosticId: string,
    readonly retryable?: boolean
  ) {
    super(message)
    this.name = 'ExternalServiceError'
  }
}

const messages: Record<FeatureServiceErrorCode, string> = {
  cancelled: 'The service request was cancelled',
  offline: 'The service is offline',
  timeout: 'The service request timed out',
  unauthorized: 'The service rejected authorization',
  incompatible: 'The service request is incompatible',
  unavailable: 'The service is unavailable',
  provider_crashed: 'The service provider stopped unexpectedly',
  resource_exhausted: 'The service request exceeded a resource limit',
  unknown: 'The service request failed',
}

const diagnosticId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `feature-service-${Date.now()}-${Math.random().toString(16).slice(2)}`

const error = (code: FeatureServiceErrorCode) =>
  new ExternalServiceError(
    code,
    messages[code],
    diagnosticId(),
    code === 'offline' || code === 'timeout' || code === 'unavailable'
  )

const forbiddenKey = /authorization|headers?|tokens?|api[-_]?key|cookies?|credentials?|secrets?|url/i

const containsForbiddenTransportData = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsForbiddenTransportData)
  return Object.entries(value).some(
    ([key, nested]) =>
      forbiddenKey.test(key) || containsForbiddenTransportData(nested)
  )
}

const mapError = (cause: unknown, timedOut: boolean) => {
  if (cause instanceof ExternalServiceError) return cause
  if (timedOut) return error('timeout')
  const details = cause as { status?: number; code?: string; name?: string }
  if (details?.status === 401 || details?.status === 403) return error('unauthorized')
  if (details?.status === 426 || details?.code === 'INCOMPATIBLE') {
    return error('incompatible')
  }
  if (details?.code === 'OFFLINE' || details?.code === 'ECONNREFUSED') {
    return error('offline')
  }
  if (cause instanceof TypeError) return error('offline')
  if (details?.code === 'ETIMEDOUT' || details?.code === 'TIMEOUT') {
    return error('timeout')
  }
  if (details?.status === 503) return error('unavailable')
  if (details?.name === 'AbortError' || details?.code === 'CANCELLED') {
    return error('cancelled')
  }
  if (details?.code === 'PROVIDER_CRASHED') return error('provider_crashed')
  if (details?.code === 'RESOURCE_EXHAUSTED') return error('resource_exhausted')
  if (details?.code === 'UNAVAILABLE') {
    return error('unavailable')
  }
  return error('unknown')
}

const createValidatedExternalServiceApi = <
  TServiceId extends FeatureExternalServiceIdV1,
>(
  serviceId: TServiceId,
  handlers: ExternalServiceHandlers | ExternalServiceDynamicHandler,
  validateParams: (params: unknown) => boolean
): FeatureExternalServiceApiV1<TServiceId> => ({
  async request<TResult = unknown>(
    input: FeatureExternalServiceRequestV1<TServiceId>
  ): Promise<TResult> {
    const allowedKeys = new Set([
      'serviceId',
      'operationId',
      'params',
      'timeoutMs',
      'signal',
    ])
    if (
      input.serviceId !== serviceId ||
      Object.keys(input).some((key) => !allowedKeys.has(key)) ||
      !validateParams(input.params)
    ) {
      throw error('incompatible')
    }
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (
      !Number.isFinite(timeoutMs) ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw error('incompatible')
    }
    const handler =
      typeof handlers === 'function' ? handlers : handlers[input.operationId]
    if (!handler) throw error('incompatible')

    const controller = new AbortController()
    let timedOut = false
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(controller.signal.reason),
        { once: true }
      )
    })
    const cancel = () => controller.abort(new DOMException('Cancelled', 'AbortError'))
    input.signal?.addEventListener('abort', cancel, { once: true })
    if (input.signal?.aborted) cancel()
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('Timed out', 'TimeoutError'))
    }, timeoutMs)
    try {
      if (controller.signal.aborted) return await aborted
      return (await Promise.race([
        typeof handlers === 'function'
          ? handler({
              operationId: input.operationId,
              params: input.params,
              signal: controller.signal,
              timeoutMs,
            })
          : handler({
              operationId: input.operationId,
              params: input.params,
              signal: controller.signal,
              timeoutMs,
            }),
        aborted,
      ])) as TResult
    } catch (cause) {
      throw mapError(cause, timedOut)
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', cancel)
    }
  },
})

export const createExternalServiceApi = <
  TServiceId extends FeatureExternalServiceIdV1,
>(
  serviceId: TServiceId,
  handlers: ExternalServiceHandlers | ExternalServiceDynamicHandler
): FeatureExternalServiceApiV1<TServiceId> =>
  createValidatedExternalServiceApi(
    serviceId,
    handlers,
    (params) => !containsForbiddenTransportData(params)
  )

export const createExternalServiceGatewayApi = <
  TServiceId extends FeatureExternalServiceIdV1,
>(
  serviceId: TServiceId,
  transport: ExternalServiceGatewayTransport,
  createRequestId = diagnosticId
): FeatureExternalServiceApiV1<TServiceId> =>
  createValidatedExternalServiceApi(
    serviceId,
    async ({ operationId, params, signal, timeoutMs }) => {
      const requestId = createRequestId()
      const response = await transport(
        {
          protocolVersion: EXTERNAL_SERVICE_PROTOCOL_VERSION,
          requestId,
          serviceId,
          operationId,
          params,
          timeoutMs,
        },
        signal
      )
      if (
        response.protocolVersion !== EXTERNAL_SERVICE_PROTOCOL_VERSION ||
        response.requestId !== requestId
      ) {
        throw error('incompatible')
      }
      if (!response.ok) throw error(response.error.code)
      return response.result
    },
    // Only the native gateway has the installed, operation-scoped business
    // parameter policy. It checks credentials and quota objects before dispatch.
    (params) => Boolean(params) && typeof params === 'object' && !Array.isArray(params)
  )

export const createServiceApi = createExternalServiceApi
export const createServiceGatewayApi = createExternalServiceGatewayApi
