import { memo } from 'react'
import { useTranslation } from '@/i18n'

interface MermaidErrorComponentProps {
  error: string
  chart: string
  retry: () => void
  messageId?: string
}

/**
 * Mermaid diagram error component
 * Displays an error message when mermaid diagram fails to render
 */
function MermaidErrorComponent({
  error,
}: MermaidErrorComponentProps) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center justify-center p-6 gap-3">
      <img src="/images/jan-logo.png" alt={t('common:logoAlt')} className="h-12 w-12" />
      <p className="text-sm text-muted-foreground text-center">
        {t('common:diagramError')}
      </p>
      <p className="text-xs text-muted-foreground/60 text-center mt-1">
        {error}
      </p>
    </div>
  )
}

export const MermaidError = memo(MermaidErrorComponent)
