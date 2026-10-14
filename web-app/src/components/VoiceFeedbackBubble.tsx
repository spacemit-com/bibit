import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { VoiceFeedback } from '@/lib/voice-feedback'

type VoiceFeedbackBubbleProps = {
  feedback: VoiceFeedback
  /** 「重新录音」动作；没有传入就不显示按钮。 */
  onRetry?: () => void
  /** 中性提示自动收起时回调。 */
  onDismiss?: () => void
  className?: string
}

/**
 * 语音失败/提示的一句话气泡：贴着悬浮球或输入框显示，只占一行高，不挤压会话内容。
 * 颜色只区分「正常操作没听清」（中性）和「真的出错了」（错误），动作最多一个。
 */
export function VoiceFeedbackBubble({
  feedback,
  onRetry,
  onDismiss,
  className,
}: VoiceFeedbackBubbleProps) {
  const { t } = useTranslation()
  const message = feedback.literal ?? (feedback.messageKey ? t(feedback.messageKey, feedback.params) : '')
  const { autoHideMs, messageKey, literal } = feedback

  useEffect(() => {
    if (!autoHideMs || !onDismiss) return
    const timer = setTimeout(onDismiss, autoHideMs)
    return () => clearTimeout(timer)
  }, [autoHideMs, messageKey, literal, onDismiss])

  if (!message) return null

  return (
    <div
      role={feedback.tone === 'error' ? 'alert' : 'status'}
      data-tone={feedback.tone}
      className={cn(
        'flex max-w-full items-center gap-1 rounded-full border px-3 py-1 text-xs leading-5',
        feedback.tone === 'error'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-border/60 bg-muted/70 text-muted-foreground',
        className
      )}
    >
      <span className="line-clamp-2 text-center">{message}</span>
      {feedback.retryable && onRetry && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 shrink-0 px-2 text-xs"
          onClick={onRetry}
        >
          {t('chat:recordAgain')}
        </Button>
      )}
    </div>
  )
}
