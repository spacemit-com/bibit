import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const indexCss = read('../../index.css')
const markdownCss = read('../markdown.css')
const brandCss = read('../font.css')

/** UI 字体栈里出现的中文字体族，顺序即字重档位的优先顺序。 */
const CHINESE_FAMILIES = [
  'PingFang SC',
  'Hiragino Sans GB',
  'Microsoft YaHei UI',
  'Microsoft YaHei',
  'Noto Sans SC',
  'Source Han Sans SC',
  'Noto Sans CJK SC',
  'WenQuanYi Micro Hei',
]

/** 中日字形差异明显的常用字，用来识别「中文被日文字体接管」。 */
const CJK_PROBES: ReadonlyArray<readonly [string, string]> = [
  ['直', '76f4'],
  ['骨', '9aa8'],
  ['具', '5177'],
  ['令', '4ee4'],
  ['次', '6b21'],
  ['真', '771f'],
  ['化', '5316'],
  ['别', '522b'],
]

const cssFontStack = (name: string): string[] => {
  const match = indexCss.match(new RegExp(`--${name}:\\s*([^;]+);`))
  if (!match) throw new Error(`--${name} 未在 index.css 中定义`)
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

describe('UI 字体栈', () => {
  it('把中文字体族显式列在 sans-serif 之前', () => {
    const stack = cssFontStack('font-sans')
    const genericIndex = stack.indexOf('sans-serif')
    expect(genericIndex).toBeGreaterThan(-1)

    const declared = CHINESE_FAMILIES.filter((family) => stack.includes(family))
    expect(declared.length).toBeGreaterThan(0)
    for (const family of declared) {
      expect(stack.indexOf(family), `${family} 必须在 sans-serif 之前`).toBeLessThan(
        genericIndex
      )
    }
  })

  it('字重档位齐全的中文族排在只有 Regular/Bold 的 CJK OTC 之前', () => {
    const stack = cssFontStack('font-sans')
    // Noto Sans SC 有 9 档字重，Noto Sans CJK SC 只有 Regular/Bold。
    // 顺序反了会让 font-medium(500) 对中文完全失效。
    expect(stack).toContain('Noto Sans SC')
    expect(stack).toContain('Noto Sans CJK SC')
    expect(stack.indexOf('Noto Sans SC')).toBeLessThan(stack.indexOf('Noto Sans CJK SC'))
  })

  it('不再把 Inter 当作 UI 主字体', () => {
    expect(cssFontStack('font-sans')).not.toContain('Inter')
    expect(brandCss).not.toMatch(/font-family:\s*'Inter'/)
  })

  it('等宽栈补上系统真实存在的族并带 CJK 兜底', () => {
    const mono = cssFontStack('font-mono')
    expect(mono).toContain('Noto Sans Mono CJK SC')
    expect(mono.at(-1)).toBe('monospace')
    expect(markdownCss).not.toMatch(/'JetBrains Mono',\s*'Fira Code'/)
    expect(markdownCss.match(/var\(--font-mono/g)?.length).toBe(3)
  })

  it('正文字号与 --font-size-base 同源，不再回落到根字号 1rem', () => {
    expect(markdownCss).toMatch(/\.markdown\s*\{[^}]*font-size:\s*var\(--text-base\)/)
  })
})

const hasFontconfig = (() => {
  try {
    execFileSync('fc-list', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const fc = (args: string[]) => {
  try {
    return execFileSync('fc-match', args, { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const fcList = (args: string[]) => {
  try {
    return execFileSync('fc-list', args, { encoding: 'utf8' })
  } catch {
    return ''
  }
}

const splitFamilies = (raw: string) =>
  raw
    .split('\n')
    .flatMap((line) => line.split(','))
    .map((name) => name.trim())
    .filter(Boolean)

const GENERIC_FAMILIES = new Set([
  'system-ui',
  'ui-sans-serif',
  'sans-serif',
  'ui-monospace',
  'monospace',
])

// 这个检查读取的是 fontconfig，而 WebKit 就是通过 fontconfig 做字形回退，所以能捕捉
// 「中文被 Noto Sans CJK JP 接管」这类在 <html lang> 变化时才暴露的回归。
describe.skipIf(!hasFontconfig)('fontconfig 字形回退', () => {
  const installed = new Set(splitFamilies(fcList(['--format=%{family}\n'])))
  const coverageCache = new Map<string, Set<string>>()
  const covering = (codepoint: string) => {
    let hit = coverageCache.get(codepoint)
    if (!hit) {
      hit = new Set(splitFamilies(fcList([`:charset=${codepoint}`, 'family'])))
      coverageCache.set(codepoint, hit)
    }
    return hit
  }

  // generic family 在 WebKit 里会先解析成一个具体族名，再决定是否需要继续往后找。
  const resolveFirstCovering = (codepoint: string) => {
    for (const family of cssFontStack('font-sans')) {
      if (GENERIC_FAMILIES.has(family)) {
        const resolved = fc(['-f', '%{family}', family]).split(',')[0]?.trim()
        if (resolved && covering(codepoint).has(resolved)) return resolved
        continue
      }
      if (!installed.has(family)) continue
      if (covering(codepoint).has(family)) return family
    }
    return null
  }

  it('每个探针字都由中文字体族接管，而不是日/韩字形族', () => {
    const resolved = CJK_PROBES.map(([char, cp]) => [char, resolveFirstCovering(cp)] as const)
    const unusable = resolved.filter(
      ([, family]) => !family || !CHINESE_FAMILIES.includes(family)
    )
    expect(
      unusable,
      `以下汉字没有落到中文字体族（很可能是被 Noto Sans CJK JP/KR/TC 接管）：${unusable
        .map(([char, family]) => `${char}->${family ?? '未找到'}`)
        .join(', ')}`
    ).toEqual([])
  })

  it('接管汉字的中文字体族带真实 Medium/SemiBold 字面', () => {
    const family = resolveFirstCovering('76f4')
    expect(family, '没有中文字体族可以接管汉字，请检查字体栈').toBeTruthy()

    const face = (weight: string) =>
      fc(['-f', '%{file}', `${family}:lang=zh-cn:weight=${weight}`])
    // 只有 Regular/Bold 的族（如 Noto Sans CJK SC）会让 500 退化成 Regular，
    // 于是 font-medium 对中文静默失效。
    expect(face('medium')).not.toBe(face('regular'))
    expect(face('semibold')).not.toBe(face('regular'))
  })
})
