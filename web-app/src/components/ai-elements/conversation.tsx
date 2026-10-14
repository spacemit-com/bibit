import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { IconArrowDown } from '@tabler/icons-react'
import type { ComponentProps } from 'react'
import { useCallback, memo } from 'react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'

export type ConversationProps = ComponentProps<typeof StickToBottom>

export const Conversation = memo(({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn('relative flex-1 overflow-y-hidden', className)}
    // resize/initial="instant": streamed deltas (every ~250ms) move the scroll
    // position in one jump instead of a spring animation. The spring never
    // converges between deltas, so content visibly "undulates" (jitter) —
    // instantaneous repositioning keeps the viewport stable between deltas.
    //
    // `initial` matters too, not just `resize`: use-stick-to-bottom applies
    // `initial` on the *first* content resize (previousHeight === undefined) and
    // only `resize` afterwards. That first resize is exactly when the thinking
    // card goes from an empty header to its first reasoning delta — leaving
    // `initial="smooth"` made that one growth animate with the spring, which is
    // the "layout jumps up then back down" the user sees the moment thinking
    // starts. Instant on both paths keeps it pinned with no bounce.
    initial="instant"
    resize="instant"
    role="log"
    {...props}
  />
))

Conversation.displayName = 'Conversation'

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>

export const ConversationContent = memo(({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content
    className={cn('flex flex-col gap-x-8 gap-y-2 px-2', className)}
    {...props}
  />
))

ConversationContent.displayName = 'ConversationContent'

export type ConversationEmptyStateProps = ComponentProps<'div'> & {
  title?: string
  description?: string
  icon?: React.ReactNode
}

export const ConversationEmptyState = ({
  className,
  title,
  description,
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => {
  const { t } = useTranslation()
  const resolvedTitle = title ?? t('common:noMessagesYet')
  const resolvedDescription = description ?? t('common:startConversationHint')

  return (
    <div
      className={cn(
        'flex size-full flex-col items-center justify-center gap-3 p-8 text-center',
        className
      )}
      {...props}
    >
      {children ?? (
        <>
          {icon && <div className="text-muted-foreground">{icon}</div>}
          <div className="space-y-1">
            <h3 className="font-medium text-sm">{resolvedTitle}</h3>
            {resolvedDescription && (
              <p className="text-muted-foreground text-sm">
                {resolvedDescription}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export type ConversationScrollButtonProps = ComponentProps<typeof Button>

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom()
  }, [scrollToBottom])

  return (
    !isAtBottom && (
      <Button
        className={cn(
          'absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full',
          className
        )}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <IconArrowDown className="size-4" />
      </Button>
    )
  )
}
