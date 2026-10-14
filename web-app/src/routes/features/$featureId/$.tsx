import { createFileRoute } from '@tanstack/react-router'
import { FeaturePageHost } from '@/features/host/FeaturePageHost'
import type { FeatureNavigate } from '@/features/host/registry'
import { normalizeFeatureSearch } from '@/features/host/featureRouteAdapter'

export function FeaturePageRoute() {
  const params = Route.useParams() as { featureId: string; _splat?: string }
  const search = Route.useSearch() as Record<string, unknown>
  const routeNavigate = Route.useNavigate()
  const navigate: FeatureNavigate = (options) => routeNavigate(options as never)
  return (
    <FeaturePageHost
      featureId={params.featureId}
      routeSubpath={params._splat ?? ''}
      search={normalizeFeatureSearch(search)}
      navigate={navigate}
      back={() => window.history.back()}
    />
  )
}

export const Route = createFileRoute('/features/$featureId/$')({
  component: FeaturePageRoute,
})
