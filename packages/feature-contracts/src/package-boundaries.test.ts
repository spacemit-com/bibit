import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type PackageManifest = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const packageRoot = resolve(import.meta.dirname, '../..')
const readPackage = (name: string): PackageManifest =>
  JSON.parse(
    readFileSync(resolve(packageRoot, name, 'package.json'), 'utf8')
  ) as PackageManifest

const runtimeDependencies = (manifest: PackageManifest) => [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]

describe('Feature SDK package boundaries', () => {
  it('keeps contracts free of UI and host runtime dependencies', () => {
    expect(runtimeDependencies(readPackage('feature-contracts'))).not.toEqual(
      expect.arrayContaining([
        'react',
        'react-dom',
        'zustand',
        '@janhq/core',
        '@tauri-apps/api',
        '@janhq/web-app',
      ])
    )
  })

  it.each(['feature-sdk', 'feature-ui'])(
    'keeps %s independent of private host packages',
    (name) => {
      expect(runtimeDependencies(readPackage(name))).not.toEqual(
        expect.arrayContaining([
          'zustand',
          '@janhq/core',
          '@tauri-apps/api',
          '@janhq/web-app',
        ])
      )
    }
  )
})
