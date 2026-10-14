import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// `color-scheme` is the only switch a UA reads for the form controls it paints
// itself (select chrome, spin buttons, non-overlay scrollbars). Removing it
// silently brings back "dark app, light native widgets" — verified on the K3
// boards before this was added, so it is asserted here rather than trusted.
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

const blockFor = (selector: string) =>
  css.match(new RegExp(`${selector}\\s*\\{[^}]*\\}`, 's'))?.[0] ?? ''

describe('theme rendering contract', () => {
  it('declares color-scheme for the light theme', () => {
    expect(blockFor(':root')).toContain('color-scheme: light')
  })

  it('declares color-scheme for the dark theme', () => {
    expect(blockFor('\\.dark')).toContain('color-scheme: dark')
  })

  it('keeps both scrollbar painters documented', () => {
    // WebKitGTK paints an overlay scrollbar from the GTK theme on Linux; the
    // CSS rules below only apply where overlay scrolling is off.
    expect(css).toContain('::-webkit-scrollbar-thumb')
    expect(css).toMatch(/overlay scrolling/i)
  })
})
