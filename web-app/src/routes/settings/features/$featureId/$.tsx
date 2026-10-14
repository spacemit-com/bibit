import { createFileRoute } from '@tanstack/react-router'
import { FeatureSettingsHost } from '@/features/host/FeatureSettingsHost'
import type { FeatureNavigate } from '@/features/host/registry'
import { SettingsLayout } from '@/containers/SettingsLayout'
import { normalizeFeatureSearch } from '@/features/host/featureRouteAdapter'

export function FeatureSettingsRoute() {
  const params = Route.useParams() as { featureId: string; _splat?: string }
  const search = Route.useSearch() as Record<string, unknown>
  const routeNavigate = Route.useNavigate()
  const navigate: FeatureNavigate = (options) => routeNavigate(options as never)
  return (
    <SettingsLayout>
      <FeatureSettingsHost
        featureId={params.featureId}
        routeSubpath={params._splat ?? ''}
        search={normalizeFeatureSearch(search)}
        navigate={navigate}
        back={() => window.history.back()}
      />
    </SettingsLayout>
  )
}

export const Route = createFileRoute('/settings/features/$featureId/$')({
  component: FeatureSettingsRoute,
})
