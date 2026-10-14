import { readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const readJson = async (path, label) => {
  let source
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`${label} does not exist: ${path}`, { cause: error })
  }
  try {
    return JSON.parse(source)
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${path}`, { cause: error })
  }
}

const isWithin = (parent, child) => {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

async function expandWorkspacePattern(rootDir, pattern) {
  const segments = pattern.replaceAll('\\', '/').split('/').filter(Boolean)
  let candidates = [rootDir]

  for (const segment of segments) {
    if (segment === '..') {
      throw new Error(`workspace pattern escapes repository root: ${pattern}`)
    }
    const next = []
    for (const candidate of candidates) {
      if (segment === '*') {
        let entries = []
        try {
          entries = await readdir(candidate, { withFileTypes: true })
        } catch (error) {
          if (error.code === 'ENOENT') continue
          throw error
        }
        next.push(
          ...entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => resolve(candidate, entry.name))
        )
      } else if (segment.includes('*')) {
        throw new Error(`unsupported workspace pattern: ${pattern}`)
      } else {
        next.push(resolve(candidate, segment))
      }
    }
    candidates = next
  }

  return candidates
}

const workspacePatterns = (rootPackage) => {
  if (Array.isArray(rootPackage.workspaces)) return rootPackage.workspaces
  if (Array.isArray(rootPackage.workspaces?.packages)) {
    return rootPackage.workspaces.packages
  }
  throw new Error('root package.json must declare Yarn workspaces')
}

const selectExportTarget = (value) => {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  for (const condition of ['import', 'default', 'types']) {
    const selected = selectExportTarget(value[condition])
    if (selected) return selected
  }
  for (const candidate of Object.values(value)) {
    const selected = selectExportTarget(candidate)
    if (selected) return selected
  }
  return undefined
}

async function validateFeatureExport(packageDir, packageJson) {
  const exportDefinition =
    packageJson.exports && typeof packageJson.exports === 'object'
      ? packageJson.exports['./bibit-feature']
      : undefined
  if (!exportDefinition) {
    throw new Error(`${packageJson.name} is missing the ./bibit-feature export`)
  }

  const exportTarget = selectExportTarget(exportDefinition)
  if (!exportTarget || isAbsolute(exportTarget) || !exportTarget.startsWith('./')) {
    throw new Error(`${packageJson.name} ./bibit-feature export must target a package-relative file`)
  }
  const resolvedTarget = resolve(packageDir, exportTarget)
  if (!isWithin(packageDir, resolvedTarget)) {
    throw new Error(`${packageJson.name} ./bibit-feature export escapes the package root`)
  }
  const resolvedTargetPath = realpath(resolvedTarget).catch((error) => {
    throw new Error(
      `${packageJson.name} ./bibit-feature export target does not exist`,
      { cause: error }
    )
  })
  const [actualPackageDir, actualTarget] = await Promise.all([
    realpath(packageDir),
    resolvedTargetPath,
  ])
  if (!isWithin(actualPackageDir, actualTarget)) {
    throw new Error(`${packageJson.name} ./bibit-feature export escapes the package root through a symlink`)
  }
  return exportTarget
}

async function readFeaturePackage(packageDir) {
  const packagePath = resolve(packageDir, 'package.json')
  let packageJson
  try {
    packageJson = await readJson(packagePath, 'workspace package.json')
  } catch (error) {
    if (error.cause?.code === 'ENOENT') return undefined
    throw error
  }
  if (!Object.hasOwn(packageJson, 'bibitFeature')) return undefined
  if (typeof packageJson.bibitFeature !== 'string' || !packageJson.bibitFeature) {
    throw new Error(`${packageJson.name ?? packageDir} bibitFeature must be a relative path`)
  }
  if (
    isAbsolute(packageJson.bibitFeature) ||
    packageJson.bibitFeature.split(/[\\/]/).includes('..')
  ) {
    throw new Error(`${packageJson.name ?? packageDir} bibitFeature escapes the package root`)
  }

  const manifestPath = resolve(packageDir, packageJson.bibitFeature)
  if (!isWithin(packageDir, manifestPath)) {
    throw new Error(`${packageJson.name ?? packageDir} bibitFeature escapes the package root`)
  }
  const manifest = await readJson(manifestPath, 'Feature Manifest')
  const actualPackageDir = await realpath(packageDir)
  const actualManifestPath = await realpath(manifestPath)
  if (!isWithin(actualPackageDir, actualManifestPath)) {
    throw new Error(`${packageJson.name ?? packageDir} bibitFeature escapes the package root through a symlink`)
  }

  if (typeof packageJson.name !== 'string' || !packageJson.name) {
    throw new Error(`Feature workspace is missing package name: ${packagePath}`)
  }
  const exportTarget = await validateFeatureExport(packageDir, packageJson)
  return {
    packageDir,
    packageName: packageJson.name,
    bibitFeature: packageJson.bibitFeature,
    exportTarget,
    manifest,
  }
}

export async function discoverFeatures(rootDir) {
  const rootPackage = await readJson(resolve(rootDir, 'package.json'), 'root package.json')
  const directories = new Set()
  for (const pattern of workspacePatterns(rootPackage)) {
    if (typeof pattern !== 'string') {
      throw new Error('workspace patterns must be strings')
    }
    for (const directory of await expandWorkspacePattern(rootDir, pattern)) {
      directories.add(directory)
    }
  }

  const features = []
  for (const directory of [...directories].sort()) {
    const feature = await readFeaturePackage(directory)
    if (feature) features.push(feature)
  }
  return features.sort(
    (left, right) =>
      compareText(left.packageName, right.packageName) ||
      compareText(left.packageDir, right.packageDir)
  )
}
