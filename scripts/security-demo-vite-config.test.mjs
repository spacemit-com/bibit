import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requireFromWebApp = createRequire(
  path.join(repoRoot, 'web-app', 'package.json')
)
const { resolveConfig } = await import(
  pathToFileURL(requireFromWebApp.resolve('vite')).href
)

test('development keeps Security Demo imports on the real sources', async () => {
  const workspaceRoot = path.join(repoRoot, 'web-app')
  const config = await resolveConfig(
    { configFile: path.join(workspaceRoot, 'vite.config.ts') },
    'serve',
    'development'
  )
  const exactAliases = config.resolve.alias.filter(
    ({ find }) => typeof find === 'string' && find !== '@'
  )
  const sourceAlias = config.resolve.alias.find(({ find }) => find === '@')

  assert.equal(sourceAlias?.replacement, path.join(workspaceRoot, 'src'))
  assert.equal(
    exactAliases.some(({ find }) =>
      [
        '@/features/activeFeatureRegistry',
        '@/components/SecurityDemoApproval',
      ].includes(find)
    ),
    false
  )
})

test('production replaces every Security Demo entry with inert sources', async () => {
  const workspaceRoot = path.join(repoRoot, 'web-app')
  const config = await resolveConfig(
    { configFile: path.join(workspaceRoot, 'vite.config.ts') },
    'build',
    'production'
  )
  const aliases = Object.fromEntries(
    config.resolve.alias
      .filter(({ find }) => typeof find === 'string')
      .map(({ find, replacement }) => [find, replacement])
  )

  assert.equal(
    aliases['@/features/activeFeatureRegistry'],
    path.join(workspaceRoot, 'src/features/activeFeatureRegistry.production.ts')
  )
  assert.equal(
    aliases['@/components/SecurityDemoApproval'],
    path.join(workspaceRoot, 'src/features/disabledFeature.tsx')
  )
})
