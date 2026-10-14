import { describe, expect, it } from 'vitest'

import {
  filterRuntimeSkills,
  skillDisplayName,
  skillLabelFromId,
  skillLocalizedDescription,
  skillLocalizedName,
  skillMatchedOnlyByDescription,
  type RuntimeSkill,
} from '../useRuntimeSkills'

const skill = (id: string, extra: Partial<RuntimeSkill> = {}): RuntimeSkill => ({
  id, name: id, display_name: id, description: '', version: '1', origin: 'standalone', ...extra,
})

const pluginSkill: RuntimeSkill = {
  id: 'spacemit-power/markdown-maker',
  name: 'markdown-maker',
  display_name: 'PDF 转 Markdown',
  description: '把 PDF 转成 Markdown',
  version: '0.7.0',
  origin: 'plugin',
  plugin_id: 'spacemit-power',
  enabled: true,
  assignable: true,
}

const standaloneSkill: RuntimeSkill = {
  id: 'receiving-code-review',
  name: 'receiving-code-review',
  display_name: '代码审查',
  description: '按清单审查改动',
  version: '1.0.0',
  origin: 'standalone',
  plugin_id: null,
  enabled: true,
  assignable: true,
}

describe('runtime skill labels', () => {
  it('把插件技能标成 插件id:技能名', () => {
    expect(skillDisplayName(pluginSkill, 'zh-CN')).toBe('spacemit-power:PDF 转 Markdown')
    expect(skillDisplayName(standaloneSkill, 'zh-CN')).toBe('代码审查')
  })

  it('display_name 已经带插件前缀时不重复拼接', () => {
    expect(
      skillDisplayName({ ...pluginSkill, display_name: 'spacemit-power/PDF' }, 'zh-CN')
    ).toBe('spacemit-power/PDF')
    expect(
      skillDisplayName({ ...pluginSkill, display_name: 'spacemit-power:PDF' }, 'zh-CN')
    ).toBe('spacemit-power:PDF')
  })

  it('插件 id 带空白、前缀大小写不同时，标签同样不重复拼接', () => {
    expect(
      skillDisplayName({ ...pluginSkill, display_name: 'Spacemit-Power:PDF' }, 'zh-CN')
    ).toBe('Spacemit-Power:PDF')
    expect(
      skillDisplayName({ ...pluginSkill, plugin_id: '  spacemit-power  ' }, 'zh-CN')
    ).toBe('spacemit-power:PDF 转 Markdown')
  })

  it('/spacemit 能搜到该插件的技能，且仍按限定 id 提交', () => {
    const skills = [pluginSkill, standaloneSkill]
    expect(filterRuntimeSkills(skills, 'spacemit')).toEqual([pluginSkill])
    expect(filterRuntimeSkills(skills, 'spacemit-power').map(item => item.id)).toEqual([
      'spacemit-power/markdown-maker',
    ])
    expect(filterRuntimeSkills(skills, 'markdown-maker')).toEqual([pluginSkill])
    expect(filterRuntimeSkills(skills, '代码审查')).toEqual([standaloneSkill])
  })

  it('未启用或不可选的技能不进入选择器', () => {
    expect(
      filterRuntimeSkills([{ ...pluginSkill, enabled: false }], 'spacemit')
    ).toEqual([])
    expect(
      filterRuntimeSkills([{ ...pluginSkill, assignable: false }], 'spacemit')
    ).toEqual([])
  })
})

/**
 * 目录排序回归：短查询必须把"命中名字"的技能排在"只在描述里出现"的前面，
 * 并且同名精确命中优先。这几条在加入插件前缀标签时被漏掉了，重新补回来，
 * 免得 `/vi` 这种短词又退回按目录顺序返回一堆描述命中。
 */
const rankingCatalog = [
  skill('appcli-router', { display_name: 'AppCLI Artifact Router', description: 'Produce deliverable files by driving app CLIs.' }),
  skill('frontend-design', { description: 'Visual design guidance for new UI.' }),
  skill('receiving-code-review', { description: 'Use when receiving review feedback.' }),
  skill('requesting-code-review', { description: 'Use to verify work meets requirements.' }),
  skill('vibe-coder', { description: 'Offline native HTML/CSS/JS applications.' }),
  skill('plugin-link', { display_name: 'Link' }),
  skill('vi', { display_name: 'VI', enabled: false }),
  skill('vi-hidden', { assignable: false }),
]

describe('filterRuntimeSkills 排序', () => {
  it('只命中描述的行才需要补描述解释', () => {
    expect(skillMatchedOnlyByDescription(pluginSkill, '把 PDF')).toBe(true)
    expect(skillMatchedOnlyByDescription(pluginSkill, 'markdown-maker')).toBe(false)
    expect(skillMatchedOnlyByDescription(pluginSkill, '')).toBe(false)
  })

  it('短查询先把名字前缀命中排在只命中描述的技能前面', () => {
    expect(filterRuntimeSkills(rankingCatalog, 'vi').map(item => item.id)).toEqual([
      'vibe-coder',
      'receiving-code-review',
      'requesting-code-review',
      'appcli-router',
      'frontend-design',
    ])
  })

  it('名字完全相同最优先，大小写与空白不影响', () => {
    expect(filterRuntimeSkills(rankingCatalog, '  VI ')[0].id).toBe('vibe-coder')
    expect(filterRuntimeSkills(rankingCatalog, 'Link')[0].id).toBe('plugin-link')
    expect(filterRuntimeSkills([skill('vibe-coder'), skill('vi')], 'vi').map(item => item.id))
      .toEqual(['vi', 'vibe-coder'])
    expect(filterRuntimeSkills([skill('visualize'), skill('vi', { display_name: 'VI' })], '  VI ').map(item => item.id))
      .toEqual(['vi', 'visualize'])
  })

  it('不可选技能不进入结果，空白查询保持目录顺序', () => {
    expect(filterRuntimeSkills(rankingCatalog, 'vi').some(item => item.id === 'vi' || item.id === 'vi-hidden')).toBe(false)
    expect(filterRuntimeSkills(rankingCatalog, '   ').map(item => item.id)).toEqual([
      'appcli-router', 'frontend-design', 'receiving-code-review',
      'requesting-code-review', 'vibe-coder', 'plugin-link',
    ])
  })

  it('插件技能也能被限定标签命中', () => {
    expect(filterRuntimeSkills([pluginSkill], 'spacemit-power:pdf').map(item => item.id))
      .toEqual(['spacemit-power/markdown-maker'])
  })

  it('插件名精确命中排在只以该名开头的干扰技能之前', () => {
    // 干扰技能同样以 `spacemit-power` 开头，但只有 pluginSkill 的 plugin_id 与查询全等。
    const lookalike = skill('spacemit-power-tools/resize', { display_name: '图片尺寸' })
    expect(filterRuntimeSkills([lookalike, pluginSkill], 'spacemit-power').map(item => item.id))
      .toEqual(['spacemit-power/markdown-maker', 'spacemit-power-tools/resize'])
  })
})

describe('skillLabelFromId', () => {
  it('把 `插件/成员` 写成与 skillDisplayName 一致的 `插件:成员`', () => {
    expect(skillLabelFromId('spacemit-power/markdown-maker')).toBe('spacemit-power:markdown-maker')
    expect(skillLabelFromId('bianbu.audit/audit-guide')).toBe('bianbu.audit:audit-guide')
  })

  it('没有插件前缀、或斜杠在开头时原样保留', () => {
    expect(skillLabelFromId('riscv-porter')).toBe('riscv-porter')
    expect(skillLabelFromId('/leading')).toBe('/leading')
  })
})

/**
 * Power 格式 v2 的展示字段：技能名与描述随应用语言切换，缺失时回退到
 * `name` / `display_name`，旧格式与第三方 Skill 的现有行为不变。
 */
const localizedSkill: RuntimeSkill = {
  id: 'using-apm',
  name: 'using-apm',
  display_name: 'using-apm',
  name_zh: 'APM 使用手册',
  name_en: 'APM Agent Handbook',
  description_zh: '使用 APM 管理 Power 资源。',
  description: 'Manage Powers with APM.',
  version: '1.2.0',
  origin: 'standalone',
  plugin_id: null,
  enabled: true,
  assignable: true,
}

describe('runtime skill names follow the app language', () => {
  it('中文界面用 name_zh，英文界面用 name_en', () => {
    expect(skillDisplayName(localizedSkill, 'zh-CN')).toBe('APM 使用手册')
    expect(skillDisplayName(localizedSkill, 'en')).toBe('APM Agent Handbook')
    expect(skillLocalizedName(localizedSkill, 'zh-TW')).toBe('APM 使用手册')
  })

  it('描述也按语言取，非中文界面保持模型侧原文', () => {
    expect(skillLocalizedDescription(localizedSkill, 'zh-CN')).toBe('使用 APM 管理 Power 资源。')
    expect(skillLocalizedDescription(localizedSkill, 'en')).toBe('Manage Powers with APM.')
  })

  it('没有 v2 字段时回退到现有的 name / display_name', () => {
    expect(skillDisplayName(standaloneSkill, 'zh-CN')).toBe('代码审查')
    expect(skillDisplayName(standaloneSkill, 'en')).toBe('代码审查')
    expect(skillDisplayName({ ...localizedSkill, name_zh: '  ', name_en: '' }, 'en'))
      .toBe('using-apm')
    expect(skillDisplayName({ ...localizedSkill, name_zh: '' }, 'zh-CN'))
      .toBe('using-apm')
    expect(skillLocalizedDescription(standaloneSkill, 'zh-CN')).toBe('按清单审查改动')
    expect(skillLocalizedDescription({ ...standaloneSkill, description_zh: '  ' }, 'zh-CN'))
      .toBe('按清单审查改动')
  })

  it('插件技能仍带插件前缀，且 v2 名字与描述都能被搜索命中', () => {
    const pluginLocalized: RuntimeSkill = {
      ...localizedSkill, id: 'bianbu.memory/memory-guide', plugin_id: 'bianbu.memory',
    }
    expect(skillDisplayName(pluginLocalized, 'zh-CN')).toBe('bianbu.memory:APM 使用手册')
    expect(filterRuntimeSkills([pluginLocalized, standaloneSkill], 'APM Agent Hand'))
      .toEqual([pluginLocalized])
    expect(filterRuntimeSkills([pluginLocalized, standaloneSkill], '使用手册'))
      .toEqual([pluginLocalized])
    expect(filterRuntimeSkills([pluginLocalized, standaloneSkill], '管理 Power'))
      .toEqual([pluginLocalized])
  })

  it('限定名搜索与界面语言无关：中英名字各拼一份 插件id:名字', () => {
    const pluginLocalized: RuntimeSkill = {
      ...localizedSkill, id: 'bianbu.memory/memory-guide', plugin_id: 'bianbu.memory',
    }
    const catalog = [pluginLocalized, standaloneSkill]
    expect(filterRuntimeSkills(catalog, 'bianbu.memory:APM 使用手册')).toEqual([pluginLocalized])
    expect(filterRuntimeSkills(catalog, 'bianbu.memory:apm agent handbook')).toEqual([pluginLocalized])
  })
})
