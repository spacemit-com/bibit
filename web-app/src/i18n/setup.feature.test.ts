import { beforeEach, describe, expect, it } from 'vitest'
import i18n, { registerFeatureLocales } from './setup'

describe('Feature locale registration', () => {
  beforeEach(() => {
    delete i18n.resources.en?.store
  })

  it('registers resources under the feature namespace', () => {
    registerFeatureLocales('store', { en: { title: 'Agent Store' } })
    expect(i18n.t('store:title')).toBe('Agent Store')
  })

  it('keeps <html lang> in step with the resolved language', () => {
    i18n.changeLanguage('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
    i18n.changeLanguage('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('does not partially mutate resources when validation fails', () => {
    expect(() =>
      registerFeatureLocales('store', { en: { title: 'Store' }, zh: null as never })
    ).toThrow('Invalid Feature locale resources')
    expect(i18n.resources.en?.store).toBeUndefined()
  })
})
