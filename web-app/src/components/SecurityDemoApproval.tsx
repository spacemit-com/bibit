import { ShieldCheckIcon } from 'lucide-react'
import { memo, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
} from '@/components/ai-elements/tool'
import { PermissionPresenterHost } from '@/features/conversation/PermissionPresenterHost'
import {
  createConversationContributionRegistry,
  type ConversationContributionRegistry,
} from '@/features/conversation/contributionRegistry'
import { securityDemoFeatureEntry } from '@/features/activeFeatureRegistry'
import {
  useSecurityDemoApprovalStore,
  type SecurityDemoApprovalEvent,
  type SecurityDemoApprovalThread,
} from '@/features/demo/securityDemoApprovalStore'
import { useConversationAttentionStore } from '@/features/conversation/conversationAttentionStore'
import {
  currentWindowSurface,
  type WindowSurface,
} from '@/lib/window-surface'

const securityDemoConversationRegistry = createConversationContributionRegistry(
  [securityDemoFeatureEntry],
  { target: 'desktop', surface: 'main' }
)

const EMPTY_THREAD: SecurityDemoApprovalThread = {
  byId: {},
  order: [],
  pendingIds: {},
}

export function SecurityDemoApproval({
  threadId,
  afterMessageId,
}: {
  threadId: string
  afterMessageId?: string
}) {
  const request = useSecurityDemoApprovalStore((state) => state.request)
  const pendingCount = useConversationAttentionStore((state) =>
    Object.values(state.pendingPermissionCounts[threadId] ?? {}).reduce(
      (total, count) => total + count,
      0
    )
  )

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7"
      aria-label="模拟安全请求"
      disabled={pendingCount > 0}
      onClick={() => request(threadId, afterMessageId)}
    >
      <ShieldCheckIcon className="size-3.5" />
      {pendingCount > 0 ? '等待审批' : '模拟安全请求'}
    </Button>
  )
}

const SecurityDemoEvent = memo(function SecurityDemoEvent({
  event,
  registry,
  surface,
}: {
  event: SecurityDemoApprovalEvent
  registry: ConversationContributionRegistry
  surface: WindowSurface
}) {
  const decide = useSecurityDemoApprovalStore((state) => state.decide)
  const pending = event.status === 'pending'
  const toolState =
    event.status === 'allowed'
      ? 'output-available'
      : event.status === 'denied'
        ? 'output-denied'
        : 'input-available'
  const title =
    event.status === 'allowed'
      ? 'read_sensitive_file · 已允许本次操作'
      : event.status === 'denied'
        ? 'read_sensitive_file · 已拒绝此次操作'
        : 'read_sensitive_file'

  return (
    <Tool
      className="rounded-xl border border-border/70 bg-card/40 px-3 py-2"
      state={toolState}
      toolCallId={event.id}
      defaultOpen={pending}
      approvalPending={pending}
    >
      <ToolHeader
        title={title}
        state={toolState}
        type="tool-read_sensitive_file"
      />
      <ToolContent title="read_sensitive_file">
        <ToolInput input={{ path: '~/.ssh/id_ed25519' }} />
        {pending && surface === 'status-popup' ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              主窗口中等待审批
            </span>
            <Button
              type="button"
              className="border"
              onClick={() => void invoke('open_main_window')}
            >
              打开主窗口
            </Button>
          </div>
        ) : pending ? (
          <PermissionPresenterHost
            request={{
              version: 1,
              runtimeInstanceId: 'security-demo-runtime:development',
              runtimeId: 'security-demo-runtime',
              runtimeEpoch: 'development',
              sessionId: event.threadId,
              threadId: event.threadId,
              runId: `security-demo:${event.threadId}:${event.id}`,
              requestId: event.id,
              toolCallId: event.id,
              action: {
                kind: 'filesystem',
                name: 'read_sensitive_file',
                summary: '读取 SSH 身份凭据 ~/.ssh/id_ed25519',
                details: { path: '~/.ssh/id_ed25519' },
              },
              supportedDecisions: ['allow_once', 'deny'],
              createdAt: event.createdAt,
              expiresAt: event.expiresAt,
            }}
            registry={registry}
            enableCustomPresenter
            manageLifecycle={false}
            decide={(decision) => decide(event.threadId, event.id, decision)}
          />
        ) : (
          <p
            className={
              event.status === 'allowed'
                ? 'mt-3 text-sm font-medium text-emerald-600 dark:text-emerald-400'
                : 'mt-3 text-sm font-medium text-destructive'
            }
            role="status"
          >
            {event.status === 'allowed' ? '已允许本次操作' : '已拒绝此次操作'}
          </p>
        )}
      </ToolContent>
    </Tool>
  )
})

export function SecurityDemoApprovalTimeline({
  threadId,
  afterMessageId,
  visibleMessageIds,
  registry = securityDemoConversationRegistry,
  surface = currentWindowSurface(),
}: {
  threadId: string
  afterMessageId?: string
  visibleMessageIds?: readonly string[]
  registry?: ConversationContributionRegistry
  surface?: WindowSurface
}) {
  const thread = useSecurityDemoApprovalStore(
    (state) => state.threads[threadId] ?? EMPTY_THREAD
  )
  const events = useMemo(() => {
    const visibleIds = new Set(visibleMessageIds)
    return thread.order
      .map((id) => thread.byId[id])
      .filter(
        (event): event is SecurityDemoApprovalEvent =>
          Boolean(event) &&
          (event.afterMessageId === afterMessageId ||
            (afterMessageId === undefined &&
              visibleMessageIds !== undefined &&
              event.afterMessageId !== undefined &&
              !visibleIds.has(event.afterMessageId)))
      )
  }, [afterMessageId, thread, visibleMessageIds])

  if (events.length === 0) return null

  return (
    <section className="mx-4 my-3 space-y-2" aria-label="安全审批演示事件">
      <div className="flex items-center gap-2 px-1 text-[11px] font-medium text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span>Security Feature · 会话事件</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      {events.map((event) => (
        <SecurityDemoEvent
          key={event.id}
          event={event}
          registry={registry}
          surface={surface}
        />
      ))}
    </section>
  )
}
