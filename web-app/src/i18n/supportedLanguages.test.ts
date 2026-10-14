import { describe, expect, it } from 'vitest'
import { normalizeLanguage, resolveLanguage } from './supportedLanguages'

describe('normalizeLanguage', () => {
  it('keeps languages supported by the BiBit first release', () => {
    expect(normalizeLanguage('system')).toBe('system')
    expect(normalizeLanguage('en')).toBe('en')
    expect(normalizeLanguage('zh-CN')).toBe('zh-CN')
  })

  it('defaults unsupported and missing preferences to the system language', () => {
    expect(normalizeLanguage('ja')).toBe('system')
    expect(normalizeLanguage('id')).toBe('system')
    expect(normalizeLanguage('vn')).toBe('system')
    expect(normalizeLanguage(undefined)).toBe('system')
  })
})

describe('resolveLanguage', () => {
  it('follows Chinese and English system locales', () => {
    expect(resolveLanguage('system', 'zh-CN')).toBe('zh-CN')
    expect(resolveLanguage('system', 'zh-Hant-TW')).toBe('zh-CN')
    expect(resolveLanguage('system', 'en-GB')).toBe('en')
  })

  it('falls unknown system locales back to English', () => {
    expect(resolveLanguage('system', 'ja-JP')).toBe('en')
  })

  it('does not replace an explicit language with the system locale', () => {
    expect(resolveLanguage('en', 'zh-CN')).toBe('en')
    expect(resolveLanguage('zh-CN', 'en-US')).toBe('zh-CN')
  })
})
