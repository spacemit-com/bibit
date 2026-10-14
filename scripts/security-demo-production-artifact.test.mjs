import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(repoRoot, 'web-app', 'dist')
const forbiddenFileName =
  /SecurityDemoApproval|securityFeatureModule|securityDemoApprovalStore/
const forbiddenContent = [
  {
    marker: 'security-demo-runtime',
    source: 'web-app/src/features/demo/securityDemoApprovalStore.ts',
  },
  {
    marker: '规则已保存到模拟安全服务',
    source: 'web-app/src/features/demo/securityFeatureModule.tsx',
  },
]

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(entryPath)))
    else if (entry.isFile()) files.push(entryPath)
  }

  return files
}

test('production Web artifact excludes the Security Demo', async () => {
  const leaks = []

  for (const file of await collectFiles(distDir)) {
    const relativePath = path.relative(distDir, file)
    if (forbiddenFileName.test(relativePath)) leaks.push(relativePath)

    if (/\.(?:css|html|js|json)$/.test(file)) {
      const contents = await readFile(file, 'utf8')
      for (const { marker } of forbiddenContent) {
        if (contents.includes(marker)) leaks.push(`${relativePath}: ${marker}`)
      }
    }
  }

  assert.deepEqual(leaks, [])
})

test('production leak markers remain anchored in Demo sources', async () => {
  for (const { marker, source } of forbiddenContent) {
    const contents = await readFile(path.join(repoRoot, source), 'utf8')
    assert.ok(contents.includes(marker), `${marker} is missing from ${source}`)
  }
})
