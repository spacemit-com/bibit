import { useTranslation } from '@/i18n/react-i18next-compat'
export function RuntimeConversationInfo({ metadata }: { metadata?: Record<string, unknown> }) {
  const { t } = useTranslation()
  if (metadata?.runtime !== 'bianbu') return null
  const progress = metadata.progress as Record<string, unknown> | undefined
  const compression = metadata.compression as Record<string, unknown> | undefined
  const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toLocaleString() : '—'
  return <>
    {progress && typeof progress.message === 'string' && <div role="status" className="my-3 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">{progress.message}</div>}
    {compression && <div className="my-3 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground space-y-1" role="note">
      <div>{t('chat:runtimeConversation.compressed')}</div>
      <div className="tabular-nums">{count(compression.before_tokens)} → {count(compression.after_tokens)} tokens</div>
      <div>{t('chat:runtimeConversation.compressionDetails', { messages: count(compression.retained_messages), count: count(compression.compression_count) })}</div>
      {typeof compression.compression_count === 'number' && compression.compression_count >= 2 && <div>{t('chat:runtimeConversation.accuracy')}</div>}
      {compression.used_fallback === true && <div>{t('chat:runtimeConversation.fallback')}</div>}
    </div>}
  </>
}
