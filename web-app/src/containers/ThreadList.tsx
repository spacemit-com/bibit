import {
  Loader2,
  MoreHorizontal,
  Pencil,
  ShieldAlert,
  Trash2,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useRuntimeStore } from '@/stores/runtime-store'
import { useSessionReadState } from '@/hooks/useSessionReadState'
import type { RuntimeSession } from '@/lib/runtime-contract'
import { useThreads } from '@/hooks/useThreads'
import { useIsThreadActive } from '@/hooks/useAppState'
import { useChatSessions } from '@/stores/chat-session-store'
import { useMessages } from '@/hooks/useMessages'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useEffect, useRef } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { memo, useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { RenameThreadDialog, DeleteThreadDialog } from '@/containers/dialogs'
import { cn } from '@/lib/utils'
import { useConversationAttentionStore } from '@/features/conversation/conversationAttentionStore'

function PendingApprovalBadge({ count }: { count: number }) {
  const { t } = useTranslation()
  if (count === 0) return null
  return (
    <span
      className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
      aria-label={t('trace:group.approvalNeeded', { count })}
    >
      <ShieldAlert className="size-3" />
      {count}
    </span>
  )
}

const ThreadItem = memo(
  ({
    thread,
    isMobile,
    sessionEvents,
    unread,
  }: {
    thread: Thread
    isMobile: boolean
    sessionEvents?: boolean
    unread?: boolean
  }) => {
    const deleteThread = useThreads((state) => state.deleteThread)
    const renameThread = useThreads((state) => state.renameThread)
    const { t } = useTranslation()
    const [renameOpen, setRenameOpen] = useState(false)
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)

    const serviceHub = useServiceHub()
    const getMessages = useMessages((state) => state.getMessages)
    const setMessages = useMessages((state) => state.setMessages)
    // 运行时接管会话时消息来自会话事件流，侧栏不该再去拉一遍权威历史。
    // 只看 sessionEvents 不够：store 的初值先声明了 durableSessions 却没带
    // sessionEvents，启动瞬间就会给列表里每个会话各发一次全量历史请求
    // （SpacemiT K3 实测 21 个会话并发拉取含 45179 事件的会话，把 webview 主线程卡住）。
    const durableSessions = useRuntimeStore(
      (state) => state.capabilities.durableSessions
    )

    // Use a ref to track if messages have been loaded
    const messagesLoadedRef = useRef(false)

    // Fetch messages if not loaded yet
    useEffect(() => {
      if (sessionEvents || durableSessions) return
      const currentMessages = getMessages(thread.id)

      // Initial load: no messages yet, fetch them
      if (currentMessages.length === 0 && !messagesLoadedRef.current) {
        messagesLoadedRef.current = true
        serviceHub
          .messages()
          .fetchMessages(thread.id)
          .then((fetchedMessages) => {
            // Only overwrite if the disk actually has content. A brand-new
            // thread starts empty on disk, and racing this against the
            // optimistic addMessage write was wiping the user message.
            if (fetchedMessages && fetchedMessages.length > 0) {
              setMessages(thread.id, fetchedMessages)
            }
          })
          .catch(() => {
            messagesLoadedRef.current = false
          })
        return
      }

    }, [
      thread.id,
      serviceHub,
      getMessages,
      setMessages,
      sessionEvents,
      durableSessions,
    ])

    const plainTitleForRename = useMemo(() => {
      return (thread.title || '').replace(/<span[^>]*>|<\/span>/g, '')
    }, [thread.title])

    const isAppStateActive = useIsThreadActive(thread.id)
    const isSessionStreaming = useChatSessions(
      (state) => state.sessions[thread.id]?.isStreaming ?? false
    )
    const session = thread.metadata?.runtimeSession as Partial<RuntimeSession> | undefined
    const isActive = sessionEvents ? Boolean(session?.running) : isAppStateActive || isSessionStreaming
    const legacyPendingApprovalCount = useConversationAttentionStore(
      (state) =>
        Object.values(state.pendingPermissionCounts[thread.id] ?? {}).reduce(
          (total, count) => total + count,
          0
        )
    )

    const pendingApprovalCount = sessionEvents ? (session?.waiting ? 1 : 0) : legacyPendingApprovalCount
    const status = sessionEvents ? (session?.waiting ? t('trace:permission.pending') : session?.running ? t('trace:status.running') : session?.failed ? t('trace:status.failed') : unread ? t('trace:status.completedUnread') : '') : ''
    const currentThreadId = useParams({
      strict: false,
      select: (params) => params.threadId,
    })
    const isSelected = currentThreadId === thread.id

    return (
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={isSelected}>
            <Link to="/threads/$threadId" params={{ threadId: thread.id }}>
              {isActive && (
                <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
              )}
              <span className={cn("block truncate", isSelected && "font-medium")} title={thread.title || t('common:newThread')}>{thread.title || t('common:newThread')}</span>
              <PendingApprovalBadge count={pendingApprovalCount} />
                {status && <span role="status" className="shrink-0 text-[10px] text-muted-foreground">{status}</span>}
            </Link>
          </SidebarMenuButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuAction
              showOnHover
              className="hover:bg-sidebar-foreground/8"
            >
              <MoreHorizontal />
              <span className="sr-only">{t('common:more')}</span>
            </SidebarMenuAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-48"
            side={isMobile ? 'bottom' : 'right'}
            align={isMobile ? 'end' : 'start'}
          >
            <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
              <Pencil className="size-4" />
              <span>{t('common:rename')}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setDeleteConfirmOpen(true)}
            >
              <Trash2 className="size-4" />
              <span>{t('common:delete')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <RenameThreadDialog
          thread={thread}
          plainTitleForRename={plainTitleForRename}
          onRename={renameThread}
          open={renameOpen}
          onOpenChange={setRenameOpen}
          withoutTrigger
        />
        
        <DeleteThreadDialog
          thread={thread}
          onDelete={deleteThread}
          open={deleteConfirmOpen}
          onOpenChange={setDeleteConfirmOpen}
          withoutTrigger
        />
      </SidebarMenuItem>
    )
  }
)

type ThreadListProps = {
  threads: Thread[]
}

function ThreadList({ threads }: ThreadListProps) {
  const { isMobile } = useSidebar()
  const sessionEvents = useRuntimeStore(state => state.capabilities.sessionEvents)
  const epoch = useRuntimeStore(state => state.runtimeEpoch)
  const serviceHub = useServiceHub()
  const [activeTarget, setActiveTarget] = useState<string>()
  const isUnread = useSessionReadState(activeTarget)
  useEffect(() => {
    if (!sessionEvents) { setActiveTarget(undefined); return }
    let disposed = false
    let target: string | undefined
    let unlisten: (() => void) | undefined
    let refreshing = false
    let again = false
    setActiveTarget(undefined)
    const refresh = async () => {
      if (refreshing) { again = true; return }
      refreshing = true
      try {
        do {
          again = false
          const next = await serviceHub.threads().fetchThreads()
          if (!disposed) useThreads.getState().setThreads(next.filter(thread => thread.metadata?.targetId === target))
        } while (again && !disposed)
      } finally { refreshing = false }
    }
    void (async () => {
      const identity = await invoke<{ targetId: string }>('runtime_target_identity')
      if (disposed) return
      target = identity.targetId
      setActiveTarget(target)
      unlisten = await listen<{ targetId: string; kind: string }>('runtime-session-event', ({ payload }) => {
        if (payload.targetId === target && payload.kind === 'summary') void refresh().catch(error => console.error('会话状态刷新失败', error))
      })
      if (disposed) { unlisten(); return }
      await refresh()
    })().catch(error => { if (!disposed) console.error('会话列表初始化失败', error) })
    return () => { disposed = true; unlisten?.() }
  }, [sessionEvents, epoch, serviceHub])

  const sortedThreads = useMemo(() => {
    return threads.filter(thread => !sessionEvents || (activeTarget && thread.metadata?.targetId === activeTarget)).sort((a, b) => {
      return (b.updated || 0) - (a.updated || 0)
    })
  }, [threads, sessionEvents, activeTarget])

  return (
    <>
      {sortedThreads.map((thread) => (
        <ThreadItem
          key={thread.id}
          thread={thread}
          isMobile={isMobile}
          sessionEvents={sessionEvents}
          unread={isUnread({ id: thread.id, ...(thread.metadata?.runtimeSession as object ?? {}) } as RuntimeSession)}
        />
      ))}
    </>
  )
}

export default memo(ThreadList)
