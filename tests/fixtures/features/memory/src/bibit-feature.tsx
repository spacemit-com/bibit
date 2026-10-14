import type { FeatureModuleV1, FeatureSettingsProps } from '@bibit/feature-sdk'
import { Button, FeatureEmptyState, FeatureSettingsPage } from '@bibit/feature-ui'

const fixtures = [
  { id: 'memory-42', summary: 'Prefers concise technical answers' },
  { id: 'memory-84', summary: 'Works on the Bibit desktop client' },
] as const

function MemorySettings({ subpath, navigation }: FeatureSettingsProps) {
  const match = /^items\/([^/]+)$/.exec(subpath)
  if (match) {
    const id = match[1]
    const memory = fixtures.find((item) => item.id === id)
    return (
      <FeatureSettingsPage title={`Memory ${id}`} description="Memory detail">
        {memory ? (
          <p>{memory.summary}</p>
        ) : (
          <FeatureEmptyState title="Memory not found" description={id} />
        )}
        <Button onClick={() => navigation.replace('')}>All memories</Button>
      </FeatureSettingsPage>
    )
  }

  return (
    <FeatureSettingsPage title="Memory" description="Saved memory list">
      <ul className="space-y-2" aria-label="Saved memories">
        {fixtures.map((memory) => (
          <li key={memory.id}>
            <Button onClick={() => navigation.push(`items/${memory.id}`)}>
              {memory.summary}
            </Button>
          </li>
        ))}
      </ul>
    </FeatureSettingsPage>
  )
}

export const featureModule: FeatureModuleV1 = {
  sdkApiVersion: 1,
  settings: { manager: MemorySettings },
  locales: {
    en: { title: 'Memory', description: 'Review and manage saved memories' },
    'zh-CN': { title: '记忆', description: '查看和管理已保存的记忆' },
  },
}

export default featureModule
