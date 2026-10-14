import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverFeatures } from './lib/discover.mjs'
import { validateFeatures } from './lib/validate.mjs'
import {
  canonicalInputDigest,
  renderRegistry,
} from './lib/render.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const defaultRoot = resolve(dirname(scriptPath), '../..')

const readJson = async (path, label) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`${label} could not be read: ${path}`, { cause: error })
  }
}

const readGenerated = async (outputPath) => {
  try {
    return await readFile(outputPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function atomicWrite(outputPath, source) {
  await mkdir(dirname(outputPath), { recursive: true })
  const temporaryPath = resolve(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`
  )
  try {
    await writeFile(temporaryPath, source, { flag: 'wx' })
    await rename(temporaryPath, outputPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export async function generateRegistry({
  rootDir = defaultRoot,
  schemaPath = resolve(
    rootDir,
    'packages/feature-contracts/schema/bibit-feature.schema.json'
  ),
  grantsPath = resolve(rootDir, 'config/feature-capability-grants.json'),
  outputPath = resolve(
    rootDir,
    'web-app/src/features/generated/feature-registry.gen.ts'
  ),
  check = false,
} = {}) {
  const [features, schema, grants] = await Promise.all([
    discoverFeatures(rootDir),
    readJson(schemaPath, 'canonical Feature Manifest Schema'),
    readJson(grantsPath, 'Feature capability grants'),
  ])
  const validatedFeatures = validateFeatures(features, schema, grants)
  const digest = canonicalInputDigest({
    features: validatedFeatures,
    grants,
    schema,
  })
  const source = renderRegistry(validatedFeatures, digest)
  const current = await readGenerated(outputPath)

  if (check) {
    if (current === undefined) {
      throw new Error(
        `generated Feature Registry is missing: ${outputPath}; run yarn feature:registry`
      )
    }
    if (current !== source) {
      throw new Error(
        `generated Feature Registry is stale: ${outputPath}; run yarn feature:registry`
      )
    }
    return { changed: false, digest, outputPath, featureCount: validatedFeatures.length }
  }

  if (current === source) {
    return { changed: false, digest, outputPath, featureCount: validatedFeatures.length }
  }
  await atomicWrite(outputPath, source)
  return { changed: true, digest, outputPath, featureCount: validatedFeatures.length }
}

async function main() {
  const arguments_ = process.argv.slice(2)
  if (arguments_.some((argument) => argument !== '--check')) {
    throw new Error(`unknown argument: ${arguments_.find((argument) => argument !== '--check')}`)
  }
  const result = await generateRegistry({ check: arguments_.includes('--check') })
  const action = arguments_.includes('--check')
    ? 'verified'
    : result.changed
      ? 'generated'
      : 'unchanged'
  console.log(
    `Feature Registry ${action}: ${result.featureCount} feature(s), ${result.digest}`
  )
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
