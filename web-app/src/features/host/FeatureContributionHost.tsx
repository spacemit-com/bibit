import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from 'react'
import {
  FeatureHostApiProvider,
  type FeaturePageProps,
  type FeatureRelativeNavigationV1,
  type FeatureSearchValue,
  type FeatureSettingsProps,
} from '@bibit/feature-sdk'
import { FeatureErrorBoundary } from './FeatureErrorBoundary'
import { loadFeatureModule, retryFeatureModule } from './loadFeatureModule'
import {
  desktopMainFeatureRegistry,
  type FeatureNavigate,
  type FeatureRegistryProjection,
} from './registry'
import { registerFeatureLocales } from '@/i18n/setup'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  FeatureEmptyState,
  Skeleton,
} from '@bibit/feature-ui'
import {
  createDefaultFeatureHostApi,
  type FeatureHostApiFactory,
} from '@/features/host-api'

export interface FeatureContributionHostProps {
  registry?: FeatureRegistryProjection
  featureId: string
  routeSubpath: string
  search: Readonly<Record<string, FeatureSearchValue>>
  navigate: FeatureNavigate
  back: () => void
  hostApiFactory?: FeatureHostApiFactory
}

const validateRelativeSubpath = (subpath: string) => {
  const hasControlCharacter = Array.from(subpath).some(
    (character) => character.charCodeAt(0) < 32
  )
  if (
    subpath.startsWith('/') ||
    subpath.includes('\\') ||
    subpath.includes('?') ||
    subpath.includes('#') ||
    hasControlCharacter ||
    (subpath !== '' &&
      subpath
        .split('/')
        .some((part) => part === '' || part === '.' || part === '..'))
  ) {
    throw new Error('Invalid Feature subpath')
  }
  return subpath.replace(/\/$/, '')
}

export function FeatureContributionHost({
  kind,
  testId,
  registry = desktopMainFeatureRegistry,
  featureId,
  routeSubpath,
  search,
  navigate,
  back,
  hostApiFactory = createDefaultFeatureHostApi,
}: FeatureContributionHostProps & {
  kind: 'page' | 'settings'
  testId: string
}) {
  const { t, i18n } = useTranslation()
  const resolution =
    kind === 'page'
      ? registry.resolvePage(featureId, routeSubpath)
      : registry.resolveSettings(featureId, routeSubpath)
  const [retryVersion, setRetryVersion] = useState(0)
  const mountRef = useRef<HTMLDivElement>(null)
  const resolvedContribution =
    resolution.status === 'found' ? resolution.contribution : undefined

  useEffect(() => {
    mountRef.current?.focus({ preventScroll: true })
  }, [featureId, routeSubpath, resolution.status])

  const LoadedContribution = useMemo(() => {
    // A retry must create a fresh React.lazy instance after its cached import rejects.
    if (!resolvedContribution) return null
    const contribution = resolvedContribution
    return lazy(async () => {
      const module = await loadFeatureModule(contribution.entry)
      if (module.locales) {
        registerFeatureLocales(contribution.featureId, module.locales)
      }
      const renderers = kind === 'page' ? module.pages : module.settings
      const renderer = renderers?.[contribution.contributionId] as
        | ComponentType<FeaturePageProps | FeatureSettingsProps>
        | undefined
      if (!renderer) throw new Error('Feature contribution renderer is missing')
      return { default: renderer }
    })
    // retryVersion intentionally invalidates React.lazy after a rejected import.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, resolvedContribution, retryVersion])

  const manifest = resolvedContribution?.entry.manifest
  const featureInstanceToken = resolvedContribution?.entry.featureInstanceToken
  // 动作上下文要跨渲染保持身份稳定，贡献模块才不会因为宿主 API 换对象而重挂；
  // 导航函数本身可能每次渲染都变，所以动作里再通过 ref 取最新的那个。
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  const hostApi = useMemo(
    () => manifest
      ? hostApiFactory(manifest, true, featureInstanceToken, {
          navigate: (options) => navigateRef.current(options),
        })
      : undefined,
    [manifest, featureInstanceToken, hostApiFactory]
  )

  if (resolution.status !== 'found' || !LoadedContribution || !hostApi) {
    return (
      <div
        role="status"
        data-testid="feature-unavailable"
        data-reason={resolution.status}
      >
        <FeatureEmptyState
          title={t('common:featureUnavailable')}
          description={resolution.status}
        />
      </div>
    )
  }

  const { contribution, subpath } = resolution
  const basePath = contribution.contribution.path
  const route =
    kind === 'page'
      ? '/features/$featureId/$'
      : '/settings/features/$featureId/$'
  const go = (
    replace: boolean,
    nextSubpath: string,
    nextSearch?: Readonly<Record<string, FeatureSearchValue>>
  ) => {
    const safe = validateRelativeSubpath(nextSubpath)
    const splat = [basePath, safe].filter(Boolean).join('/')
    void navigate({
      to: route,
      params: { featureId, _splat: splat },
      search: nextSearch,
      replace,
    })
  }
  const navigation: FeatureRelativeNavigationV1 = {
    push: (nextSubpath, nextSearch) => go(false, nextSubpath, nextSearch),
    replace: (nextSubpath, nextSearch) => go(true, nextSubpath, nextSearch),
    back,
  }
  const props = {
    language: i18n.language || 'en',
    featureId,
    contributionId: contribution.contributionId,
    subpath,
    search,
    navigation,
  }
  const retry = () => {
    retryFeatureModule(featureId)
    setRetryVersion((value) => value + 1)
  }

  return (
    <div
      ref={mountRef}
      tabIndex={-1}
      className="h-full min-h-0 min-w-0 w-full outline-none"
      data-testid={testId}
    >
      <FeatureErrorBoundary
        key={`${contribution.key}:${retryVersion}`}
        onRetry={retry}
      >
        <Suspense fallback={<Skeleton aria-label={t('common:loadingFeature')} className="h-24 w-full" />}>
          <FeatureHostApiProvider value={hostApi}>
            <LoadedContribution {...props} />
          </FeatureHostApiProvider>
        </Suspense>
      </FeatureErrorBoundary>
    </div>
  )
}
