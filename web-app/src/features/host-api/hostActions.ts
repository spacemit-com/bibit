import { invoke } from '@tauri-apps/api/core'
import type { FeatureHostActionApiV1 } from '@bibit/feature-sdk'
import type {
  FeatureHostActionErrorCodeV1,
  FeatureHostActionResultV1,
  FeatureResourceRefV1,
} from '@bibit/feature-contracts'
import { canSelectRuntimeAgent, writeSelectedRuntimeAgent } from '@/lib/runtimeAgentSelection'
import { skillSelectable, type RuntimeSkill } from '@/hooks/useRuntimeSkills'
import { stageComposeSkills } from '@/lib/pendingComposeSkills'
import { usePrompt } from '@/hooks/usePrompt'
import { useThreads } from '@/hooks/useThreads'
import type { RuntimeAgent } from '@/lib/runtime-contract'
import type { FeatureNavigate } from '@/features/host/registry'
import i18n from '@/i18n/setup'

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

interface RuntimeTargetIdentity {
  targetId: string
  runtimeEpoch: string
}

export interface HostActionContext {
  readonly navigate: FeatureNavigate
}

/** 预置文本上限对齐宿主既有输入通道（Runtime 侧同为 16_000 字符）。 */
const MAX_COMPOSE_PROMPT_CHARS = 16_000
/** 技能数上限对齐 Runtime 的 skill_ids 限制。 */
const MAX_COMPOSE_SKILLS = 100

const rejected = (
  code: FeatureHostActionErrorCodeV1,
  message: string,
  retryable?: boolean
): FeatureHostActionResultV1 => ({
  status: 'rejected',
  error: { code, message, ...(retryable === undefined ? {} : { retryable }) },
})

/**
 * Resolves a Feature's opaque reference into something the host can act on.
 * Features never pass host routes or chat internals; they name a resource and
 * the host decides what that means.
 */
const resolveTargetAgentId = (
  target: FeatureResourceRefV1 | undefined
): { agentId?: string; rejection?: FeatureHostActionResultV1 } => {
  if (!target) return {}
  if (target.namespace !== 'runtime' || target.type !== 'agent' || !target.id) {
    return {
      rejection: rejected(
        'INVALID_INPUT',
        `Unsupported conversation target: ${target.namespace}/${target.type}`
      ),
    }
  }
  return { agentId: target.id }
}

/** 技能引用只认 `runtime/skill`；重复 id 只算一次，免得同一技能在输入框里排两遍。 */
const resolveTargetSkills = (
  skills: FeatureResourceRefV1[] | undefined
): { skillIds?: string[]; rejection?: FeatureHostActionResultV1 } => {
  if (!skills) return {}
  const skillIds: string[] = []
  for (const skill of skills) {
    if (skill.namespace !== 'runtime' || skill.type !== 'skill' || !skill.id) {
      return {
        rejection: rejected(
          'INVALID_INPUT',
          `Unsupported skill reference: ${skill.namespace}/${skill.type}`
        ),
      }
    }
    if (!skillIds.includes(skill.id)) skillIds.push(skill.id)
  }
  if (skillIds.length > MAX_COMPOSE_SKILLS) {
    return { rejection: rejected('INVALID_INPUT', i18n.t('chat:composeSkillLimit')) }
  }
  return { skillIds }
}

/** 空白文本等同没给：不写草稿，也就不必触发草稿保护。 */
const resolveComposePrompt = (
  prompt: string | undefined
): { prompt?: string; rejection?: FeatureHostActionResultV1 } => {
  if (prompt === undefined) return {}
  if (typeof prompt !== 'string' || prompt.length > MAX_COMPOSE_PROMPT_CHARS) {
    return { rejection: rejected('INVALID_INPUT', i18n.t('chat:composePromptTooLong')) }
  }
  const trimmed = prompt.trim()
  return trimmed ? { prompt: trimmed } : {}
}

export const createHostActionsApi = (
  context: HostActionContext,
  tauriInvoke: TauriInvoke = invoke
): FeatureHostActionApiV1 => ({
  async invoke(action, input) {
    if (action === 'conversation.create') {
      return createConversation(input, context, tauriInvoke)
    }
    if (action === 'conversation.compose') {
      return composeConversation(input, context, tauriInvoke)
    }
    return rejected('UNSUPPORTED', `Unknown host action: ${String(action)}`)
  },
})

const createConversation = async (
  input: { target?: FeatureResourceRefV1 } | undefined,
  context: HostActionContext,
  tauriInvoke: TauriInvoke
): Promise<FeatureHostActionResultV1> => {
  const resolved = resolveTargetAgentId(input?.target)
  if (resolved.rejection) return resolved.rejection
  try {
    if (resolved.agentId) {
      const before = await tauriInvoke<RuntimeTargetIdentity>('runtime_target_identity')
      if (!before.targetId) {
        return rejected('FAILED', i18n.t('chat:agentTargetUnavailable'))
      }
      const agents = await tauriInvoke<RuntimeAgent[]>('runtime_agents_list')
      const after = await tauriInvoke<RuntimeTargetIdentity>('runtime_target_identity')
      if (
        before.targetId !== after.targetId ||
        before.runtimeEpoch !== after.runtimeEpoch
      ) {
        return rejected('FAILED', i18n.t('chat:agentTargetSwitched'), true)
      }
      const selectable = agents.some(
        (agent) => agent.id === resolved.agentId && canSelectRuntimeAgent(agent)
      )
      if (!selectable) {
        return rejected('INVALID_INPUT', i18n.t('common:noAssistantsAvailable'))
      }
      writeSelectedRuntimeAgent(before.targetId, resolved.agentId)
    }
    await context.navigate({ to: '/', replace: false })
    return { status: 'completed' }
  } catch (cause) {
    return rejected(
      'FAILED',
      cause instanceof Error ? cause.message : String(cause)
    )
  }
}

/**
 * `conversation.compose` 的宿主实现：校验完全通过后才写状态，最后才导航。
 * 它只预置内容，从不发送——发送永远是用户在输入框里的动作。
 */
const composeConversation = async (
  input: {
    target?: FeatureResourceRefV1
    skills?: FeatureResourceRefV1[]
    prompt?: string
  } | undefined,
  context: HostActionContext,
  tauriInvoke: TauriInvoke
): Promise<FeatureHostActionResultV1> => {
  const target = resolveTargetAgentId(input?.target)
  if (target.rejection) return target.rejection
  const skills = resolveTargetSkills(input?.skills)
  if (skills.rejection) return skills.rejection
  const prompt = resolveComposePrompt(input?.prompt)
  if (prompt.rejection) return prompt.rejection

  // 只保护无处安放的草稿：会话草稿按会话落盘（`bibit:session-draft:*`），覆盖后切回
  // 还能恢复；首页新会话的草稿只活在内存里，覆盖就是永久丢失。
  if (
    prompt.prompt &&
    usePrompt.getState().prompt.trim() &&
    !useThreads.getState().currentThreadId
  ) {
    return rejected('FAILED', i18n.t('chat:composeDraftOccupied'), true)
  }

  try {
    let targetId = ''
    const stagedSkills: RuntimeSkill[] = []
    if (target.agentId || skills.skillIds?.length) {
      const before = await tauriInvoke<RuntimeTargetIdentity>('runtime_target_identity')
      if (!before.targetId) {
        return rejected('FAILED', i18n.t('chat:agentTargetUnavailable'))
      }
      if (target.agentId) {
        const agents = await tauriInvoke<RuntimeAgent[]>('runtime_agents_list')
        const selectable = agents.some(
          (agent) => agent.id === target.agentId && canSelectRuntimeAgent(agent)
        )
        if (!selectable) {
          return rejected('INVALID_INPUT', i18n.t('common:noAssistantsAvailable'))
        }
      }
      if (skills.skillIds?.length) {
        const catalog = await tauriInvoke<RuntimeSkill[]>('runtime_skills_list')
        for (const skillId of skills.skillIds) {
          const skill = catalog.find((item) => item.id === skillId)
          if (!skill || !skillSelectable(skill)) {
            return rejected(
              'INVALID_INPUT',
              i18n.t('chat:composeSkillUnavailable', { id: skillId })
            )
          }
          stagedSkills.push(skill)
        }
      }
      const after = await tauriInvoke<RuntimeTargetIdentity>('runtime_target_identity')
      if (
        before.targetId !== after.targetId ||
        before.runtimeEpoch !== after.runtimeEpoch
      ) {
        return rejected('FAILED', i18n.t('chat:agentTargetSwitched'), true)
      }
      targetId = before.targetId
    }
    if (target.agentId) writeSelectedRuntimeAgent(targetId, target.agentId)
    if (stagedSkills.length > 0) stageComposeSkills(targetId, stagedSkills)
    if (prompt.prompt) usePrompt.getState().setPrompt(prompt.prompt)
    await context.navigate({ to: '/', replace: false })
    return { status: 'completed' }
  } catch (cause) {
    return rejected(
      'FAILED',
      cause instanceof Error ? cause.message : String(cause)
    )
  }
}
