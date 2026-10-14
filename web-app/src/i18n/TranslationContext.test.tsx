import { render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { TranslationProvider } from './TranslationContext'
import { useAppTranslation } from './hooks'
import { registerFeatureLocales } from './setup'
const settings = vi.hoisted(() => ({ currentLanguage: 'en' }))
vi.mock('@/hooks/useGeneralSetting', () => ({ useGeneralSetting: () => settings }))
it('updates rendered labels and the language prop after a settings language change', async () => {
  registerFeatureLocales('language-fixture', { en: { label: 'Settings' }, 'zh-CN': { label: '设置' } })
  function Content() { const { i18n, t } = useAppTranslation(); return <p>{i18n.language}|{t('language-fixture:label')}</p> }
  const page = () => <TranslationProvider><Content /></TranslationProvider>
  const view = render(page())
  expect(screen.getByText('en|Settings')).toBeTruthy()
  settings.currentLanguage = 'zh-CN'
  view.rerender(page())
  await waitFor(() => expect(screen.getByText('zh-CN|设置')).toBeTruthy())
})

const bridgeInvoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
it('pushes the resolved language to the native tray and window titles', async () => {
  settings.currentLanguage = 'en'
  const bridge = globalThis as unknown as { __TAURI_INTERNALS__?: unknown }
  bridge.__TAURI_INTERNALS__ = { invoke: bridgeInvoke }
  try {
    render(<TranslationProvider><p>child</p></TranslationProvider>)
    await waitFor(() =>
      expect(bridgeInvoke).toHaveBeenCalledWith('set_tray_language', { language: 'en' }, undefined)
    )
  } finally {
    delete bridge.__TAURI_INTERNALS__
  }
})

// 浮窗 / 状态浮窗是独立 webview，各自持有一份 i18next；主窗口切语言后必须广播，
// 否则它们停在启动语言（SpacemiT K3 实测：界面已切中文，语音浮窗仍全英文）。
it('broadcasts the applied language so sibling windows can follow', async () => {
  settings.currentLanguage = 'zh-CN'
  const bridge = globalThis as unknown as { __TAURI_INTERNALS__?: unknown }
  bridge.__TAURI_INTERNALS__ = { invoke: bridgeInvoke }
  try {
    render(<TranslationProvider><p>child</p></TranslationProvider>)
    await waitFor(() =>
      expect(bridgeInvoke).toHaveBeenCalledWith(
        'plugin:event|emit',
        { event: 'app-language-changed', payload: 'zh-CN' },
        undefined
      )
    )
  } finally {
    delete bridge.__TAURI_INTERNALS__
  }
})
