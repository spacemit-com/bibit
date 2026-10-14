import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildPluginBundle,
  generatePluginSigningKey,
} from '../packages/feature-plugin-sdk/src/buildPlugin.js'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const root = await mkdtemp(join(tmpdir(), 'bibit-plugin-interop-'))

try {
  const keys = await generatePluginSigningKey({
    outputDir: join(root, 'keys'),
    keyId: 'interop',
  })
  const security = await buildCompatibilityFixture({
    root,
    keys,
    packageName: '@bibit-internal/security-plugin',
    manifest: {
      manifestSchemaVersion: 1,
      sdkApiVersion: 1,
      id: 'security',
      version: '0.2.3',
      owner: 'security-team',
      display: {
        titleKey: 'security:title',
        fallbackTitle: 'Security',
        iconKey: 'security',
        descriptionKey: 'security:description',
        fallbackDescription: 'Inline permission approval for Agent actions',
      },
      targets: ['desktop'],
      requiredHostCapabilities: [
        'external-service:security',
        'runtime:permission',
      ],
      contributions: {
        pages: [],
        settings: [
          {
            id: 'settings',
            path: '',
            surfaces: ['main'],
            navigation: { group: 'privacy', order: 100 },
          },
        ],
        conversation: [
          {
            id: 'permission',
            kind: 'permission-presenter',
            surfaces: ['main'],
            order: 100,
          },
        ],
        locales: ['en', 'zh'],
      },
    },
  })
  const agentHub = await buildCompatibilityFixture({
    root,
    keys,
    packageName: '@bibit-internal/agent-hub-plugin',
    manifest: {
      manifestSchemaVersion: 1,
      sdkApiVersion: 1,
      id: 'agent-hub',
      version: '0.3.0',
      owner: 'agent-hub-team',
      display: {
        titleKey: 'agent-hub:title',
        fallbackTitle: 'Agent Hub',
        iconKey: 'store',
        descriptionKey: 'agent-hub:description',
        fallbackDescription: 'Browse and manage Agent packages',
      },
      targets: ['desktop'],
      requiredHostCapabilities: [
        'service:store',
        'file:transfer',
        'job:manage',
      ],
      contributions: {
        pages: [
          {
            id: 'home',
            path: '',
            surfaces: ['main'],
            navigation: { group: 'library', order: 100 },
          },
        ],
        settings: [
          {
            id: 'settings',
            path: '',
            surfaces: ['main'],
            navigation: { group: 'integrations', order: 100 },
          },
        ],
        conversation: [],
        locales: ['en'],
      },
    },
  })

  const result = spawnSync(
    'cargo',
    [
      'test',
      '--locked',
      '--lib',
      '--features',
      'runtime-test-agent',
      '--manifest-path',
      'src-tauri/Cargo.toml',
      'trusted_plugins::tests::installs_sdk_generated_bundle',
      '--',
      '--exact',
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        BIBIT_PLUGIN_INTEROP_BUNDLE: security.bundlePath,
        BIBIT_PLUGIN_INTEROP_TRUST_STORE: keys.trustStorePath,
        BIBIT_PLUGIN_INTEROP_ID: 'security',
        BIBIT_PLUGIN_INTEROP_BUNDLE_2: agentHub.bundlePath,
        BIBIT_PLUGIN_INTEROP_ID_2: 'agent-hub',
      },
      encoding: 'utf8',
    }
  )
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
} finally {
  await rm(root, { recursive: true, force: true })
}

async function buildCompatibilityFixture({
  root,
  keys,
  packageName,
  manifest,
}) {
  const { id, version } = manifest
  const pluginRoot = join(root, id)
  await mkdir(join(pluginRoot, 'src'), { recursive: true })
  await writeFile(
    join(pluginRoot, 'src/plugin.ts'),
    `globalThis.__bibitCompatibilityFixture = '${id}'\n`
  )
  await writeFile(
    join(pluginRoot, 'bibit.feature.json'),
    JSON.stringify(manifest)
  )
  await writeFile(
    join(pluginRoot, 'package.json'),
    JSON.stringify({
      name: packageName,
      version,
      bibitPlugin: {
        entry: 'src/plugin.ts',
        manifest: 'bibit.feature.json',
      },
    })
  )
  const built = await buildPluginBundle({
    cwd: pluginRoot,
    privateKeyPath: keys.privateKeyPath,
    keyId: 'interop',
  })
  assert.equal(built.fileName, `${id}-${version}.bibit-plugin.tgz`)
  return built
}
