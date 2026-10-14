import { afterEach, describe, expect, it } from 'vitest'
import postcss from 'postcss'
import { isolatePluginStyles } from '../trustedPluginStyles'

const roots = ['bibit-example-page-main', 'bibit-example-settings-options']
afterEach(() => { document.head.innerHTML = ''; document.body.innerHTML = '' })

describe('trusted plugin stylesheet isolation', () => {
  it('styles native controls without native @scope and leaves host controls untouched', () => {
    const style = document.createElement('style')
    style.textContent = isolatePluginStyles('.form input, .form textarea { padding: 13px; opacity: .4; }', roots)
    document.head.append(style)
    document.body.innerHTML = '<div class="form"><input id="host"></div>' + roots.map((root, i) => `<${root}><div class="form"><input id="input-${i}"><textarea id="text-${i}"></textarea></div></${root}>`).join('')
    expect(style.textContent).not.toContain('@scope')
    for (const id of ['input-0', 'text-0', 'input-1', 'text-1']) {
      expect(getComputedStyle(document.getElementById(id)!).padding).toBe('13px')
    }
    expect(getComputedStyle(document.getElementById('host')!).padding).not.toBe('13px')
  })

  it('parses selector lists, functional commas, attributes and pseudo elements', () => {
    const css = isolatePluginStyles('.form :is(input,textarea), [data-label="a,b"]::before, input::file-selector-button { color: red; }', roots)
    const rules: string[] = []
    postcss.parse(css).walkRules(rule => { rules.push(rule.selector) })
    expect(rules).toHaveLength(1)
    expect(css).toContain(':is(input,textarea)')
    expect(css).toContain('[data-label="a,b"]')
    expect(css).toContain('[data-label="a,b"]::before')
    expect(css).toContain('input::file-selector-button')
  })

  it('retains media/supports and namespaced global definitions without prefixing keyframe steps', () => {
    const css = isolatePluginStyles('@media (width > 10px) { @supports (display:grid) { .form input { animation: example-pulse 1s; } } } @keyframes example-pulse { from { opacity:0 } 50%, to { opacity:1 } } @font-face { font-family: example-font; src: url(example.woff2) } @property --example-color { syntax:"<color>"; inherits:false; initial-value:red }', roots)
    const parsed = postcss.parse(css)
    const frames: string[] = []
    parsed.walkAtRules('keyframes', rule => { rule.walkRules(step => { frames.push(step.selector) }) })
    expect(frames).toEqual(['from', '50%, to'])
    expect(css).toContain('@media (width > 10px)')
    expect(css).toContain('@supports (display:grid)')
    expect(css).toContain('animation: example-pulse 1s')
    expect(css).toContain('@font-face')
    expect(css).toContain('@property --example-color')
  })

  it('keeps scope-root selectors and sibling targets inside contribution roots', () => {
    const css = isolatePluginStyles(':scope { color:red } :scope > input { color:green } :scope + .outside, :is(:scope) ~ .outside { color:blue }', roots)
    document.body.innerHTML = `<${roots[0]}><input id="inside"></${roots[0]}><div class="outside"></div>`
    const rules: string[] = []
    postcss.parse(css).walkRules(rule => { rules.push(rule.selector) })
    expect(document.querySelectorAll(rules[0])).toHaveLength(1)
    expect(document.querySelectorAll(rules[1])).toHaveLength(1)
    expect(document.querySelectorAll(rules[2])).toHaveLength(0)
  })

  it.each(['@import "outside.css";', '@namespace url(example);', '@page { margin:0 }'])(
    'does not activate previously invalid host-global rules: %s', source => {
      expect(() => isolatePluginStyles(source, roots)).toThrow('Unsupported global plugin CSS rule')
    }
  )

  it('retains nested selectors with a target boundary and rejects invalid CSS atomically', () => {
    const css = isolatePluginStyles('.form { & input { color:red } & + .outside { color:blue } }', roots)
    const parsed = postcss.parse(css)
    const rules: string[] = []
    parsed.walkRules(rule => { rules.push(rule.selector) })
    expect(rules[1]).toContain('& input:where(')
    expect(rules[2]).toContain('& + .outside:where(')
    expect(() => isolatePluginStyles('.form {', roots)).toThrow()
  })
})
