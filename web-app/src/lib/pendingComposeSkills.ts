import type { RuntimeSkill } from '@/hooks/useRuntimeSkills'

/**
 * 插件经 `conversation.compose` 预置的临时技能。
 *
 * 这是一次性交接：宿主动作写入，新会话输入框消费后立即清空。只用进程内变量，
 * 因为写入与消费之间只有一次同窗口同步导航；失败、过期或换目标都不会留下残留。
 * ponytail: 进程内已够用；真要跨 WebView 重载存活再换成 localStorage 键。
 */
type StagedComposeSkills = { targetId: string; skills: RuntimeSkill[] }

let staged: StagedComposeSkills | null = null

export const stageComposeSkills = (targetId: string, skills: RuntimeSkill[]): void => {
  staged = { targetId, skills }
}

/** 取走属于该目标的预置技能；取走即清，目标不符时原样保留。 */
export const takeComposeSkills = (targetId: string): RuntimeSkill[] => {
  if (!staged || staged.targetId !== targetId) return []
  const { skills } = staged
  staged = null
  return skills
}

export const clearComposeSkills = (): void => {
  staged = null
}
