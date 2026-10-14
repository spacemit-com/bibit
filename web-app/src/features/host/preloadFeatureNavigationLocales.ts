import { registerFeatureLocales } from '@/i18n/setup'
import { loadFeatureModule } from './loadFeatureModule'
import type { FeatureRegistrySourceEntry } from './registry'

/** Make menu translations available before the first application render. */
export async function preloadFeatureNavigationLocales(
  entries: readonly FeatureRegistrySourceEntry[]
): Promise<void> {
  await Promise.all(entries.filter(({ manifest }) =>
    manifest.targets.includes('desktop') &&
    [...manifest.contributions.pages, ...manifest.contributions.settings].some(
      (contribution) => contribution.navigation && contribution.surfaces.includes('main')
    )
  ).map(async (entry) => {
    try {
      const module = await loadFeatureModule(entry)
      if (module.locales) registerFeatureLocales(entry.manifest.id, module.locales)
    } catch (error) {
      // The existing contribution error boundary still provides retry on navigation.
      console.error(`Failed to preload Feature navigation locales: ${entry.manifest.id}`, error)
    }
  }))
}
