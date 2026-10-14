import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const LOCALES_DIR = path.join(SRC, 'locales')
const LOCALES = ['en', 'zh-CN']
const DEFAULT_NS = 'common'
const SKIP_DIRS = new Set(['node_modules', 'locales', '__mocks__', 'dist', 'coverage'])

const flatten = (value: unknown, prefix = ''): Record<string, string> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { [prefix]: String(value) }
  }
  return Object.entries(value).reduce<Record<string, string>>((acc, [key, child]) => {
    return { ...acc, ...flatten(child, prefix ? `${prefix}.${key}` : key) }
  }, {})
}

const readLocale = (locale: string): Record<string, Record<string, string>> => {
  const dir = path.join(LOCALES_DIR, locale)
  return Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => [
        path.basename(file, '.json'),
        flatten(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))),
      ])
  )
}

const resolveKey = (
  resources: Record<string, Record<string, string>>,
  key: string
): string | undefined => {
  const [ns, keyPath] = key.includes(':') ? key.split(':', 2) : [DEFAULT_NS, key]
  return resources[ns]?.[keyPath]
}

const walk = (dir: string, files: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, files)
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

const COLLECTORS = [
  /(?:\bt|tc|i18n\.t|i18next\.t)\s*\(\s*(['"])([^'"]+)\1/g,
  /i18nKey\s*=\s*(['"])([^'"]+)\1/g,
  /<T\b[^>]*\bid\s*=\s*(['"])([^'"]+)\1/g,
]

const collectUsedKeys = (): Map<string, string[]> => {
  const used = new Map<string, string[]>()
  for (const file of walk(SRC)) {
    const content = fs.readFileSync(file, 'utf8')
    for (const pattern of COLLECTORS) {
      for (const match of content.matchAll(pattern)) {
        const key = match[2]
        const sources = used.get(key) ?? []
        if (!sources.includes(path.relative(SRC, file))) sources.push(path.relative(SRC, file))
        used.set(key, sources)
      }
    }
  }
  return used
}

const placeholders = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()

describe('locale catalog', () => {
  const resources = Object.fromEntries(LOCALES.map((locale) => [locale, readLocale(locale)]))
  const [primary, fallback] = LOCALES

  it('keeps every namespace and key aligned across locales', () => {
    const namespaces = new Set([...Object.keys(resources[primary]), ...Object.keys(resources[fallback])])
    expect([...namespaces].sort()).toEqual(Object.keys(resources[primary]).sort())

    const drift: string[] = []
    for (const ns of namespaces) {
      const a = resources[primary][ns] ?? {}
      const b = resources[fallback][ns] ?? {}
      for (const key of Object.keys(a)) if (!(key in b)) drift.push(`${fallback}/${ns}:${key}`)
      for (const key of Object.keys(b)) if (!(key in a)) drift.push(`${primary}/${ns}:${key}`)
    }
    expect(drift).toEqual([])
  })

  it('keeps interpolation variables identical across locales', () => {
    const drift: string[] = []
    for (const ns of Object.keys(resources[primary])) {
      for (const [key, value] of Object.entries(resources[primary][ns] ?? {})) {
        const other = resources[fallback][ns]?.[key]
        if (other === undefined) continue
        if (placeholders(value).join(',') !== placeholders(other).join(',')) {
          drift.push(`${ns}:${key}`)
        }
      }
    }
    expect(drift).toEqual([])
  })

  it('resolves every statically referenced key in every locale', () => {
    const used = collectUsedKeys()
    expect(used.size).toBeGreaterThan(300)
    const missing: string[] = []
    for (const [key, sources] of used) {
      for (const locale of LOCALES) {
        if (resolveKey(resources[locale], key) === undefined) {
          missing.push(`${locale}:${key} (${sources[0]})`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})
