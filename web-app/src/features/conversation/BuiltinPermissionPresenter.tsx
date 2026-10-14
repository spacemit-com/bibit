import type { PermissionPresenterProps } from '@bibit/feature-sdk'
import { Button } from '@/components/ui/button'
import { ShieldAlertIcon } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'

export function BuiltinPermissionPresenter({
  request,
  decide,
  viewState,
}: PermissionPresenterProps) {
  const { t } = useTranslation()
  const identity = {
    runtimeInstanceId: request.runtimeInstanceId,
    runtimeId: request.runtimeId,
    runtimeEpoch: request.runtimeEpoch,
    sessionId: request.sessionId,
    threadId: request.threadId,
    runId: request.runId,
    requestId: request.requestId,
    toolCallId: request.toolCallId,
  }
  const busy =
    viewState.status === 'submitting' || viewState.status === 'resolved'

  // The one card in the trace that is allowed to interrupt. Tool, reasoning and
  // chain-of-thought all report things that already happened and stay visually
  // quiet; this one blocks the turn until the user answers, so it takes the
  // opposite treatment — a solid amber frame, a left bar to catch the eye
  // mid-scroll, and full-strength text rather than muted.
  return (
    <div
      role="group"
      aria-label={t('tools:toolApproval.needsApproval')}
      className="mt-4 space-y-3 rounded-lg border border-l-4 border-amber-500/40 border-l-amber-500 bg-amber-500/10 p-4 shadow-sm"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
        <ShieldAlertIcon className="size-4 shrink-0" />
        <span>{t('tools:toolApproval.needsApproval')}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {request.supportedDecisions.includes('allow_once') ? (
          <Button
            disabled={busy}
            size="sm"
            onClick={() =>
              void decide({ version: 1, ...identity, decision: 'allow_once' })
            }
          >
            {t('tools:toolApproval.allowOnce')}
          </Button>
        ) : null}
        {request.supportedDecisions.includes('deny') ? (
          <Button
            disabled={busy}
            size="sm"
            variant="outline"
            onClick={() =>
              void decide({
                version: 1,
                ...identity,
                decision: 'deny',
                reason: 'user-denied',
              })
            }
          >
            {t('tools:toolApproval.deny')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
