import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('SDK vendor delivery is complete, immutable and detects damaged archives', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'bibit-sdk-vendor-'))
  const output = join(scratch, 'sdk')
  const run = (...args) => execFileSync(process.execPath, [
    fileURLToPath(new URL('./feature-sdk-vendor.mjs', import.meta.url)), ...args,
  ], { encoding: 'utf8', stdio: 'pipe' })
  try {
    const failedOutput = join(scratch, 'failed')
    assert.throws(() => execFileSync(process.execPath, [
      fileURLToPath(new URL('./feature-sdk-vendor.mjs', import.meta.url)),
      'pack', failedOutput, '--allow-dirty',
    ], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, YARN_ENABLE_SCRIPTS: 'invalid' },
    }), /Couldn't parse "invalid" as a boolean/)
    assert.equal(existsSync(failedOutput), false)
    run('pack', output, '--allow-dirty')
    run('verify', output)
    const manifest = JSON.parse(readFileSync(join(output, 'sdk-vendor.json'), 'utf8'))
    assert.equal(manifest.packages.length, 5)
    assert.match(manifest.source.commit, /^[a-f0-9]{40}$/)
    assert.throws(() => run('pack', output, '--allow-dirty'), /EEXIST/)
    run('verify', output)
    const manifestPath = join(output, 'sdk-vendor.json')
    const originalManifest = readFileSync(manifestPath, 'utf8')
    const incomplete = { ...manifest, packages: manifest.packages.slice(1) }
    writeFileSync(manifestPath, JSON.stringify(incomplete))
    assert.throws(() => run('verify', output), /不完整/)
    const dependency = manifest.packages.find((entry) => entry.name === '@bibit/feature-sdk')
    dependency.dependencies['@bibit/feature-contracts'] = '99.0.0'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    assert.throws(() => run('verify', output), /依赖不匹配/)
    dependency.dependencies['@bibit/feature-contracts'] = manifest.packages[0].version
    writeFileSync(manifestPath, originalManifest)
    const archive = join(output, manifest.packages[0].file)
    writeFileSync(archive, 'damaged archive')
    assert.throws(() => run('verify', output), /校验失败/)
    manifest.packages[0].file = '../outside.tgz'
    writeFileSync(join(output, 'sdk-vendor.json'), JSON.stringify(manifest))
    assert.throws(() => run('verify', output), /文件名/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
