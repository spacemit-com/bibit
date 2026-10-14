import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useRuntimeStore } from '@/stores/runtime-store'
import { formatRuntimeCommandError, type RuntimeAgent } from '@/lib/runtime-contract'
import {
  canSelectRuntimeAgent,
  readSelectedRuntimeAgent,
  writeSelectedRuntimeAgent,
} from '@/lib/runtimeAgentSelection'
import i18n from '@/i18n/setup'

/** 新会话的 Agent 选择属于目标；已有会话继续使用创建时绑定的 Agent。 */
export function useRuntimeAgents(enabled: boolean) {
  const epoch = useRuntimeStore(state => state.runtimeEpoch)
  const runtimeId = useRuntimeStore(state => state.runtimeId)
  const [attempt, refresh] = useState(0)
  const [state, setState] = useState({ epoch, runtimeId, targetId: '', agents: [] as RuntimeAgent[], selectedId: '', error: '', loading: true })
  useEffect(() => {
    if (!enabled) return
    let active = true
    setState({ epoch, runtimeId, targetId: '', agents: [], selectedId: '', error: '', loading: true })
    void (async () => {
      const before = await invoke<{ targetId: string; runtimeEpoch: string }>('runtime_target_identity')
      const agents = await invoke<RuntimeAgent[]>('runtime_agents_list')
      const after = await invoke<typeof before>('runtime_target_identity')
      if (before.targetId !== after.targetId || before.runtimeEpoch !== after.runtimeEpoch) throw new Error(i18n.t('chat:agentTargetSwitched'))
      if (!before.targetId) throw new Error(i18n.t('chat:agentTargetUnavailable'))
      const saved = readSelectedRuntimeAgent(before.targetId)
      const selectedId = agents.find(agent => agent.id === saved && canSelectRuntimeAgent(agent))?.id ?? ''
      if (active) setState({ epoch, runtimeId, targetId: before.targetId, agents, selectedId, error: '', loading: false })
    })().catch(cause => { if (active) setState({ epoch, runtimeId, targetId: '', agents: [], selectedId: '', error: formatRuntimeCommandError(cause), loading: false }) })
    return () => { active = false }
  }, [enabled, epoch, runtimeId, attempt])
  const current = enabled && state.epoch === epoch && state.runtimeId === runtimeId
  const agents = current ? state.agents : []
  const selectable = agents.filter(canSelectRuntimeAgent)
  // 未挑选专家时使用默认助手：Runtime 内置专家优先，退化为唯一可用专家。
  const fallback = selectable.find(agent => agent.origin === 'system') ?? (selectable.length === 1 ? selectable[0] : undefined)
  const picked = current ? selectable.find(agent => agent.id === state.selectedId) : undefined
  const selected = picked ?? fallback
  const modelRequired = selected?.unavailableReason === 'agent_model_required'
  return {
    agents, selected, modelRequired,
    targetId: current ? state.targetId : '',
    defaultAgent: fallback,
    // 判据是“生效的是不是默认助手”，而不是“有没有存过键”：外部（Feature 宿主动作）也可能写入内置专家 ID。
    usingDefault: !picked || picked.id === fallback?.id,
    experts: agents.filter(agent => agent.id !== fallback?.id),
    reason: !enabled ? '' : !current || state.loading ? i18n.t('chat:agentsLoading') : state.error || (modelRequired ? i18n.t('chat:agentModelRequiredHint') : !state.agents.some(agent => agent.available) ? i18n.t('common:noAssistantsAvailable') : !selected ? i18n.t('chat:selectAssistant') : ''),
    select(id: string) {
      if (!current || !state.agents.some(agent => agent.id === id && canSelectRuntimeAgent(agent))) return
      setState(previous => ({ ...previous, selectedId: id }))
      writeSelectedRuntimeAgent(state.targetId, id)
    },
    useDefault() {
      if (!current) return
      setState(previous => ({ ...previous, selectedId: '' }))
      writeSelectedRuntimeAgent(state.targetId, null)
    },
    refresh: () => refresh(value => value + 1),
  }
}
