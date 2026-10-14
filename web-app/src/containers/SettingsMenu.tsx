import { Link } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  IconAdjustmentsHorizontal,
  IconCommand,
  IconPalette,
  IconPuzzle,
} from '@tabler/icons-react'
import {
  createFeatureRegistryProjection,
  type FeatureRegistrySourceEntry,
} from '@/features/host/registry'
import { activeFeatureRegistry } from '@/features/activeFeatureRegistry'
import { getFeatureIcon } from '@bibit/feature-ui'
import {
  groupFeatureSettingsNavigation,
  mergeFeatureSettingsNavigation,
  type FeatureSettingsNavigationItem,
} from '@/features/navigation'
import type { FeatureSettingsContributionV1 } from '@bibit/feature-contracts'

export const getFeatureSettingsNavigation = (
  entries: readonly FeatureRegistrySourceEntry[]
) =>
  mergeFeatureSettingsNavigation(
    createFeatureRegistryProjection(entries, {
      target: 'desktop',
      surface: 'main',
    }).settings.map(({ entry, contribution, finalPath, key }) => {
      const navigation = (contribution as FeatureSettingsContributionV1)
        .navigation
      return {
        id: key,
        group: navigation?.group,
        order: navigation?.order,
        title:
          navigation?.fallbackTitle ?? entry.manifest.display.fallbackTitle,
        titleKey:
          navigation?.titleKey ??
          (navigation?.fallbackTitle
            ? undefined
            : entry.manifest.display.titleKey),
        path: finalPath,
        iconKey: navigation?.iconKey ?? entry.manifest.display.iconKey,
        section: navigation?.section,
      }
    })
  )
export interface SettingsMenuProps {
  featureSettingsItems?: readonly FeatureSettingsNavigationItem[]
}

const SettingsMenu = ({
  featureSettingsItems,
}: SettingsMenuProps = {}) => {
  const { t } = useTranslation()
  const featureSettingsByGroup = groupFeatureSettingsNavigation(
    mergeFeatureSettingsNavigation(
      featureSettingsItems ??
        getFeatureSettingsNavigation(activeFeatureRegistry)
    )
  )

  const coreSettings = [
    {
      title: 'common:general',
      route: route.settings.general,
      icon: IconAdjustmentsHorizontal,
    },
    // "Appearance" is implemented by the existing Interface settings route.
    {
      title: 'common:appearance',
      route: route.settings.interface,
      icon: IconPalette,
    },
    {
      title: 'common:keyboardShortcuts',
      route: route.settings.shortcuts,
      icon: IconCommand,
    },
    {
      title: 'common:extensions',
      route: route.settings.extensions,
      icon: IconPuzzle,
    },
  ]

  const integrationSettings: typeof coreSettings = []

  const renderFeatureSetting = (menu: FeatureSettingsNavigationItem) => {
    const Icon = getFeatureIcon(menu.iconKey)
    const translated = menu.titleKey ? t(menu.titleKey) : menu.title
    return (
      <Link
        key={menu.id}
        to={menu.path}
        className="flex items-center gap-2 rounded-sm px-2 py-1 hover:bg-secondary/60 [&.active]:bg-secondary"
      >
        <Icon
          width={18}
          height={18}
          className="shrink-0 text-muted-foreground"
        />
        <span>{translated === menu.titleKey ? menu.title : translated}</span>
      </Link>
    )
  }

  const coreNavigationBlocks = featureSettingsByGroup.core.reduce<
    Array<
      | { kind: 'item'; item: FeatureSettingsNavigationItem }
      | {
          kind: 'section'
          id: string
          titleKey?: string
          fallbackTitle: string
          items: FeatureSettingsNavigationItem[]
        }
    >
  >((blocks, item) => {
    if (!item.section) {
      blocks.push({ kind: 'item', item })
      return blocks
    }
    const existing = blocks.find(
      (block) => block.kind === 'section' && block.id === item.section?.id
    )
    if (existing?.kind === 'section') {
      existing.items.push(item)
    } else {
      blocks.push({ kind: 'section', ...item.section, items: [item] })
    }
    return blocks
  }, [])

  return (
    <>
      <div className="h-full w-58 shrink-0 px-4 flex overflow-auto">
        <div className="flex flex-col gap-1 w-full font-medium">
          {/* Core settings */}
          {coreSettings.map((menu) => (
            <div key={menu.title}>
              <Link
                to={menu.route}
                className="block px-2 gap-1.5 cursor-pointer hover:dark:bg-secondary/60 hover:bg-secondary py-1 w-full rounded-sm [&.active]:dark:bg-secondary/80 [&.active]:bg-secondary"
              >
                <div className="flex items-center gap-2">
                  <menu.icon
                    size={18}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span>{t(menu.title)}</span>
                </div>
              </Link>
            </div>
          ))}

          {coreNavigationBlocks.map((block) => {
            if (block.kind === 'item') return renderFeatureSetting(block.item)
            const translated = block.titleKey
              ? t(block.titleKey)
              : block.fallbackTitle
            const label =
              translated === block.titleKey ? block.fallbackTitle : translated
            return (
              <div key={block.id} className="mt-4">
                <span className="px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {label}
                </span>
                <div className="mt-1 flex flex-col gap-1">
                  {block.items.map(renderFeatureSetting)}
                </div>
              </div>
            )
          })}

          {featureSettingsByGroup.privacy.length > 0 && (
            <div data-testid="feature-settings-privacy" className="flex flex-col gap-1">
              {featureSettingsByGroup.privacy.map(renderFeatureSetting)}
            </div>
          )}

          {featureSettingsByGroup.features.length > 0 && (
            <div className="mt-4" data-testid="feature-settings-navigation">
              <span className="px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('common:features') === 'common:features'
                  ? 'Features'
                  : t('common:features')}
              </span>
              <div className="mt-1 flex flex-col gap-1">
                {featureSettingsByGroup.features.map(renderFeatureSetting)}
              </div>
            </div>
          )}

          {/* Integrations section */}
          <div className="mt-4">
            <span className="px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('common:integrations')}
              <span className="text-[11px] capitalize ml-2 font-medium px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-600 dark:text-blue-400">
                {t('common:experimental')}
              </span>
            </span>
            <div
              className="mt-1 flex flex-col gap-1"
              data-testid="integration-settings-navigation"
            >
              {integrationSettings.map((menu) => (
                <Link
                  key={menu.title}
                  to={menu.route}
                  className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:dark:bg-secondary/60 hover:bg-secondary rounded-sm [&.active]:dark:bg-secondary/80 [&.active]:bg-secondary"
                >
                  <menu.icon size={18} className="shrink-0 text-muted-foreground" />
                  <span>{t(menu.title)}</span>
                </Link>
              ))}
              {featureSettingsByGroup.integrations.map(renderFeatureSetting)}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export default SettingsMenu
