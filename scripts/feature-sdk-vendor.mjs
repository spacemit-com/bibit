import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tar from 'tar'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const names = ['contracts', 'sdk', 'plugin-sdk', 'ui', 'dev-host']
  .map((name) => `@bibit/feature-${name}`)
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const filename = ({ name, version }) => `${name.replace('@', '').replace('/', '-')}-${version}.tgz`
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

function validatePackages(packages) {
  if (!Array.isArray(packages) || packages.length !== names.length ||
      new Set(packages.map((entry) => entry.name)).size !== names.length) {
    throw new Error('SDK 包集合不完整或重复')
  }
  for (const entry of packages) {
    if (!names.includes(entry.name) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.version)) {
      throw new Error('SDK 包名或版本不合法')
    }
    for (const [dependency, version] of Object.entries(entry.dependencies ?? {})) {
      if (dependency.startsWith('@bibit/') &&
          packages.find((candidate) => candidate.name === dependency)?.version !== version) {
        throw new Error(`${entry.name} 的依赖不匹配：${dependency}@${version}`)
      }
    }
  }
}

function archiveMetadata(path) {
  const records = []
  tar.t({
    file: path,
    sync: true,
    onentry(entry) {
      if (entry.path !== 'package/package.json') return
      let content = ''
      entry.on('data', (chunk) => { content += chunk.toString('utf8') })
      entry.on('end', () => { records.push(JSON.parse(content)) })
    },
  })
  if (records.length !== 1) throw new Error('SDK 压缩包缺少唯一的 package.json')
  return records[0]
}

function verify(directory) {
  const manifest = readJson(join(directory, 'sdk-vendor.json'))
  if (manifest.format !== 1) throw new Error('不支持的 SDK 清单格式')
  validatePackages(manifest.packages)
  const metadata = []
  for (const entry of manifest.packages) {
    if (entry.file !== filename(entry)) throw new Error('SDK 压缩包文件名不合法')
    const archive = join(directory, entry.file)
    if (digest(archive) !== entry.sha256) throw new Error(`${entry.file} 校验失败`)
    const actual = archiveMetadata(archive)
    if (actual.name !== entry.name || actual.version !== entry.version ||
        JSON.stringify(actual.dependencies ?? {}) !== JSON.stringify(entry.dependencies)) {
      throw new Error(`${entry.file} 包内容与清单不一致`)
    }
    metadata.push(actual)
  }
  validatePackages(metadata)
  return manifest
}

function pack(directory, allowDirty) {
  const packages = names.map((name) => readJson(join(root, 'packages', name.slice(7), 'package.json')))
  validatePackages(packages)
  const status = git('status', '--porcelain', '--untracked-files=all')
  if (status && !allowDirty) throw new Error('工作树未提交；开发快照请显式使用 --allow-dirty')
  const source = { commit: git('rev-parse', 'HEAD'), dirty: Boolean(status) }
  mkdirSync(directory)
  try {
    const records = packages.map((metadata) => {
      const file = filename(metadata)
      execFileSync(process.execPath, [
        join(root, '.yarn/releases/yarn-4.5.3.cjs'), 'pack', '--out', join(directory, file),
      ], { cwd: join(root, 'packages', metadata.name.slice(7)), stdio: 'pipe' })
      return {
        name: metadata.name,
        version: metadata.version,
        file,
        sha256: digest(join(directory, file)),
        dependencies: metadata.dependencies ?? {},
      }
    })
    writeFileSync(join(directory, 'sdk-vendor.json'), JSON.stringify({ format: 1, source, packages: records }, null, 2) + '\n')
    verify(directory)
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

const [command, output, ...flags] = process.argv.slice(2)
try {
  if (!output || !['pack', 'verify'].includes(command) ||
      flags.some((flag) => flag !== '--allow-dirty') ||
      (command === 'verify' && flags.length)) {
    throw new Error('用法：feature-sdk-vendor.mjs pack <新目录> [--allow-dirty] | verify <目录>')
  }
  const directory = resolve(output)
  if (command === 'pack') pack(directory, flags.includes('--allow-dirty'))
  else verify(directory)
  console.log(`SDK ${command} 完成：${directory}`)
} catch (error) {
  console.error(error.message)
  if (error.stdout?.length) console.error(error.stdout.toString().trim())
  if (error.stderr?.length) console.error(error.stderr.toString().trim())
  process.exitCode = 1
}
