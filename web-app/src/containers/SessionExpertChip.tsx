import { Bot } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useRuntimeAgents } from '@/hooks/useRuntimeAgents'

/**
 * 会话头部常驻的「当前专家」。只读：专家在会话创建时绑定到 `thread.model`，
 * 会话内不做切换（换专家等于换一个会话）。取不到专家目录时回落显示 agent id，
 * 让「这个会话在跟谁说话」永远有答案。
 */
export function SessionExpertChip({ agentId, enabled }: { agentId: string; enabled: boolean }) {
  const { t } = useTranslation()
  const { agents } = useRuntimeAgents(enabled && agentId.length > 0)
  if (!enabled || !agentId) return null
  const agent = agents.find(item => item.id === agentId)
  const name = agent?.zhName || agent?.name || agentId
  return (
    <span
      data-testid="session-expert-chip"
      title={t('chat:sessionExpertTooltip', { name })}
      className="flex min-w-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
    >
      <Bot size={13} aria-hidden className="shrink-0" />
      <span className="truncate" aria-label={t('chat:sessionExpertAria', { name })}>{name}</span>
    </span>
  )
}
