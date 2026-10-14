import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useFeatureHostApi, type FeatureSettingsProps } from '@bibit/feature-sdk'
import { FeatureSettingsHost } from '../FeatureSettingsHost'
import { createFeatureRegistryProjection } from '../registry'
import { clearFeatureModuleCache } from '../loadFeatureModule'
import { createTestEntry } from './testRegistry'

const translation = vi.hoisted(() => ({ i18n: { language: 'en' } }))
// 宿主现在会渲染自己的文案，mock 需要同时提供 t()
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ ...translation, t: (key: string) => key }),
}))
afterEach(() => { clearFeatureModuleCache(); translation.i18n.language = 'en' })

describe('FeatureSettingsHost', () => {
  it('passes changed host language to an already mounted contribution', async () => {
    const seenApis: unknown[] = []
    const hostApiFactory = vi.fn(() => ({ sdkApiVersion: 1 as const, featureId: 'store', grantedCapabilities: [], getCapability: () => undefined }))
    const Settings = ({ language }: FeatureSettingsProps) => { seenApis.push(useFeatureHostApi()); return <p data-testid="language">{language}</p> }
    const registry = createFeatureRegistryProjection([createTestEntry({ settings: Settings })], { target: 'desktop', surface: 'main' })
    const page = () => <FeatureSettingsHost hostApiFactory={hostApiFactory} registry={registry} featureId="store" routeSubpath="" search={{}} navigate={vi.fn()} back={vi.fn()} />
    const view = render(page())
    expect(await screen.findByTestId('language')).toHaveTextContent('en')
    translation.i18n.language = 'zh'
    view.rerender(page())
    expect(screen.getByTestId('language')).toHaveTextContent('zh')
    expect(hostApiFactory).toHaveBeenCalledTimes(1)
    expect(new Set(seenApis).size).toBe(1)
  })

  it('rebuilds complex settings state from a direct subpath', async () => {
    const Settings = ({ subpath, search }: FeatureSettingsProps) => (
      <div data-testid="settings-props">
        {subpath}|{search.view}
      </div>
    )
    const registry = createFeatureRegistryProjection(
      [createTestEntry({ settings: Settings, settingsPath: 'memory' })],
      { target: 'desktop', surface: 'main' }
    )
    render(
      <FeatureSettingsHost
        registry={registry}
        featureId="store"
        routeSubpath="memory/items/42"
        search={{ view: 'detail' }}
        navigate={vi.fn()}
        back={vi.fn()}
      />
    )
    expect(await screen.findByTestId('settings-props')).toHaveTextContent(
      'items/42|detail'
    )
  })

  it('contains a settings renderer exception locally', async () => {
    const Broken = () => {
      throw new Error('settings render failed')
    }
    const registry = createFeatureRegistryProjection(
      [createTestEntry({ settings: Broken })],
      { target: 'desktop', surface: 'main' }
    )
    render(
      <FeatureSettingsHost
        registry={registry}
        featureId="store"
        routeSubpath=""
        search={{}}
        navigate={vi.fn()}
        back={vi.fn()}
      />
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Feature could not be loaded'
    )
  })
})
