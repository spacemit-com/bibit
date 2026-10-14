import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import Ajv from 'ajv'
import postcss from 'postcss'
import selectorParser from 'postcss-selector-parser'
import * as tar from 'tar'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const schema = JSON.parse(
  await readFile(
    require.resolve(
      '@bibit/feature-contracts/schema/bibit-feature.schema.json'
    ),
    'utf8'
  )
)
const validateManifest = new Ajv({ allErrors: true }).compile(schema)

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

const listFiles = async (root) => {
  const files = []
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  await visit(root)
  return files.sort()
}

const invalidGlobalSelector = (selector) => {
  let invalid
  selectorParser((root) => {
    root.each((candidate) => {
      candidate.walk((node) => {
        if (
          (node.type === 'pseudo' && node.value.toLowerCase() === ':root') ||
          (node.type === 'tag' &&
            ['html', 'body'].includes(node.value.toLowerCase())) ||
          (node.type === 'id' && node.value.toLowerCase() === 'root')
        ) {
          invalid ??= candidate.toString()
        }
      })
      if (hasUnqualifiedUniversalBranch(candidate)) {
        invalid ??= candidate.toString()
      }
    })
  }).processSync(selector)
  return invalid
}

const hasUnqualifiedUniversalBranch = (selector) => {
  const combinatorIndex = selector.nodes.findIndex(
    (node) => node.type === 'combinator'
  )
  const firstCompound = selector.nodes.slice(
    0,
    combinatorIndex === -1 ? selector.nodes.length : combinatorIndex
  )
  if (
    firstCompound.some((node) =>
      ['class', 'id', 'attribute', 'tag'].includes(node.type)
    )
  ) {
    return false
  }
  if (
    firstCompound.some(
      (node) => node.type === 'universal' && node.namespace == null
    )
  ) {
    return true
  }
  return selector.nodes.some(
    (node) =>
      node.type === 'pseudo' &&
      [':is', ':where'].includes(node.value.toLowerCase()) &&
      node.nodes?.some(hasUnqualifiedUniversalBranch)
  )
}

const cssName = (value) => {
  const trimmed = value.trim()
  return /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed
}

const validatePluginStyles = async (distRoot, featureId) => {
  for (const path of await listFiles(distRoot)) {
    if (!path.endsWith('.css')) continue
    const name = `dist/${relative(distRoot, path).replaceAll('\\', '/')}`
    const root = postcss.parse(await readFile(path, 'utf8'), { from: name })
    root.walkRules((rule) => {
      const invalid = invalidGlobalSelector(rule.selector)
      if (invalid) {
        throw new Error(
          `Plugin stylesheet ${name} contains out-of-scope selector "${invalid}"`
        )
      }
    })
    root.walkAtRules((atRule) => {
      const atRuleName = atRule.name.toLowerCase()
      if (
        ['keyframes', '-webkit-keyframes', 'counter-style', 'property'].includes(
          atRuleName
        )
      ) {
        const globalName = cssName(atRule.params)
        const comparableName =
          atRuleName === 'property' ? globalName.replace(/^--/, '') : globalName
        if (!comparableName.startsWith(`${featureId}-`)) {
          throw new Error(
            `Plugin stylesheet ${name} contains unprefixed global CSS name "${globalName}" in @${atRuleName}`
          )
        }
      }
      if (atRuleName === 'font-face') {
        atRule.walkDecls((declaration) => {
          if (declaration.prop.toLowerCase() !== 'font-family') return
          const globalName = cssName(declaration.value)
          if (!globalName.startsWith(`${featureId}-`)) {
            throw new Error(
              `Plugin stylesheet ${name} contains unprefixed global CSS name "${globalName}" in @font-face font-family`
            )
          }
        })
      }
    })
  }
}

export async function generatePluginSigningKey({ outputDir, keyId }) {
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(keyId)) {
    throw new Error('keyId must be a 2-64 character lowercase identifier')
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPath = join(outputDir, `${keyId}-private.pem`)
  const trustEntryPath = join(outputDir, `${keyId}-public.json`)
  const trustStorePath = join(outputDir, `${keyId}-trust-store.json`)
  const publicJwk = publicKey.export({ format: 'jwk' })
  const trustEntry = {
    keyId,
    publicKey: Buffer.from(publicJwk.x, 'base64url').toString('base64'),
  }
  await mkdir(outputDir, { recursive: true })
  await writeFile(
    privateKeyPath,
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 }
  )
  await chmod(privateKeyPath, 0o600)
  await writeFile(
    trustEntryPath,
    `${JSON.stringify(
      trustEntry,
      null,
      2
    )}\n`
  )
  await writeFile(
    trustStorePath,
    `${JSON.stringify({ version: 1, keys: [trustEntry] }, null, 2)}\n`
  )
  return { privateKeyPath, trustEntryPath, trustStorePath }
}

/**
 * @param {{ cwd: string, privateKeyPath?: string, keyId?: string }} options
 */
export async function buildPluginBundle({ cwd, privateKeyPath, keyId }) {
  const packageJson = await readJson(join(cwd, 'package.json'))
  const config = packageJson.bibitPlugin
  if (!config || typeof config.entry !== 'string' || typeof config.manifest !== 'string') {
    throw new Error('package.json must define bibitPlugin.entry and bibitPlugin.manifest')
  }
  const featureManifest = await readJson(resolve(cwd, config.manifest))
  if (!validateManifest(featureManifest)) {
    const firstError = validateManifest.errors?.[0]
    throw new Error(
      `Feature Manifest is invalid: ${firstError?.instancePath || '/'} ${firstError?.message || ''}`
    )
  }
  if (packageJson.version !== featureManifest.version) {
    throw new Error(
      `package.json version ${packageJson.version} does not match Feature Manifest version ${featureManifest.version}`
    )
  }
  const stagingRoot = await mkdtemp(join(tmpdir(), 'bibit-plugin-'))
  const distRoot = join(stagingRoot, 'dist')
  try {
    await build({
      configFile: false,
      root: cwd,
      logLevel: 'warn',
      define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
      },
      esbuild: { jsx: 'automatic' },
      build: {
        emptyOutDir: true,
        outDir: distRoot,
        cssCodeSplit: false,
        lib: {
          entry: resolve(cwd, config.entry),
          formats: ['es'],
          fileName: () => 'plugin.js',
        },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    })
    await validatePluginStyles(distRoot, featureManifest.id)
    const files = {}
    for (const path of await listFiles(distRoot)) {
      const name = `dist/${relative(distRoot, path).replaceAll('\\', '/')}`
      files[name] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    }
    const styles = Object.keys(files).filter((path) => path.endsWith('.css'))
    const pluginManifest = {
      pluginSchemaVersion: 1,
      featureManifest,
      entry: 'dist/plugin.js',
      styles,
      files,
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(pluginManifest, null, 2)}\n`)
    await writeFile(join(stagingRoot, 'plugin.json'), manifestBytes)
    const signed = privateKeyPath != null && keyId != null
    if (signed) {
      const privateKey = await readFile(privateKeyPath, 'utf8')
      const signature = sign(null, manifestBytes, privateKey).toString('base64')
      await writeFile(
        join(stagingRoot, 'plugin.sig'),
        `${JSON.stringify({ keyId, signature }, null, 2)}\n`
      )
    }
    const artifactDir = resolve(cwd, config.artifactDir ?? 'artifacts')
    const bundlePath = join(
      artifactDir,
      `${featureManifest.id}-${featureManifest.version}.bibit-plugin.tgz`
    )
    await mkdir(dirname(bundlePath), { recursive: true })
    await tar.c(
      {
        gzip: true,
        cwd: stagingRoot,
        file: bundlePath,
        portable: true,
        noMtime: true,
      },
      signed ? ['plugin.json', 'plugin.sig', 'dist'] : ['plugin.json', 'dist']
    )
    return {
      bundlePath,
      manifest: pluginManifest,
      fileName: basename(bundlePath),
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}
