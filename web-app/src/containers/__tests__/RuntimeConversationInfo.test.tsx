import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RuntimeConversationInfo } from '../RuntimeConversationInfo'
import { TranslationContext } from '@/i18n/context'
import i18n from '@/i18n/setup'

const originalLanguage = i18n.language
afterEach(() => i18n.changeLanguage(originalLanguage))

describe('Runtime conversation translations', () => {
  it.each([
    ['en', 'Retained 8 messages · compression 2'],
    ['zh-CN', '保留 8 条消息 · 第 2 次压缩'],
  ])('interpolates actual %s locale strings', (locale, compressionLabel) => {
    i18n.changeLanguage(locale)
    render(<TranslationContext.Provider value={{ t: i18n.t, i18n }}>
      <RuntimeConversationInfo metadata={{ runtime: 'bianbu', compression: { before_tokens: 1000, after_tokens: 200, retained_messages: 8, compression_count: 2 } }} />
    </TranslationContext.Provider>)
    expect(screen.getByText(compressionLabel)).toBeInTheDocument()
    expect(screen.queryByText(/\{\{/)).not.toBeInTheDocument()
  })
})


it('renders recovery as a status notice with escaped model-independent text', () => {
  render(<TranslationContext.Provider value={{ t: i18n.t, i18n }}>
    <RuntimeConversationInfo metadata={{ runtime: 'bianbu', progress: {
      phase: 'recovering', message: '分步继续 <script>unsafe</script>', attempt: 1,
    } }} />
  </TranslationContext.Provider>)
  expect(screen.getByRole('status')).toHaveTextContent('分步继续 <script>unsafe</script>')
  expect(screen.getByRole('status').querySelector('script')).toBeNull()
})
