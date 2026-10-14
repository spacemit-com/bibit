import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('release carriers map Beta versions, reject drift and prevent downgrades', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bibit-version-'))
  try {
    for (const dir of ['scripts', 'debian', 'src-tauri', 'web-app']) mkdirSync(path.join(root, dir))
    copyFileSync(new URL('./bump-version.mjs', import.meta.url), path.join(root, 'scripts/bump-version.mjs'))
    writeFileSync(path.join(root, 'scripts/linux-deb-config.test.mjs'), '')
    for (const file of ['package.json', 'web-app/package.json', 'src-tauri/tauri.conf.json']) {
      writeFileSync(path.join(root, file), '{"version": "1.0.0-beta.1"}\n')
    }
    writeFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'version = "1.0.0-beta.1"\n')
    writeFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'name = "BiBit"\nversion = "1.0.0-beta.1"\n')
    writeFileSync(path.join(root, 'debian/changelog'), 'bibit (1.0.0~beta1) stable; urgency=medium\n\n  * Initial release.\n\n -- BiBit Team <bianbu@spacemit.com>  Wed, 14 Oct 2026 15:00:00 +0800\n')
    const run = (arg) => spawnSync(process.execPath, ['scripts/bump-version.mjs', arg], { cwd: root, encoding: 'utf8' })
    assert.equal(run('--check').status, 0)
    assert.equal(run('1.0.0-beta.2').status, 0)
    assert.match(readFileSync(path.join(root, 'debian/changelog'), 'utf8'), /^bibit \(1\.0\.0~beta2\)/)
    assert.equal(run('--check').status, 0)
    assert.equal(run('1.0.0-beta.1').status, 1)
    assert.equal(run('1.0.0').status, 0)
    assert.equal(run('--check').status, 0)
    assert.equal(run('1.0.0-beta.2').status, 1)
    assert.equal(run('invalid').status, 2)
    writeFileSync(path.join(root, 'web-app/package.json'), '{"version": "9.0.0"}\n')
    assert.equal(run('--check').status, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
