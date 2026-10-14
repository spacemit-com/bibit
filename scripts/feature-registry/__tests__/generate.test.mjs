import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { generateRegistry } from '../generate.mjs'

const testDirectory = dirname(fileURLToPath(import.meta.url))
const fixtureDirectory = resolve(testDirectory, '../__fixtures__')
const sdkFixtureDirectory = resolve(
  testDirectory,
  '../../../tests/fixtures/features'
)
const repositoryRoot = resolve(testDirectory, '../../..')
const schemaPath = resolve(
  repositoryRoot,
  'packages/feature-contracts/schema/bibit-feature.schema.json'
)
const temporaryDirectories = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function createRepository() {
  const rootDir = await mkdtemp(resolve(tmpdir(), 'bibit-feature-registry-'))
  temporaryDirectories.push(rootDir)
  await writeJson(resolve(rootDir, 'package.json'), {
    private: true,
    workspaces: { packages: ['modules/*'] },
  })
  await addFeature(rootDir, 'store')
  await writeJson(resolve(rootDir, 'config/feature-capability-grants.json'), {
    version: 1,
    features: { store: ['external-service:store'] },
  })
  return rootDir
}

async function addFeature(rootDir, id, mutate = (value) => value) {
  const target = resolve(rootDir, 'modules', id)
  await cp(resolve(fixtureDirectory, 'valid-page'), target, { recursive: true })
  const packagePath = resolve(target, 'package.json')
  const manifestPath = resolve(target, 'bibit.feature.json')
  const packageJson = await readJson(packagePath)
  packageJson.name = `@bibit/feature-${id}`
  const manifest = await readJson(manifestPath)
  manifest.id = id
  manifest.display.titleKey = `${id}:title`
  manifest.display.fallbackTitle = id
  const updated = mutate({ packageJson, manifest }) ?? { packageJson, manifest }
  await writeJson(packagePath, updated.packageJson)
  await writeJson(manifestPath, updated.manifest)
  return { packagePath, manifestPath, packageDir: target }
}

const generate = (rootDir, options = {}) =>
  generateRegistry({ rootDir, schemaPath, ...options })

describe('Feature Registry generator', () => {
  test('injects SDK proof fixtures through the test harness only', async () => {
    const rootDir = await mkdtemp(resolve(tmpdir(), 'bibit-feature-sdk-fixtures-'))
    temporaryDirectories.push(rootDir)
    await writeJson(resolve(rootDir, 'package.json'), {
      private: true,
      workspaces: { packages: ['features/*'] },
    })
    await cp(sdkFixtureDirectory, resolve(rootDir, 'features'), {
      recursive: true,
    })
    await writeJson(resolve(rootDir, 'config/feature-capability-grants.json'), {
      version: 1,
      features: {
        memory: ['external-service:memory'],
        security: ['external-service:security', 'runtime:permission'],
        store: ['external-service:store'],
      },
    })

    const result = await generate(rootDir)
    const source = await readFile(result.outputPath, 'utf8')

    assert.equal(result.featureCount, 3)
    assert.match(source, /@bibit\/feature-store\/bibit-feature/)
    assert.match(source, /@bibit\/feature-memory\/bibit-feature/)
    assert.match(source, /@bibit\/feature-security\/bibit-feature/)

    const productionSource = await readFile(
      resolve(repositoryRoot, 'web-app/src/features/generated/feature-registry.gen.ts'),
      'utf8'
    )
    assert.doesNotMatch(productionSource, /@bibit\/feature-(store|memory|security)/)
  })

  test('discovers opt-in workspaces and emits a static lazy import', async () => {
    const rootDir = await createRepository()
    const result = await generate(rootDir)
    const source = await readFile(result.outputPath, 'utf8')

    assert.match(source, /Generator version: 1\.0\.0/)
    assert.match(source, /Canonical input SHA-256: [a-f0-9]{64}/)
    assert.match(
      source,
      /\(\) => import\('@bibit\/feature-store\/bibit-feature'\)/
    )
    assert.match(source, /"targets": \[\s+"desktop"/)
    assert.doesNotMatch(
      source,
      /import .* from ['"]@bibit\/feature-store\/bibit-feature/
    )
  })

  test('is byte deterministic and preserves mtime when unchanged', async () => {
    const rootDir = await createRepository()
    const first = await generate(rootDir)
    const source = await readFile(first.outputPath)
    const oldDate = new Date('2020-01-01T00:00:00.000Z')
    await utimes(first.outputPath, oldDate, oldDate)

    const second = await generate(rootDir)
    assert.equal(second.changed, false)
    assert.deepEqual(await readFile(second.outputPath), source)
    assert.equal((await stat(second.outputPath)).mtimeMs, oldDate.getTime())
  })

  test('sorts Feature entries independently of workspace discovery order', async () => {
    const rootDir = await createRepository()
    await addFeature(rootDir, 'memory', ({ packageJson, manifest }) => {
      manifest.requiredHostCapabilities = []
      return { packageJson, manifest }
    })
    const result = await generate(rootDir)
    const source = await readFile(result.outputPath, 'utf8')
    assert.ok(
      source.indexOf("packageName: '@bibit/feature-memory'") <
        source.indexOf("packageName: '@bibit/feature-store'")
    )
  })

  test('check mode rejects missing and stale output, then accepts fresh output', async () => {
    const rootDir = await createRepository()
    await assert.rejects(generate(rootDir, { check: true }), /missing/)
    const result = await generate(rootDir)
    await writeFile(result.outputPath, '// stale\n')
    await assert.rejects(generate(rootDir, { check: true }), /stale/)
    await generate(rootDir)
    assert.equal((await generate(rootDir, { check: true })).changed, false)
  })

  test('rejects schema violations before global validation', async () => {
    const rootDir = await createRepository()
    const invalid = await readJson(
      resolve(fixtureDirectory, 'invalid-manifests/unknown-capability.json')
    )
    await writeJson(resolve(rootDir, 'modules/store/bibit.feature.json'), invalid)
    await assert.rejects(generate(rootDir), /schema validation failed.*requiredHostCapabilities/s)
  })

  test('rejects incompatible SDK and malformed group and icon tokens', async (t) => {
    const cases = [
      ['SDK API', (manifest) => (manifest.sdkApiVersion = 2), /sdkApiVersion/],
      [
        'navigation group',
        (manifest) =>
          (manifest.contributions.pages[0].navigation.group = 'rocket_icon'),
        /navigation.*group|group/s,
      ],
      [
        'icon',
        (manifest) => (manifest.display.iconKey = 'rocket_icon'),
        /iconKey/,
      ],
    ]
    for (const [name, mutate, pattern] of cases) {
      await t.test(name, async () => {
        const rootDir = await createRepository()
        const path = resolve(rootDir, 'modules/store/bibit.feature.json')
        const manifest = await readJson(path)
        mutate(manifest)
        await writeJson(path, manifest)
        await assert.rejects(generate(rootDir), pattern)
      })
    }
  })

  test('accepts a group and icon token this build does not know', async () => {
    const rootDir = await createRepository()
    const path = resolve(rootDir, 'modules/store/bibit.feature.json')
    const manifest = await readJson(path)
    manifest.display.iconKey = 'rocket'
    manifest.contributions.pages[0].navigation.group = 'diagnostics'
    await writeJson(path, manifest)

    await generate(rootDir)
  })

  test('rejects manifest paths that escape the package root', async () => {
    const rootDir = await createRepository()
    const packagePath = resolve(rootDir, 'modules/store/package.json')
    const packageJson = await readJson(packagePath)
    packageJson.bibitFeature = '../outside.json'
    await writeJson(packagePath, packageJson)
    await assert.rejects(generate(rootDir), /bibitFeature.*package root/)
  })

  test('requires a resolvable package ./bibit-feature export', async (t) => {
    await t.test('missing export', async () => {
      const rootDir = await createRepository()
      const packagePath = resolve(rootDir, 'modules/store/package.json')
      const packageJson = await readJson(packagePath)
      delete packageJson.exports['./bibit-feature']
      await writeJson(packagePath, packageJson)
      await assert.rejects(generate(rootDir), /\.\/bibit-feature export/)
    })

    await t.test('missing export target', async () => {
      const rootDir = await createRepository()
      const packagePath = resolve(rootDir, 'modules/store/package.json')
      const packageJson = await readJson(packagePath)
      packageJson.exports['./bibit-feature'] = './src/missing.ts'
      await writeJson(packagePath, packageJson)
      await assert.rejects(generate(rootDir), /export target.*does not exist/)
    })
  })

  test('rejects capabilities without a host grant', async () => {
    const rootDir = await createRepository()
    await writeJson(resolve(rootDir, 'config/feature-capability-grants.json'), {
      version: 1,
      features: { store: [] },
    })
    await assert.rejects(generate(rootDir), /not granted.*external-service:store/)
  })

  test('accepts grants reserved for separately installed plugins', async () => {
    const rootDir = await createRepository()
    await writeJson(resolve(rootDir, 'config/feature-capability-grants.json'), {
      version: 1,
      features: {
        store: ['external-service:store'],
        security: ['external-service:security', 'runtime:permission'],
      },
    })

    const result = await generate(rootDir)
    assert.equal(result.featureCount, 1)
  })

  test('validates dynamic service capabilities and operation grants', async () => {
    const rootDir = await createRepository()
    const manifestPath = resolve(rootDir, 'modules/store/bibit.feature.json')
    const manifest = await readJson(manifestPath)
    manifest.requiredHostCapabilities = ['service:knowledge-index']
    await writeJson(manifestPath, manifest)
    await writeJson(resolve(rootDir, 'config/feature-capability-grants.json'), {
      version: 1,
      features: { store: ['service:knowledge-index'] },
      serviceOperations: {
        store: { 'knowledge-index': ['documents.search.v1'] },
      },
    })

    await assert.doesNotReject(generate(rootDir))

    const grants = await readJson(
      resolve(rootDir, 'config/feature-capability-grants.json')
    )
    grants.serviceOperations.store['knowledge-index'] = ['../shell']
    await writeJson(
      resolve(rootDir, 'config/feature-capability-grants.json'),
      grants
    )
    await assert.rejects(generate(rootDir), /invalid operation/)
  })

  test('rejects duplicate Feature and contribution IDs', async (t) => {
    await t.test('duplicate Feature ID', async () => {
      const rootDir = await createRepository()
      const duplicate = await addFeature(rootDir, 'duplicate')
      const packageJson = await readJson(duplicate.packagePath)
      const manifest = await readJson(duplicate.manifestPath)
      packageJson.name = '@bibit/feature-store'
      manifest.id = 'store'
      await writeJson(duplicate.packagePath, packageJson)
      await writeJson(duplicate.manifestPath, manifest)
      await assert.rejects(generate(rootDir), /duplicate Feature id: store/)
    })

    await t.test('duplicate contribution ID', async () => {
      const rootDir = await createRepository()
      const path = resolve(rootDir, 'modules/store/bibit.feature.json')
      const manifest = await readJson(path)
      manifest.contributions.settings.push({
        id: 'home',
        path: '',
        surfaces: ['main'],
      })
      await writeJson(path, manifest)
      await assert.rejects(generate(rootDir), /duplicate contribution id.*home/)
    })
  })

  test('rejects duplicate and prefix-overlapping final URLs', async (t) => {
    await t.test('duplicate URL', async () => {
      const rootDir = await createRepository()
      const path = resolve(rootDir, 'modules/store/bibit.feature.json')
      const manifest = await readJson(path)
      manifest.contributions.pages.push({
        id: 'other',
        path: '',
        surfaces: ['main'],
      })
      await writeJson(path, manifest)
      await assert.rejects(generate(rootDir), /duplicate final URL/)
    })

    await t.test('prefix overlap', async () => {
      const rootDir = await createRepository()
      const invalid = await readJson(
        resolve(fixtureDirectory, 'invalid-manifests/overlapping-paths.json')
      )
      await writeJson(resolve(rootDir, 'modules/store/bibit.feature.json'), invalid)
      await assert.rejects(generate(rootDir), /overlapping final URLs/)
    })
  })

  test('allows only one permission presenter per surface', async () => {
    const rootDir = await createRepository()
    const storePath = resolve(rootDir, 'modules/store/bibit.feature.json')
    const store = await readJson(storePath)
    store.contributions.conversation.push({
      id: 'permission',
      kind: 'permission-presenter',
      surfaces: ['main'],
    })
    await writeJson(storePath, store)
    await addFeature(rootDir, 'security', ({ packageJson, manifest }) => {
      manifest.requiredHostCapabilities = []
      manifest.contributions.conversation.push({
        id: 'permission',
        kind: 'permission-presenter',
        surfaces: ['main'],
      })
      return { packageJson, manifest }
    })
    await assert.rejects(generate(rootDir), /permission-presenter.*main.*exclusive/)
  })

  test('ignores target environment when producing the canonical Registry', async () => {
    const rootDir = await createRepository()
    const desktop = await generate(rootDir, { environment: { target: 'desktop' } })
    const desktopSource = await readFile(desktop.outputPath)
    const mobile = await generate(rootDir, { environment: { target: 'mobile' } })
    assert.deepEqual(await readFile(mobile.outputPath), desktopSource)
  })

  test('runs generation explicitly before web and Tauri entrypoints', async () => {
    const rootPackage = await readJson(resolve(repositoryRoot, 'package.json'))
    const webPackage = await readJson(resolve(repositoryRoot, 'web-app/package.json'))
    const rootEntrypoints = [
      'test:web',
      'dev:tauri',
      'build:tauri',
      'build:tauri:linux',
      'build:deb:linux',
    ]
    const webEntrypoints = ['dev', 'build', 'test', 'test:coverage']

    for (const entrypoint of rootEntrypoints) {
      assert.match(
        rootPackage.scripts[entrypoint],
        /^yarn feature:registry && /,
        `root ${entrypoint} must generate explicitly`
      )
    }
    for (const entrypoint of webEntrypoints) {
      assert.match(
        webPackage.scripts[entrypoint],
        /^yarn feature:registry && /,
        `web ${entrypoint} must generate explicitly`
      )
    }
  })
})
