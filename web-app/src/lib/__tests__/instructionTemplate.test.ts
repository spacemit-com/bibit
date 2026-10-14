import { describe, it, expect, vi, afterEach } from 'vitest'
import i18n from '@/i18n/setup'
import { renderInstructions } from '../instructionTemplate'

describe('renderInstructions', () => {
  afterEach(() => {
    vi.useRealTimers()
    i18n.changeLanguage('en')
  })

  it('replaces {{current_date}} with today when no params provided', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-08-16T00:00:00Z'))

    const input = 'Today is {{current_date}}.'
    const out = renderInstructions(input)

    expect(out).not.toBe(input)
    expect(out).toMatch(/^Today is /)
    expect(out).not.toContain('{{current_date}}')

    vi.useRealTimers()
  })

  it('replaces multiple occurrences of {{current_date}}', () => {
    const input = 'A {{current_date}} B {{current_date}} C'
    const out = renderInstructions(input)
    expect(out).not.toContain('{{current_date}}')
    expect(out.startsWith('A ')).toBe(true)
    expect(out.includes(' B ')).toBe(true)
    expect(out.endsWith(' C')).toBe(true)
  })

  it('keeps the injected prompt date locale-independent', () => {
    i18n.changeLanguage('zh-CN')
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2025, 7, 16, 12, 0, 0))

    expect(renderInstructions('Today is {{current_date}}.')).toBe(
      'Today is August 16, 2025.'
    )
  })
})
