import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusPopupButton } from '@/components/StatusPopupButton'
import { CliHandoffButton } from '@/components/CliHandoffButton'
import {
  RUNTIME_EVENT_NAME,
  formatRuntimeCommandError,
  parseRuntimeEventEnvelope,
  parseRuntimeSnapshot,
  type RuntimeCapabilities,
  type RuntimeDescriptor,
  type RuntimeStatus,
} from '@/lib/runtime-contract'
import { RUNTIME_ENABLED, useRuntimeStore } from '@/stores/runtime-store'
import {
  applyRuntimePermissionEnvelope,
  applyRuntimePermissionSnapshot,
} from '@/features/conversation/runtimePermissionController'
import {
  currentWindowSurface,
  shouldStopRuntimeOnPageHide,
} from '@/lib/window-surface'
import { useTranslation } from '@/i18n'

type TFunction = (key: string, options?: Record<string, unknown>) => string

const statusLabel = (status: RuntimeStatus, name: string, t: TFunction) =>
  ({
    stopped: t('common:runtimeStatus.disconnected', { name }),
    checking: t('common:runtimeStatus.checking', { name }),
    starting: t('common:runtimeStatus.starting', { name }),
    ready: t('common:runtimeStatus.connected', { name }),
    stopping: t('common:runtimeStatus.disconnected', { name }),
    failed: t('common:runtimeStatus.failed', { name }),
  })[status]

const LazySecurityDemoApproval = BIBIT_SECURITY_DEMO
  ? lazy(async () => {
      const module = await import('@/components/SecurityDemoApproval')
      return { default: module.SecurityDemoApproval }
    })
  : undefined

function HermesRuntimeControls({ threadId }: { threadId?: string }) {
  const { t } = useTranslation()
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const status = useRuntimeStore((state) => state.status)
  const runtimeId = useRuntimeStore((state) => state.runtimeId)
  const capabilities =
    useRuntimeStore((state) => state.capabilities) ?? {
      durableSessions: false,
      detachedRuns: false,
      replayableEvents: false,
      runtimeOwnedApprovals: false,
    }
  const storedRuntimes = useRuntimeStore((state) => state.availableRuntimes)
  const availableRuntimes = Array.isArray(storedRuntimes)
    ? storedRuntimes
    : []
  const applyEnvelope = useRuntimeStore((state) => state.applyEnvelope)
  const applySnapshot = useRuntimeStore((state) => state.applySnapshot)
  const applyCapabilities = useRuntimeStore((state) => state.applyCapabilities)
  const applyAvailableRuntimes = useRuntimeStore(
    (state) => state.applyAvailableRuntimes
  )
  const runtimeName =
    availableRuntimes.find((item) => item.id === runtimeId)?.displayName ??
    (runtimeId === 'bianbu' ? 'Bianbu Runtime' : 'Hermes')

  const refreshCapabilities = useCallback(async () => {
    const { runtimeId, runtimeEpoch } = useRuntimeStore.getState()
    if (!runtimeId) return
    try {
      const next = (await invoke('runtime_capabilities')) as RuntimeCapabilities
      applyCapabilities(next, { runtimeId, runtimeEpoch })
    } catch {
      // The status UI remains the source of truth when capabilities are unavailable.
    }
  }, [applyCapabilities])

  const discoverRuntimes = useCallback(async () => {
    try {
      const runtimes = (await invoke(
        'runtime_discover'
      )) as RuntimeDescriptor[]
      applyAvailableRuntimes(runtimes)
    } catch {
      // The active Runtime can still be started below; discovery is advisory.
    }
  }, [applyAvailableRuntimes])

  const startRuntime = useCallback(async () => {
    try {
      const snapshot = parseRuntimeSnapshot(await invoke('runtime_start'))
      applyRuntimePermissionSnapshot(snapshot)
      applySnapshot(snapshot)
      await refreshCapabilities()
    } catch (error) {
      useRuntimeStore.setState({
        status: 'failed',
        message: formatRuntimeCommandError(error),
      })
    }
  }, [applySnapshot, refreshCapabilities])

  useEffect(() => {
    let disposed = false
    let unlisten: UnlistenFn | undefined

    void (async () => {
      try {
        const stopListening = await listen(RUNTIME_EVENT_NAME, ({ payload }) => {
          try {
            const envelope = parseRuntimeEventEnvelope(payload)
            applyRuntimePermissionEnvelope(envelope)
            applyEnvelope(envelope)
          } catch (error) {
            useRuntimeStore.setState({
              status: 'failed',
              message:
                error instanceof Error ? error.message : String(error),
            })
          }
        })

        if (disposed) {
          stopListening()
          return
        }

        unlisten = stopListening
        await discoverRuntimes()
        await startRuntime()
      } catch (error) {
        if (!disposed) {
          useRuntimeStore.setState({
            status: 'failed',
            message:
              error instanceof Error ? error.message : String(error),
          })
        }
      }
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [applyEnvelope, connectionAttempt, discoverRuntimes, startRuntime])

  useEffect(() => {
    if (
      !shouldStopRuntimeOnPageHide(
        currentWindowSurface(),
        capabilities.durableSessions
      )
    ) return
    let stopping = false
    const stopRuntime = () => {
      if (stopping) return
      stopping = true
      void invoke('runtime_stop').catch(() => {})
    }
    window.addEventListener('pagehide', stopRuntime)
    window.addEventListener('beforeunload', stopRuntime)
    return () => {
      window.removeEventListener('pagehide', stopRuntime)
      window.removeEventListener('beforeunload', stopRuntime)
    }
  }, [capabilities.durableSessions])

  return (
    <>
      <span className="truncate text-sm font-medium">
        {statusLabel(status, runtimeName, t)}
      </span>
      {status === 'failed' ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('common:runtimeRetryConnection', { name: runtimeName })}
          title={t('common:runtimeRetryConnection', { name: runtimeName })}
          onClick={() => setConnectionAttempt((attempt) => attempt + 1)}
        >
          <RotateCw className="size-4" />
        </Button>
      ) : null}
      {IS_TAURI ? <StatusPopupButton /> : null}
      {IS_TAURI ? <CliHandoffButton sessionId={threadId} /> : null}
    </>
  )
}

interface RuntimeControlsContentProps {
  runtime?: ReactNode
  securityDemo?: ReactNode
}

export function RuntimeControlsContent({
  runtime,
  securityDemo,
}: RuntimeControlsContentProps) {
  if (!runtime && !securityDemo) return null

  return (
    <div className="relative z-50 flex min-w-0 items-center gap-2">
      {runtime}
      {securityDemo}
    </div>
  )
}

export function RuntimeControls({
  threadId,
  afterMessageId,
}: {
  threadId?: string
  afterMessageId?: string
} = {}) {
  return (
    <RuntimeControlsContent
      runtime={
        RUNTIME_ENABLED ? <HermesRuntimeControls threadId={threadId} /> : undefined
      }
      securityDemo={
        BIBIT_SECURITY_DEMO && LazySecurityDemoApproval && threadId ? (
          <Suspense fallback={null}>
            <LazySecurityDemoApproval
              threadId={threadId}
              afterMessageId={afterMessageId}
            />
          </Suspense>
        ) : undefined
      }
    />
  )
}
