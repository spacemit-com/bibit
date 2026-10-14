import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react'
import type {
  PermissionDecisionReceiptV1,
  PermissionDecisionV1,
  PermissionRequestV1,
} from '@bibit/feature-contracts'
import type {
  FeatureModuleV1,
  PermissionPresenterProps,
} from '@bibit/feature-sdk'
import type { ConversationRegistryContribution } from './contributionRegistry'
import {
  desktopMainConversationRegistry,
  type ConversationContributionRegistry,
} from './contributionRegistry'
import { BuiltinPermissionPresenter } from './BuiltinPermissionPresenter'
import { unwrapFeatureModule } from '@/features/host/loadFeatureModule'
import { registerFeatureLocales } from '@/i18n/setup'
import { useTranslation } from '@/i18n/react-i18next-compat'

type BoundaryProps = {
  children: ReactNode
  fallback?: ReactNode
  onError?: () => void
}

class PresenterBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    this.props.onError?.()
  }
  render() {
    return this.state.failed
      ? (this.props.fallback ?? null)
      : this.props.children
  }
}

export interface PermissionPresenterHostProps {
  request: PermissionRequestV1
  decide(decision: PermissionDecisionV1): Promise<PermissionDecisionReceiptV1>
  onDecisionError?: (error: unknown) => void
  presenter?: Pick<
    ConversationRegistryContribution,
    'key' | 'featureId' | 'contributionId' | 'load'
  >
  registry?: ConversationContributionRegistry
  enableCustomPresenter?: boolean
  builtinPresenter?: ComponentType<PermissionPresenterProps>
  timeoutMs?: number
  scheduleTimeout?: (
    callback: () => void,
    delay: number
  ) => ReturnType<typeof setTimeout>
  cancelTimeout?: (timer: ReturnType<typeof setTimeout>) => void
  manageLifecycle?: boolean
}

export function PermissionPresenterHost({
  request,
  decide,
  onDecisionError,
  presenter,
  registry = desktopMainConversationRegistry,
  enableCustomPresenter = false,
  builtinPresenter: Builtin = BuiltinPermissionPresenter,
  timeoutMs = 5 * 60_000,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
  manageLifecycle = true,
}: PermissionPresenterHostProps) {
  const { t } = useTranslation()
  const receiptsRef = useRef(new Map<string, PermissionDecisionReceiptV1>())
  const inFlightRef = useRef(new Map<string, Promise<PermissionDecisionReceiptV1>>())
  const mountedIdentitiesRef = useRef(new Set<string>())
  const decideRef = useRef(decide)
  decideRef.current = decide
  const requestId = request.requestId
  const identityKey = [
    request.runtimeInstanceId,
    request.runtimeId,
    request.runtimeEpoch,
    request.sessionId,
    request.threadId,
    request.runId,
    request.requestId,
    request.toolCallId,
  ].join('\u0000')
  const [viewStateEntry, setViewStateEntry] = useState<{
    identityKey: string
    value: PermissionPresenterProps['viewState']
  }>(() => ({ identityKey, value: { status: 'pending' } }))
  const viewState =
    viewStateEntry.identityKey === identityKey
      ? viewStateEntry.value
      : ({ status: 'pending' } as const)
  const setViewState = useCallback(
    (value: PermissionPresenterProps['viewState']) =>
      setViewStateEntry({ identityKey, value }),
    [identityKey]
  )

  const decideOnce = useCallback(
    (decision: PermissionDecisionV1): Promise<PermissionDecisionReceiptV1> => {
      const settled = receiptsRef.current.get(identityKey)
      if (settled) return Promise.resolve({ ...settled, status: 'duplicate' })
      const inFlight = inFlightRef.current.get(identityKey)
      if (inFlight) return inFlight
      setViewState({ status: 'submitting' })
      const pending = Promise.resolve(decideRef.current(decision))
        .then((receipt) => {
          const receiptMatchesDecision = [
            'runtimeInstanceId',
            'runtimeId',
            'runtimeEpoch',
            'sessionId',
            'threadId',
            'runId',
            'requestId',
            'toolCallId',
            'decision',
          ].every(
            (field) =>
              receipt[field as keyof PermissionDecisionReceiptV1] ===
              decision[field as keyof PermissionDecisionV1]
          )
          if (!receiptMatchesDecision) {
            throw new Error('Permission decision receipt identity mismatch')
          }
          const settled =
            receipt.status === 'accepted' || receipt.status === 'duplicate'
          if (settled) {
            receiptsRef.current.set(identityKey, receipt)
            setViewState({ status: 'resolved' })
          } else {
            const error = new Error(`Permission decision ${receipt.status}`)
            setViewState({ status: 'error', error: receipt.status })
            onDecisionError?.(error)
          }
          return receipt
        })
        .catch((error: unknown) => {
          setViewState({ status: 'error', error: String(error) })
          onDecisionError?.(error)
          throw error
        })
        .finally(() => inFlightRef.current.delete(identityKey))
      inFlightRef.current.set(identityKey, pending)
      // Feature presenters may intentionally ignore the returned Promise and
      // observe failures through viewState. Keep that safe without changing
      // the rejecting Promise returned to callers that do await it.
      void pending.catch(() => {})
      return pending
    },
    [identityKey, onDecisionError, setViewState]
  )

  const deny = useCallback(
    (reason: 'timed-out' | 'presenter-failed' | 'runtime-closed') => {
      void decideOnce({
        version: 1,
        runtimeInstanceId: request.runtimeInstanceId,
        runtimeId: request.runtimeId,
        runtimeEpoch: request.runtimeEpoch,
        sessionId: request.sessionId,
        threadId: request.threadId,
        runId: request.runId,
        requestId,
        toolCallId: request.toolCallId,
        decision: 'deny',
        reason,
      }).catch(() => {})
    },
    [decideOnce, request, requestId]
  )

  useEffect(() => {
    if (!manageLifecycle) return
    const mountedIdentities = mountedIdentitiesRef.current
    mountedIdentities.add(identityKey)
    const timer = scheduleTimeout(() => deny('timed-out'), timeoutMs)
    const close = () => deny('runtime-closed')
    window.addEventListener('pagehide', close)
    window.addEventListener('beforeunload', close)
    return () => {
      mountedIdentities.delete(identityKey)
      cancelTimeout(timer)
      window.removeEventListener('pagehide', close)
      window.removeEventListener('beforeunload', close)
      queueMicrotask(() => {
        if (!mountedIdentities.has(identityKey)) close()
      })
    }
  }, [identityKey, timeoutMs, scheduleTimeout, cancelTimeout, deny, manageLifecycle])

  const selectedPresenter = presenter ?? registry.getPermissionPresenter()
  const Custom = useMemo(() => {
    if (!enableCustomPresenter || !selectedPresenter) return null
    return lazy(async () => {
      const module: FeatureModuleV1 = unwrapFeatureModule(
        await selectedPresenter.load()
      )
      if (module.locales) {
        registerFeatureLocales(selectedPresenter.featureId, module.locales)
      }
      const renderer =
        module.permissionPresenters?.[selectedPresenter.contributionId]
      if (!renderer) throw new Error('Permission presenter is missing')
      return { default: renderer }
    })
  }, [enableCustomPresenter, selectedPresenter])

  const presenterProps: PermissionPresenterProps = {
    request,
    surface: 'main',
    viewState,
    decide: decideOnce,
  }
  const builtin = <Builtin {...presenterProps} />
  const unavailable = (
    <div role="alert" className="mt-3 text-xs text-destructive">
      {t('common:permissionPresenterUnavailable', {
        time: request.expiresAt,
      })}
    </div>
  )
  return (
    <PresenterBoundary
      key={identityKey}
      fallback={manageLifecycle ? undefined : unavailable}
      onError={manageLifecycle ? () => deny('presenter-failed') : undefined}
    >
      {Custom ? (
        <PresenterBoundary
          key={`${identityKey}:${selectedPresenter?.key ?? 'builtin'}`}
          fallback={builtin}
        >
          <Suspense fallback={builtin}>
            <Custom {...presenterProps} />
          </Suspense>
        </PresenterBoundary>
      ) : builtin}
    </PresenterBoundary>
  )
}
