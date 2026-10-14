import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useRuntimeStore } from '@/stores/runtime-store'
import { formatRuntimeCommandError } from '@/lib/runtime-contract'

/** capabilities/skill 的原始视图（snake_case 直传）。 */
export type RuntimeSkill = {
  id: string
  name: string
  display_name: string
  description: string
  /**
   * Power 格式 v2 的展示字段（`name_zh` / `name_en` / `description_zh`）。
   * 只用于显示：`name` 仍是选择器提交与 Run 解析用的调用名。旧格式或第三方
   * Skill 没有这些字段时回退到 `display_name` / `name`。
   */
  name_zh?: string | null
  name_en?: string | null
  description_zh?: string | null
  version: string
  origin: string
  plugin_id?: string | null
  enabled?: boolean
  assignable?: boolean
  /** Preset skills are fixed on every expert, so they are never temporary. */
  preset?: boolean
  unavailable_reason?: string
}

/** 插件 id 统一归一化：缺失即空串，便于过滤；空白在展示与匹配两侧一致处理。 */
const pluginIdOf = (skill: RuntimeSkill) => (skill.plugin_id ?? '').trim()

/** 判断界面语言是否中文；非中文一律按英文取 v2 字段。 */
const isChinese = (language: string) =>
  String(language || '').toLowerCase().startsWith('zh')

/**
 * 技能名随应用语言切换；没有对应语言的 v2 名字就回退到 `name`。
 *
 * `language` 必须由调用方从 `useTranslation()` 取来传进去（不要把默认值设成
 * 模块级 i18n 单例）：那样写等于依赖一个可变的全局量，凡是不随语言重渲染的
 * 调用点都会静默停在旧语言上。
 */
export const skillLocalizedName = (skill: RuntimeSkill, language: string) => {
  const preferred = isChinese(language) ? skill.name_zh : skill.name_en
  return (preferred ?? '').trim() || skill.display_name || skill.name || skill.id
}

/** 技能描述同样按语言取；非中文界面保持模型侧原文。 */
export const skillLocalizedDescription = (skill: RuntimeSkill, language: string) => {
  const fallback = skill.description || ''
  if (!isChinese(language)) return fallback
  return (skill.description_zh ?? '').trim() || fallback
}

/** 插件技能统一按 `插件id:技能名` 展示，让用户看得见它属于哪个插件。 */
export const skillDisplayName = (skill: RuntimeSkill, language: string) => {
  const base = skillLocalizedName(skill, language)
  const pluginId = pluginIdOf(skill)
  if (!pluginId) return base
  const prefix = pluginId.toLowerCase()
  const lowered = base.toLowerCase()
  if (lowered.startsWith(`${prefix}:`) || lowered.startsWith(`${prefix}/`)) return base
  return `${pluginId}:${base}`
}

/**
 * 插件技能在目录里还能按 `插件id:技能名` 被搜到。搜索不随界面语言变化，所以这里
 * 把每个语言的名字各拼一份，不依赖"当前语言"。
 */
const skillPrefixedLabels = (skill: RuntimeSkill): string[] => {
  const pluginId = pluginIdOf(skill)
  if (!pluginId) return []
  const prefix = pluginId.toLowerCase()
  return [skill.display_name, skill.name, skill.name_zh, skill.name_en]
    .filter((value): value is string => Boolean(value))
    .map((base) => {
      const lowered = base.toLowerCase()
      return lowered.startsWith(`${prefix}:`) || lowered.startsWith(`${prefix}/`)
        ? base
        : `${pluginId}:${base}`
    })
}

/**
 * 技能 id 直接推导展示名：Runtime 的 id 是 `插件/成员`，和 `skillDisplayName`
 * 拼出的 `插件:成员` 是同一套写法，所以纯字符串推导就够了，不必为此再拉一份技能目录。
 * ponytail: 不查目录换零 IPC；需要 Runtime 的 display_name（可能本地化）时改成查 catalog。
 */
export const skillLabelFromId = (id: string) => {
  const separator = id.indexOf('/')
  return separator > 0 ? `${id.slice(0, separator)}:${id.slice(separator + 1)}` : id
}

export const skillSelectable = (skill: RuntimeSkill) =>
  skill.enabled !== false && skill.assignable !== false

/** 未命中任何一层匹配；数值越小越靠前。 */
const RANK_MISS = 4
/** 只在描述里命中：界面上只显示技能名，这一层命中得额外给出理由。 */
const RANK_DESCRIPTION = 3

/**
 * 技能目录按查询词分层：名字完全相同 → 名字前缀 → 名字包含 → 只命中描述。
 * 之前只做一遍 `includes` 扫描并保持目录顺序，短查询因此会把一堆"描述里恰好
 * 带这两个字母"的技能排在前面，真正想找的技能被压到列表末尾：例如 `/vi` 在
 * 本机 27 个技能里命中 12 个，`vibe-coder` 排最后，用户只能改成 `/vib` 才找得到。
 * 这里保证的只是"命中名字的排在只命中描述的之前"：同一层内仍是目录顺序
 * （sort 稳定），所以目录里若有别的同层命中排在前面（例如另一个 `vi*` 技能），
 * 它照样排在 `vibe-coder` 之前。要让首选结果确定，得再加一个同层次级键。
 */
export function filterRuntimeSkills(skills: RuntimeSkill[], query: string) {
  const q = query.trim().toLowerCase()
  return skills
    .filter(skillSelectable)
    .map(skill => ({ skill, rank: skillMatchRank(skill, q) }))
    .filter(item => item.rank < RANK_MISS)
    .sort((left, right) => left.rank - right.rank)
    .map(item => item.skill)
}

function skillMatchRank(skill: RuntimeSkill, query: string): number {
  const names = [skill.id, skill.name, skill.display_name, skill.name_zh, skill.name_en,
    pluginIdOf(skill), ...skillPrefixedLabels(skill)]
    .filter((value): value is string => Boolean(value))
    .map(value => value.toLowerCase())
  if (!query || names.some(name => name === query)) return 0
  if (names.some(name => name.startsWith(query))) return 1
  if (names.some(name => name.includes(query))) return 2
  // 名字与描述都把中英两份算进来，所以这里的命中集合与界面语言无关。
  const descriptions = [skill.description, skill.description_zh]
    .filter((value): value is string => Boolean(value))
    .map(value => value.toLowerCase())
  if (descriptions.some(text => text.includes(query))) return RANK_DESCRIPTION
  return RANK_MISS
}

/**
 * 查询只在这个技能的描述里命中。
 * 菜单和选择面板都只显示技能名，这类行不看描述就说不清为什么出现，渲染方据此补一行描述。
 */
export function skillMatchedOnlyByDescription(skill: RuntimeSkill, query: string) {
  const q = query.trim().toLowerCase()
  return Boolean(q) && skillMatchRank(skill, q) === RANK_DESCRIPTION
}

/** 选择器打开时拉取一次技能目录；epoch 变化（服务重启/切换）则作废重拉。 */
export function useRuntimeSkills(open: boolean) {
  const epoch = useRuntimeStore((state) => state.runtimeEpoch)
  const runtimeId = useRuntimeStore((state) => state.runtimeId)
  const [attempt, refresh] = useState(0)
  const [state, setState] = useState({
    epoch,
    runtimeId,
    skills: [] as RuntimeSkill[],
    error: '',
    loading: false,
  })
  useEffect(() => {
    if (!open) return
    let active = true
    setState({ epoch, runtimeId, skills: [], error: '', loading: true })
    void (async () => {
      const skills = await invoke<RuntimeSkill[]>('runtime_skills_list')
      if (active) setState({ epoch, runtimeId, skills, error: '', loading: false })
    })().catch((cause) => {
      if (active)
        setState({
          epoch,
          runtimeId,
          skills: [],
          error: formatRuntimeCommandError(cause),
          loading: false,
        })
    })
    return () => {
      active = false
    }
  }, [open, epoch, runtimeId, attempt])
  const current =
    open && state.epoch === epoch && state.runtimeId === runtimeId
  return {
    skills: current ? state.skills : [],
    loading: current && state.loading,
    error: current ? state.error : '',
    refresh: () => refresh((value) => value + 1),
  }
}

/**
 * 只用来给 id 换名字的目录读取（例如消息下方"引用了哪些技能"）：这些标签按条
 * 渲染，没有选择器那种"打开时拉一次"的时机，逐条调 `capabilities/skill` 会让
 * Runtime 在一次会话里反复重建整份技能目录（该接口要扫盘解析每个 SKILL.md），
 * 所以同一 Runtime 代次只发一次请求，跨组件复用。
 *
 * ponytail: 进程级缓存，切 Runtime 或请求失败才失效；要更细的失效粒度再搬进 store。
 */
let sharedSkillCatalog: {
  key: string
  request: Promise<RuntimeSkill[]>
} | null = null

/** 测试用：清空共享目录，避免用例之间互相沿用上一个 mock 的结果。 */
export const resetSharedSkillCatalog = (): void => {
  sharedSkillCatalog = null
}

export function useRuntimeSkillCatalog(enabled: boolean): RuntimeSkill[] {
  const epoch = useRuntimeStore((state) => state.runtimeEpoch)
  const runtimeId = useRuntimeStore((state) => state.runtimeId)
  const [skills, setSkills] = useState<RuntimeSkill[]>([])
  useEffect(() => {
    if (!enabled) return
    let active = true
    const key = `${runtimeId}:${epoch}`
    if (sharedSkillCatalog?.key !== key) {
      sharedSkillCatalog = {
        key,
        request: invoke<RuntimeSkill[]>('runtime_skills_list'),
      }
    }
    sharedSkillCatalog.request.then(
      (list) => {
        if (active) setSkills(list)
      },
      () => {
        // 失败不缓存：下一条带引用的消息可以重试，标签先退回 id。
        if (sharedSkillCatalog?.key === key) sharedSkillCatalog = null
      }
    )
    return () => {
      active = false
    }
  }, [enabled, epoch, runtimeId])
  return skills
}
