import { useCallback, useEffect, useState } from 'react'
import type { FeatureModuleV1 } from '@bibit/feature-sdk'
import { useFeatureCapability } from '@bibit/feature-sdk'
import { Button, Skeleton } from '@bibit/feature-ui'

type StoreAgent = { id: string; name: string }

function StorePage() {
  const service = useFeatureCapability('external-service:store')
  const [agents, setAgents] = useState<readonly StoreAgent[]>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)

  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  useEffect(() => {
    let active = true
    setAgents(undefined)
    setError(undefined)
    if (!service) {
      setError('Store capability is unavailable')
      return () => {
        active = false
      }
    }
    service
      .request<readonly StoreAgent[]>({
        serviceId: 'store',
        operationId: 'list-agents',
        params: {},
      })
      .then((result) => {
        if (active) setAgents(result)
      })
      .catch((cause: { code?: string }) => {
        if (active) setError(cause.code ?? 'unknown')
      })
    return () => {
      active = false
    }
  }, [attempt, service])

  return (
    <section className="space-y-4 p-6" aria-labelledby="store-title">
      <h1 id="store-title" className="text-xl font-semibold">
        Agent Store
      </h1>
      {error ? (
        <section role="alert" aria-live="assertive" className="space-y-2">
          <h2 className="font-semibold">Store service unavailable</h2>
          <p>{error}</p>
          <Button onClick={retry}>Retry Store</Button>
        </section>
      ) : agents ? (
        <ul aria-live="polite" className="space-y-2">
          {agents.map((agent) => (
            <li key={agent.id}>{agent.name}</li>
          ))}
        </ul>
      ) : (
        <Skeleton aria-label="Loading Store" className="h-24 w-full" />
      )}
    </section>
  )
}

export const featureModule: FeatureModuleV1 = {
  sdkApiVersion: 1,
  pages: { catalog: StorePage },
  locales: {
    en: { title: 'Agent Store', description: 'Discover agents and skills' },
    'zh-CN': { title: 'Agent 商店', description: '发现 Agent 和 Skill' },
  },
}

export default featureModule
