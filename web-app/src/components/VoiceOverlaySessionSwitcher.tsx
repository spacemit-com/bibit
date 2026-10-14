import { useThreads } from '@/hooks/useThreads'
import { useRuntimeStore } from '@/stores/runtime-store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Check, ChevronDown, MessageSquarePlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * 语音浮窗会话切换器
 * 允许用户选择将语音输入发送到哪个会话
 */
export function VoiceOverlaySessionSwitcher() {
  const { t } = useTranslation()
  const { threads, currentThreadId, setCurrentThreadId } = useThreads()
  const runtimeEnabled = useRuntimeStore((state) => state.enabled)
  const navigate = useNavigate()

  // 获取所有可用会话
  const availableThreads = Object.values(threads)
    .filter(thread => {
      // Runtime 模式下只显示 Runtime 会话
      if (runtimeEnabled) {
        return thread.metadata?.targetId !== undefined
      }
      // 本地模式显示所有非 Runtime 会话
      return thread.metadata?.targetId === undefined
    })
    .sort((a, b) => {
      // 按更新时间倒序
      return b.updated - a.updated
    })
    .slice(0, 10) // 只显示最近 10 个

  const currentThread = currentThreadId ? threads[currentThreadId] : undefined
  const displayTitle = currentThread?.title || t('chat:newConversation')

  // 直接嵌进浮窗标题栏：会话名就是窗口标题，点击即切换发送目标。
  // 单独占一整行带边框的下拉框在 460px 浮窗里太重，也把「当前会话」说两遍。
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('chat:voiceInputTarget', { title: displayTitle })}
          title={t('chat:voiceInputTarget', { title: displayTitle })}
          className="h-6 min-w-0 max-w-[168px] gap-1 px-1.5 font-normal text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
        >
          <span className="truncate text-xs">{displayTitle}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[280px]">
        {/* 新建对话选项 */}
        <DropdownMenuItem
          onSelect={() => {
            setCurrentThreadId(undefined)
            void navigate({ to: route.statusPopup, replace: true })
          }}
          className={cn(
            'flex items-center gap-2',
            !currentThreadId && 'bg-accent'
          )}
        >
          <MessageSquarePlus className="size-4 shrink-0" />
          <span className="flex-1">{t('chat:newConversation')}</span>
          {!currentThreadId && <Check className="size-4 shrink-0" />}
        </DropdownMenuItem>

        {availableThreads.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
          {t('chat:recentSessions')}
            </div>
          </>
        )}

        {/* 最近会话列表 */}
        {availableThreads.map((thread) => (
          <DropdownMenuItem
            key={thread.id}
            onSelect={() => {
              setCurrentThreadId(thread.id)
              void navigate({
                to: route.threadsDetail,
                params: { threadId: thread.id },
                replace: true,
              })
            }}
            className={cn(
              'flex items-center gap-2',
              currentThreadId === thread.id && 'bg-accent'
            )}
          >
            <span className="flex-1 truncate">{thread.title}</span>
            {currentThreadId === thread.id && (
              <Check className="size-4 shrink-0" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
