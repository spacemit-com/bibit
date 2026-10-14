import type { RuntimeAgent } from './runtime-contract'

/**
 * Which expert the next new conversation starts with, per runtime target.
 *
 * The host owns this key. Features ask for a conversation through a host action
 * and the host writes the choice here, so nothing outside the app has to know
 * how the chat stores its selection.
 */
const storageKey = (targetId: string) => `bibit:agent:${targetId}`

/** An expert the picker would accept: usable now, or usable once a model is chosen. */
export const canSelectRuntimeAgent = (agent: RuntimeAgent) =>
  agent.available || agent.unavailableReason === 'agent_model_required'

export const readSelectedRuntimeAgent = (targetId: string): string | undefined => {
  try {
    return localStorage.getItem(storageKey(targetId)) || undefined
  } catch {
    // 存储不可用时仍允许显式选择。
    return undefined
  }
}

export const writeSelectedRuntimeAgent = (
  targetId: string,
  agentId: string | null
): void => {
  try {
    if (agentId) localStorage.setItem(storageKey(targetId), agentId)
    else localStorage.removeItem(storageKey(targetId))
  } catch {
    // 当前选择仍可使用。
  }
}
