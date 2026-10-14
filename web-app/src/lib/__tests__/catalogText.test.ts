import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { modelSettings } from '../predefined'
import { paramCategories, paramGroups, paramsSettings } from '../predefinedParams'
import { modelParamText, paramText } from '../catalogText'

const SRC = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const LOCALES = ['en', 'zh-CN']

const lookup = (source: unknown, keyPath: string): unknown =>
  keyPath
    .split('.')
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === 'object'
          ? (current as Record<string, unknown>)[key]
          : undefined,
      source
    )

const readLocale = (locale: string): Record<string, unknown> =>
  Object.fromEntries(
    fs
      .readdirSync(path.join(SRC, 'locales', locale))
      .filter((file) => file.endsWith('.json'))
      .map((file) => [
        path.basename(file, '.json'),
        JSON.parse(
          fs.readFileSync(path.join(SRC, 'locales', locale, file), 'utf8')
        ),
      ])
  )

const resources = Object.fromEntries(LOCALES.map((l) => [l, readLocale(l)]))
const common = Object.fromEntries(
  LOCALES.map((locale) => [locale, resources[locale].common as Record<string, unknown>])
)

const resolveKey = (locale: string, key: string): unknown => {
  const [ns, keyPath] = key.includes(':') ? key.split(':', 2) : ['common', key]
  return lookup(resources[locale][ns], keyPath)
}

const REPO_ROOT = path.join(SRC, '..', '..')
const extensionSettings = [
  'llamacpp-extension',
  'rag-extension',
  'download-extension',
].map((extension) =>
  JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, 'extensions', extension, 'settings.json'),
      'utf8'
    )
  )
)

/** Keys the UI asks for, mirrored from the render sites. */
const expectedKeys: string[] = []
for (const def of Object.values(paramsSettings)) {
  expectedKeys.push(`paramDefs.${def.key}.title`, `paramDefs.${def.key}.description`)
  if (def.effectHint) expectedKeys.push(`paramDefs.${def.key}.effectHint`)
}
for (const def of Object.values(modelSettings)) {
  expectedKeys.push(
    `modelParamDefs.${def.key}.title`,
    `modelParamDefs.${def.key}.description`
  )
}
for (const group of paramGroups) {
  expectedKeys.push(`paramGroups.${group.id}.title`, `paramGroups.${group.id}.description`)
}
for (const category of paramCategories) expectedKeys.push(`paramCategories.${category.id}`)

/** Reasons reached by the real `disabledBy` callbacks, not a hand-kept list. */
const disabledReasonKeys = new Set<string>()
const combos: Array<Record<string, unknown>> = [
  {
    temperature: 0,
    mirostat: 0,
    dynatemp_range: 0,
    xtc_probability: 0,
    dry_multiplier: 0,
  },
  {
    temperature: 1,
    mirostat: 2,
    dynatemp_range: 1,
    xtc_probability: 0.5,
    dry_multiplier: 1,
  },
]
for (const def of Object.values(paramsSettings)) {
  if (!def.disabledBy) continue
  for (const combo of combos) {
    const reason = def.disabledBy(combo)
    if (reason) disabledReasonKeys.add(reason)
  }
}
for (const key of disabledReasonKeys) {
  expect(key.startsWith('common:paramDisabled.')).toBe(true)
  expectedKeys.push(key.slice('common:'.length))
}

describe('parameter catalog translations', () => {
  it('keys every catalog entry by its own `key` field', () => {
    for (const [objectKey, def] of Object.entries({
      ...paramsSettings,
      ...modelSettings,
    })) {
      expect(`${objectKey} -> ${def.key}`).toBe(`${objectKey} -> ${objectKey}`)
    }
  })

  it('resolves every catalog label in every locale', () => {
    expect(expectedKeys.length).toBe(116)
    const missing: string[] = []
    for (const locale of LOCALES) {
      for (const key of expectedKeys) {
        if (typeof lookup(common[locale], key) !== 'string') {
          missing.push(`${locale}:${key}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('translates the Chinese catalog, not just the English one', () => {
    // Sampler/format names that Chinese UIs also keep in English.
    const properNouns = new Set([
      'paramDefs.top_k.title',
      'paramDefs.top_p.title',
      'paramDefs.min_p.title',
      'paramDefs.mirostat.title',
      'paramDefs.mirostat_tau.title',
      'paramDefs.mirostat_eta.title',
      'paramDefs.typical_p.title',
      'paramDefs.top_n_sigma.title',
      'paramDefs.json_schema.title',
      'modelParamDefs.top_k.title',
      'modelParamDefs.top_p.title',
      'modelParamDefs.min_p.title',
      'paramGroups.mirostat.title',
      'paramGroups.dry.title',
      'paramGroups.xtc.title',
    ])
    const untranslated = expectedKeys.filter(
      (key) =>
        lookup(common['zh-CN'], key) === lookup(common.en, key) &&
        !properNouns.has(key)
    )
    expect(untranslated).toEqual([])
  })

  it('falls back to the catalog text for keys the catalogs do not own', () => {
    const t = (key: string) => `T(${key})`
    expect(paramText(t, 'temperature', 'title', 'Temperature')).toBe(
      'T(common:paramDefs.temperature.title)'
    )
    expect(modelParamText(t, 'ngl', 'description', 'GPU layers')).toBe(
      'T(common:modelParamDefs.ngl.description)'
    )
    expect(paramText(t, 'fit_ctx', 'title', 'Fit Minimum Context Size')).toBe(
      'Fit Minimum Context Size'
    )
    expect(modelParamText(t, 'flash_attn', 'title', 'Flash Attention')).toBe(
      'Flash Attention'
    )
  })
})

describe('extension setting translations', () => {
  it('resolves every titleKey / descriptionKey / nameKey in every locale', () => {
    const keys = new Set<string>()
    for (const settings of extensionSettings) {
      for (const setting of settings) {
        if (setting.titleKey) keys.add(setting.titleKey)
        if (setting.descriptionKey) keys.add(setting.descriptionKey)
        for (const option of setting.controllerProps?.options ?? []) {
          if (option.nameKey) keys.add(option.nameKey)
        }
      }
    }
    expect(keys.size).toBeGreaterThan(70)
    const missing: string[] = []
    for (const locale of LOCALES) {
      for (const key of keys) {
        if (typeof resolveKey(locale, key) !== 'string') {
          missing.push(`${locale}:${key}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('keeps the Chinese extension labels translated', () => {
    const properNouns = new Set([
      'providers:settingDefs.flash_attn.title',
      'providers:settingDefs.mlock.title',
      'common:optionValues.yarn',
      'settings:attachments.topK',
    ])
    const keys = new Set<string>()
    for (const settings of extensionSettings) {
      for (const setting of settings) {
        if (setting.titleKey) keys.add(setting.titleKey)
        if (setting.descriptionKey) keys.add(setting.descriptionKey)
        for (const option of setting.controllerProps?.options ?? []) {
          if (option.nameKey) keys.add(option.nameKey)
        }
      }
    }
    const untranslated = [...keys].filter(
      (key) =>
        resolveKey('zh-CN', key) === resolveKey('en', key) && !properNouns.has(key)
    )
    expect(untranslated).toEqual([])
  })
})
