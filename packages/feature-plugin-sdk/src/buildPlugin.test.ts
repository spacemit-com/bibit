// @vitest-environment node

import { createPublicKey, verify } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import * as tar from 'tar'
import {
  buildPluginBundle,
  generatePluginSigningKey,
} from './buildPlugin.js'

const temporaryDirectories: string[] = []
const require = createRequire(import.meta.url)

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    )
  )
})

describe('plugin bundle builder', () => {
  it('builds a signed, self-contained archive', async () => {
    const root = await createStyledPlugin('')
    await writeFile(
      join(root, 'src/plugin.ts'),
      'globalThis.__pluginMode = process.env.NODE_ENV\n'
    )
    const keys = await generatePluginSigningKey({
      outputDir: join(root, 'keys'),
      keyId: 'development',
    })
    const result = await buildPluginBundle({
      cwd: root,
      privateKeyPath: keys.privateKeyPath,
      keyId: 'development',
    })
    const unpacked = join(root, 'unpacked')
    await mkdir(unpacked)
    await tar.x({ cwd: unpacked, file: result.bundlePath })
    const manifestBytes = await readFile(join(unpacked, 'plugin.json'))
    const signature = JSON.parse(
      await readFile(join(unpacked, 'plugin.sig'), 'utf8')
    )
    const trustEntry = JSON.parse(await readFile(keys.trustEntryPath, 'utf8'))
    const trustStore = JSON.parse(await readFile(keys.trustStorePath, 'utf8'))
    expect(trustStore.keys).toEqual([trustEntry])
    const publicKey = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(trustEntry.publicKey, 'base64').toString('base64url'),
      },
      format: 'jwk',
    })

    expect(
      verify(
        null,
        manifestBytes,
        publicKey,
        Buffer.from(signature.signature, 'base64')
      )
    ).toBe(true)
    const files = result.manifest.files as Record<string, string>
    expect(files['dist/plugin.js']).toMatch(/^[a-f0-9]{64}$/)
    const pluginSource = await readFile(join(unpacked, 'dist/plugin.js'), 'utf8')
    expect(pluginSource).toContain('production')
    expect(pluginSource).not.toContain('process.env.NODE_ENV')
  })

  it('builds an unsigned archive when no signing key is provided', async () => {
    const root = await createStyledPlugin('')
    await writeFile(
      join(root, 'src/plugin.ts'),
      'globalThis.__pluginMode = process.env.NODE_ENV\n'
    )
    const result = await buildPluginBundle({ cwd: root })
    const unpacked = join(root, 'unpacked')
    await mkdir(unpacked)
    await tar.x({ cwd: unpacked, file: result.bundlePath })
    await expect(readFile(join(unpacked, 'plugin.sig'))).rejects.toThrow()
    const files = result.manifest.files as Record<string, string>
    expect(files['dist/plugin.js']).toMatch(/^[a-f0-9]{64}$/)
    const pluginSource = await readFile(join(unpacked, 'dist/plugin.js'), 'utf8')
    expect(pluginSource).toContain('production')
  })

  it('uses the automatic JSX runtime for source-distributed UI packages', async () => {
    const root = await createStyledPlugin('')
    const packageRoot = join(root, 'node_modules/@example/source-ui')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@example/source-ui', exports: './index.tsx' })
    )
    await writeFile(
      join(packageRoot, 'index.tsx'),
      'export const Widget = () => <div>Widget</div>\n'
    )
    await symlink(
      dirname(require.resolve('react/package.json')),
      join(root, 'node_modules/react'),
      'dir'
    )
    await writeFile(
      join(root, 'src/plugin.ts'),
      "import { Widget } from '@example/source-ui'\nglobalThis.__Widget = Widget\n"
    )
    const keys = await generatePluginSigningKey({
      outputDir: join(root, 'keys'),
      keyId: 'development',
    })
    const result = await buildPluginBundle({
      cwd: root,
      privateKeyPath: keys.privateKeyPath,
      keyId: 'development',
    })
    const unpacked = join(root, 'unpacked')
    await mkdir(unpacked)
    await tar.x({ cwd: unpacked, file: result.bundlePath })
    const pluginSource = await readFile(join(unpacked, 'dist/plugin.js'), 'utf8')

    expect(pluginSource).not.toContain('React.createElement')
  })

  it('accepts scoped plugin styles, including descendant universal selectors', async () => {
    const root = await createStyledPlugin(
      '.plugin, .plugin *, .plugin :is(*), :is(.plugin *) { box-sizing: border-box; }'
    )
    const keys = await generatePluginSigningKey({
      outputDir: join(root, 'keys'),
      keyId: 'development',
    })

    await expect(
      buildPluginBundle({
        cwd: root,
        privateKeyPath: keys.privateKeyPath,
        keyId: 'development',
      })
    ).resolves.toMatchObject({
      fileName: 'styled-plugin-0.1.0.bibit-plugin.tgz',
    })
  })

  it.each([
    [':root', ':root'],
    ['html', 'html'],
    ['body', 'body'],
    ['#root', '#root'],
    ['*', '*'],
    ['*::before', '*:before'],
    ['*::after', '*:after'],
    [':where(*)', ':where(*)'],
    [':is(*)', ':is(*)'],
    [':is(.plugin, *)', ':is(.plugin,*)'],
    [':where(.plugin, *)', ':where(.plugin,*)'],
    ['*:not(.plugin)', '*:not(.plugin)'],
    ['* + .plugin', '*+.plugin'],
  ])(
    'rejects the out-of-scope selector %s with the generated CSS file name',
    async (selector, builtSelector) => {
      const root = await createStyledPlugin(`${selector} { color: red; }`)
      const keys = await generatePluginSigningKey({
        outputDir: join(root, 'keys'),
        keyId: 'development',
      })

      await expect(
        buildPluginBundle({
          cwd: root,
          privateKeyPath: keys.privateKeyPath,
          keyId: 'development',
        })
      ).rejects.toThrow(
        `Plugin stylesheet dist/styled-plugin.css contains out-of-scope selector "${builtSelector}"`
      )
    }
  )

  it.each([
    ['@keyframes spin {}', '@keyframes', 'spin'],
    ['@-webkit-keyframes spin {}', '@-webkit-keyframes', 'spin'],
    [
      '@counter-style marker { system: cyclic; symbols: x; }',
      '@counter-style',
      'marker',
    ],
    [
      '@property --accent { syntax: "<color>"; inherits: false; initial-value: red; }',
      '@property',
      '--accent',
    ],
    [
      '@font-face { font-family: "Plugin Font"; src: local(Arial); }',
      '@font-face font-family',
      'Plugin Font',
    ],
  ])(
    'rejects the unprefixed global CSS name from %s',
    async (css, source, globalName) => {
      const root = await createStyledPlugin(css)
      const keys = await generatePluginSigningKey({
        outputDir: join(root, 'keys'),
        keyId: 'development',
      })

      await expect(
        buildPluginBundle({
          cwd: root,
          privateKeyPath: keys.privateKeyPath,
          keyId: 'development',
        })
      ).rejects.toThrow(
        `Plugin stylesheet dist/styled-plugin.css contains unprefixed global CSS name "${globalName}" in ${source}`
      )
    }
  )

  it('accepts feature-prefixed global CSS names', async () => {
    const root = await createStyledPlugin(`
      @keyframes styled-plugin-spin {}
      @-webkit-keyframes styled-plugin-pulse {}
      @counter-style styled-plugin-marker { system: cyclic; symbols: x; }
      @property --styled-plugin-accent { syntax: "<color>"; inherits: false; initial-value: red; }
      @font-face { font-family: "styled-plugin-font"; src: local(Arial); }
    `)
    const keys = await generatePluginSigningKey({
      outputDir: join(root, 'keys'),
      keyId: 'development',
    })

    await expect(
      buildPluginBundle({
        cwd: root,
        privateKeyPath: keys.privateKeyPath,
        keyId: 'development',
      })
    ).resolves.toMatchObject({
      fileName: 'styled-plugin-0.1.0.bibit-plugin.tgz',
    })
  })

  it('rejects a package version that differs from the Feature Manifest', async () => {
    const root = await createStyledPlugin('')
    const packageJson = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8')
    )
    packageJson.version = '0.2.0'
    await writeFile(join(root, 'package.json'), JSON.stringify(packageJson))
    const keys = await generatePluginSigningKey({
      outputDir: join(root, 'keys'),
      keyId: 'development',
    })

    await expect(
      buildPluginBundle({
        cwd: root,
        privateKeyPath: keys.privateKeyPath,
        keyId: 'development',
      })
    ).rejects.toThrow(
      'package.json version 0.2.0 does not match Feature Manifest version 0.1.0'
    )
  })

  it('keeps the existing CLI build command compatible', async () => {
    const root = await createStyledPlugin('')
    const keys = await generatePluginSigningKey({
      outputDir: join(root, 'keys'),
      keyId: 'development',
    })
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../bin/bibit-plugin.mjs', import.meta.url)),
        'build',
        '--key',
        keys.privateKeyPath,
        '--key-id',
        'development',
      ],
      { cwd: root, encoding: 'utf8' }
    )

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain(
      'styled-plugin-0.1.0.bibit-plugin.tgz'
    )
  })
})

async function createStyledPlugin(css: string) {
  const root = await mkdtemp(join(tmpdir(), 'bibit-styled-plugin-test-'))
  temporaryDirectories.push(root)
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/plugin.ts'), "import './plugin.css'\n")
  await writeFile(join(root, 'src/plugin.css'), css)
  await writeFile(
    join(root, 'bibit.feature.json'),
    JSON.stringify({
      manifestSchemaVersion: 1,
      sdkApiVersion: 1,
      id: 'styled-plugin',
      version: '0.1.0',
      owner: 'styled-plugin-team',
      display: {
        titleKey: 'styled-plugin:title',
        fallbackTitle: 'Styled plugin',
        iconKey: 'store',
      },
      targets: ['desktop'],
      requiredHostCapabilities: [],
      contributions: {
        pages: [],
        settings: [],
        conversation: [],
        locales: ['en'],
      },
    })
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@example/styled-plugin',
      version: '0.1.0',
      bibitPlugin: {
        entry: 'src/plugin.ts',
        manifest: 'bibit.feature.json',
      },
    })
  )
  return root
}
