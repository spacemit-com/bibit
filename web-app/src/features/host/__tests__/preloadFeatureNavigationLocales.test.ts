import { afterEach, expect, it, vi } from 'vitest'
import i18n from '@/i18n/setup'
import { preloadFeatureNavigationLocales } from '../preloadFeatureNavigationLocales'
import { clearFeatureModuleCache, loadFeatureModule } from '../loadFeatureModule'
import { createTestEntry } from './testRegistry'

afterEach(() => clearFeatureModuleCache())

it('registers settings menu translations before any contribution mounts and reuses the import', async () => {
  const load = vi.fn().mockResolvedValue({ sdkApiVersion: 1, locales: { en: { title: 'Runtime management' }, 'zh-CN': { title: '运行时管理' } } })
  const entry = createTestEntry({ id: 'runtime', settings: () => null, load })
  entry.manifest.contributions.settings[0].navigation = { group: 'core', titleKey: 'runtime:title', section: { id: 'runtime-management', fallbackTitle: '管理' } }
  await preloadFeatureNavigationLocales([entry])
  i18n.changeLanguage('en')
  expect(i18n.t('runtime:title')).toBe('Runtime management')
  i18n.changeLanguage('zh-CN')
  expect(i18n.t('runtime:title')).toBe('运行时管理')
  await loadFeatureModule(entry)
  expect(load).toHaveBeenCalledTimes(1)
  i18n.changeLanguage('en')
})

it('leaves deep-link-only contributions lazy and isolates a failed navigation module', async () => {
  const hiddenLoad = vi.fn()
  const hidden = createTestEntry({ settings: () => null, load: hiddenLoad })
  const broken = createTestEntry({ id: 'broken', settings: () => null, load: async () => { throw new Error('offline') } })
  broken.manifest.contributions.settings[0].navigation = { group: 'core' }
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(preloadFeatureNavigationLocales([hidden, broken])).resolves.toBeUndefined()
  expect(hiddenLoad).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalled()
  log.mockRestore()
})
