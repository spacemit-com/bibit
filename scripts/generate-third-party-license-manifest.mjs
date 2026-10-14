import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function licenseOf(pkg) {
  const value = pkg.license ?? pkg.licenses
  if (typeof value === 'string') return value
  if (value && typeof value.type === 'string') return value.type
  if (Array.isArray(value)) {
    return value
      .map((license) => (typeof license === 'string' ? license : license?.type))
      .filter(Boolean)
      .join(' OR ') || 'UNKNOWN'
  }
  return 'UNKNOWN'
}

function resolvePackage(name, fromDirectory) {
  for (let directory = fromDirectory; directory.startsWith(root); directory = path.dirname(directory)) {
    const packageJson = path.join(directory, 'node_modules', name, 'package.json')
    if (existsSync(packageJson)) return realpathSync(packageJson)
    if (directory === root) break
  }
  throw new Error(`Installed package not found: ${name} from ${fromDirectory}`)
}

function javascriptPackages() {
  const packages = new Map()
  const visited = new Set()

  const visitManifest = (packageJson, include) => {
    if (visited.has(packageJson)) return
    visited.add(packageJson)
    const pkg = JSON.parse(readFileSync(packageJson, 'utf8'))
    if (include && pkg.name && pkg.version) {
      packages.set(`${pkg.name}@${pkg.version}`, {
        name: pkg.name,
        version: pkg.version,
        license: licenseOf(pkg),
      })
    }
    const directory = path.dirname(packageJson)
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const dependency = resolvePackage(name, directory)
      visitManifest(dependency, dependency.includes(`${path.sep}node_modules${path.sep}`))
    }
    for (const name of Object.keys(pkg.optionalDependencies ?? {})) {
      try {
        const dependency = resolvePackage(name, directory)
        visitManifest(dependency, dependency.includes(`${path.sep}node_modules${path.sep}`))
      } catch {}
    }
  }

  visitManifest(path.join(root, 'web-app/package.json'), false)
  return [...packages.values()]
}

function rustPackages() {
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      [
        'metadata',
        '--locked',
        '--format-version',
        '1',
        '--filter-platform',
        'riscv64gc-unknown-linux-gnu',
        '--manifest-path',
        'Cargo.toml',
      ],
      {
        cwd: path.join(root, 'src-tauri'),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }
    )
  )
  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]))
  const nodesById = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
  const workspacePackages = new Set(metadata.workspace_members)
  const included = new Set()
  const visit = (id) => {
    if (included.has(id)) return
    included.add(id)
    for (const dependency of nodesById.get(id)?.deps ?? []) {
      if (dependency.dep_kinds.some(({ kind }) => kind !== 'dev')) visit(dependency.pkg)
    }
  }
  for (const id of workspacePackages) visit(id)

  return [...included]
    .map((id) => packagesById.get(id))
    .filter(
      ({ id, source, manifest_path }) =>
        !workspacePackages.has(id) &&
        (source || manifest_path.startsWith(path.join(root, 'vendor')))
    )
    .map(({ name, version, license }) => ({
      name,
      version,
      license: license || 'UNKNOWN',
    }))
}

const byNameAndVersion = (a, b) =>
  a.name.localeCompare(b.name) || a.version.localeCompare(b.version)

const manifest = {
  schemaVersion: 1,
  javascript: javascriptPackages().sort(byNameAndVersion),
  rust: rustPackages().sort(byNameAndVersion),
}

writeFileSync(
  path.join(root, 'LICENSES/THIRD-PARTY.json'),
  `${JSON.stringify(manifest, null, 2)}\n`
)
