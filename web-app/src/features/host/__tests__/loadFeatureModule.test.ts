import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeatureModuleV1 } from '@bibit/feature-sdk'
import {
  clearFeatureModuleCache,
  loadFeatureModule,
  retryFeatureModule,
  unwrapFeatureModule,
} from '../loadFeatureModule'
import { createTestEntry } from './testRegistry'

const module: FeatureModuleV1 = { sdkApiVersion: 1 }

afterEach(() => clearFeatureModuleCache())

describe('Feature module loader', () => {
  it.each([
    ['raw module', module],
    ['named export', { featureModule: module }],
    ['default export', { default: module }],
    [
      'default fallback after an invalid named export',
      { featureModule: {}, default: module },
    ],
  ])('unwraps a %s consistently', (_name, value) => {
    expect(unwrapFeatureModule(value)).toBe(module)
  })

  it('caches the loader promise by Feature ID', async () => {
    const loader = vi.fn().mockResolvedValue({ featureModule: module })
    const entry = createTestEntry({ load: loader })

    const first = loadFeatureModule(entry)
    const second = loadFeatureModule(entry)
    expect(first).toBe(second)
    await expect(first).resolves.toBe(module)
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('keeps rejection cached until retry clears only that Feature', async () => {
    const failingLoader = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline chunk'))
      .mockResolvedValue({ default: module })
    const healthyLoader = vi.fn().mockResolvedValue({ default: module })
    const failing = createTestEntry({ id: 'store', load: failingLoader })
    const healthy = createTestEntry({ id: 'memory', load: healthyLoader })

    await expect(loadFeatureModule(failing)).rejects.toThrow('offline chunk')
    await expect(loadFeatureModule(failing)).rejects.toThrow('offline chunk')
    await loadFeatureModule(healthy)
    expect(failingLoader).toHaveBeenCalledTimes(1)

    retryFeatureModule('store')
    await expect(loadFeatureModule(failing)).resolves.toBe(module)
    await loadFeatureModule(healthy)
    expect(failingLoader).toHaveBeenCalledTimes(2)
    expect(healthyLoader).toHaveBeenCalledTimes(1)
  })
})
