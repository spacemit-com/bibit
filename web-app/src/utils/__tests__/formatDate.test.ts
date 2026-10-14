import { describe, it, expect, afterEach } from 'vitest'
import i18n from '@/i18n/setup'
import { formatDate } from '../formatDate'

const EN = { locale: 'en-US' }
const ZH = { locale: 'zh-CN' }

describe('formatDate', () => {
  // 默认语言来自 i18n 单例，用例改过语言必须还原，否则会串到别的用例。
  afterEach(() => {
    i18n.changeLanguage('en')
  })

  it('formats Date objects correctly', () => {
    const date = new Date('2023-12-25T15:30:45Z')
    const formatted = formatDate(date, EN)
    
    // The exact format depends on the system locale, but it should include key components
    expect(formatted).toMatch(/Dec.*25.*2023/i)
    expect(formatted).toMatch(/\d{1,2}:\d{2}/i) // time format
    expect(formatted).toMatch(/(AM|PM)/i)
  })

  it('formats ISO string dates correctly', () => {
    const isoString = '2023-01-15T09:45:30Z'
    const formatted = formatDate(isoString, EN)
    
    expect(formatted).toMatch(/Jan.*15.*2023/i)
    expect(formatted).toMatch(/\d{1,2}:\d{2}/i)
    expect(formatted).toMatch(/(AM|PM)/i)
  })

  it('formats timestamp numbers correctly', () => {
    const timestamp = 1703519445000 // Dec 25, 2023 15:30:45 UTC
    const formatted = formatDate(timestamp, EN)
    
    expect(formatted).toMatch(/Dec.*25.*2023/i)
    expect(formatted).toMatch(/\d{1,2}:\d{2}/i)
    expect(formatted).toMatch(/(AM|PM)/i)
  })

  it('handles different months correctly', () => {
    const dates = [
      '2023-01-01T12:00:00Z',
      '2023-02-01T12:00:00Z',
      '2023-03-01T12:00:00Z',
      '2023-12-01T12:00:00Z'
    ]
    
    const formatted = dates.map((d) => formatDate(d, EN))
    
    expect(formatted[0]).toMatch(/Jan.*1.*2023/i)
    expect(formatted[1]).toMatch(/Feb.*1.*2023/i)
    expect(formatted[2]).toMatch(/Mar.*1.*2023/i)
    expect(formatted[3]).toMatch(/Dec.*1.*2023/i)
  })

  it('shows 12-hour format with AM/PM', () => {
    const morningDate = '2023-06-15T09:30:00Z'
    const eveningDate = '2023-06-15T21:30:00Z'
    
    const morningFormatted = formatDate(morningDate, EN)
    const eveningFormatted = formatDate(eveningDate, EN)
    
    // Note: The exact AM/PM depends on timezone, but both should have AM or PM
    expect(morningFormatted).toMatch(/(AM|PM)/i)
    expect(eveningFormatted).toMatch(/(AM|PM)/i)
  })

  it('handles edge cases', () => {
    // Test with very old and very new dates
    const oldDate = '1900-01-01T00:00:00Z'
    const futureDate = '2099-12-31T23:59:59Z'
    
    expect(() => formatDate(oldDate, EN)).not.toThrow()
    expect(() => formatDate(futureDate, EN)).not.toThrow()
    
    expect(formatDate(oldDate, EN)).toMatch(/Jan.*1.*1900/i)
    // The futureDate might be affected by timezone - let's just check it doesn't throw
    const futureDateResult = formatDate(futureDate, EN)
    expect(futureDateResult).toMatch(/\d{4}/) // Should contain a year
  })

  it('uses en-US locale formatting', () => {
    const date = '2023-07-04T12:00:00Z'
    const formatted = formatDate(date, EN)
    
    // Should use US-style date formatting (Month Day, Year)
    expect(formatted).toMatch(/Jul.*4.*2023/i)
    // Should include abbreviated month name
    expect(formatted).toMatch(/Jul/i)
  })

  it('supports date-only formatting when includeTime=false', () => {
    const date = '2023-07-04T12:00:00Z'
    const formatted = formatDate(date, { includeTime: false, ...EN })

    // Long month, no time
    expect(formatted).toMatch(/July.*4.*2023/i)
    expect(formatted).not.toMatch(/\d{1,2}:\d{2}/i)
    expect(formatted).not.toMatch(/(AM|PM)/i)
  })

  it('date-only formatting includes a year and omits time across edge cases', () => {
    const oldDate = '1900-01-01T00:00:00Z'
    const formatted = formatDate(oldDate, { includeTime: false, ...EN })

    expect(formatted).toMatch(/\d{4}/)
    expect(formatted).not.toMatch(/\d{1,2}:\d{2}/i)
    expect(formatted).not.toMatch(/(AM|PM)/i)
  })

  it('follows the UI language when no locale is given', () => {
    i18n.changeLanguage('zh-CN')

    // 本地时间构造，避免时区把日期挤到前一天。
    const formatted = formatDate(new Date(2026, 8, 21, 15, 30))

    expect(formatted).toContain('2026年9月21日')
    // 时间部分交给 ICU（24h 或“下午3:30”都算中文），只保证不再带 AM/PM。
    expect(formatted).not.toMatch(/(AM|PM)/i)
    expect(formatDate(new Date(2026, 8, 21), { includeTime: false })).toBe(
      '2026年9月21日'
    )

    i18n.changeLanguage('en')
    expect(formatDate(new Date(2026, 8, 21, 15, 30))).toMatch(/3:30\s?PM/i)
    expect(formatDate(new Date(2026, 8, 21), { includeTime: false })).toBe(
      'September 21, 2026'
    )
  })

  it('lets an explicit locale win over the UI language', () => {
    i18n.changeLanguage('zh-CN')

    expect(formatDate(new Date(2026, 8, 21, 15, 30), EN)).toMatch(
      /Sep 21, 2026/
    )
  })
})
